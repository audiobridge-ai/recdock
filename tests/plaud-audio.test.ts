import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createCipheriv, generateKeyPairSync, publicEncrypt } from 'node:crypto';
import { parsePlaudHeader, decryptPlaudRecording } from '../src/audio/plaud.ts';
import { concat, utf8, view } from '../src/protocol/bytes.ts';

const makeRsa = () => generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const pair = makeRsa(), wrongPair = makeRsa();
const contentKey = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) & 255);
const nonce = Uint8Array.from({ length: 12 }, (_, index) => index + 23);
const plaintext = Uint8Array.from({ length: 253 }, (_, index) => (index * 11 + 17) & 255);

function nativeChaCha(bytes: Uint8Array, segmentSize: number, key = contentKey): Uint8Array {
  const output: Uint8Array[] = [], width = segmentSize || bytes.length;
  // OpenSSL的16字节IV布局对应counter32LE(0)||nonce96，在本测试范围内无counter溢出。
  const iv = concat(new Uint8Array(4), nonce);
  for (let offset = 0; offset < bytes.length; offset += width) {
    const cipher = createCipheriv('chacha20', key, iv);
    output.push(Buffer.concat([cipher.update(bytes.subarray(offset, offset + width)), cipher.final()]));
  }
  return concat(...output);
}
function fixture(segmentSize = 80, options: { cipher?: Uint8Array; fileType?: number; channels?: number; plaintext?: Uint8Array } = {}) {
  const data = options.plaintext ?? plaintext, header = new Uint8Array(512), fields = view(header);
  header.set(utf8('PLAUD.AI')); fields.setUint16(8, 1, true); fields.setUint16(10, 512, true);
  fields.setUint32(12, 0x12345678, true); // 未知头CRC不是本测试伪造的“校验通过”标志。
  fields.setUint16(48, options.fileType ?? 5, true); fields.setUint16(50, options.channels ?? 1, true);
  fields.setUint16(52, 1, true); fields.setUint32(54, 7, true);
  fields.setUint32(128, 42, true); header.set(nonce, 132); fields.setUint32(144, segmentSize, true);
  const keyCipher = options.cipher ?? publicEncrypt({ key: pair.publicKey, padding: constants.RSA_PKCS1_PADDING }, contentKey);
  assert.equal(keyCipher.length, 256); header.set(keyCipher, 256);
  return concat(header, nativeChaCha(data, segmentSize));
}

test('PLAUD头按APK固定LE偏移解析，版本1/512头，拒绝暴露userid字段', () => {
  const bytes = fixture(), header = parsePlaudHeader(bytes)!;
  assert.equal(header.version, 1); assert.equal(header.headerSize, 512);
  assert.equal(header.fileType, 5); assert.equal(header.channels, 1); assert.equal(header.encryptType, 1);
  assert.equal(header.durationMs, 7000); assert.equal(header.segmentSize, 80); assert.equal(header.counter, 42);
  assert.deepEqual(header.nonce, nonce); assert.equal(header.keyCipher.length, 256);
  assert.equal('userId' in header, false); assert.equal('crcValidated' in header, false);
  const oldNonceByte = header.nonce[0], oldCipherByte = header.keyCipher[0];
  bytes[132] ^= 1; bytes[256] ^= 1;
  assert.equal(header.nonce[0], oldNonceByte); assert.equal(header.keyCipher[0], oldCipherByte);
});

test('不匹配magic返回undefined，匹配后短头、空正文、未知版本或头长都明确报错', () => {
  assert.equal(parsePlaudHeader(new Uint8Array()), undefined);
  assert.equal(parsePlaudHeader(utf8('OggSnot-a-plaud-recording')), undefined);
  for (const length of [8, 9, 31, 255, 511]) {
    const bytes = new Uint8Array(length); bytes.set(utf8('PLAUD.AI'));
    assert.throws(() => parsePlaudHeader(bytes), /文件头不完整/);
  }
  const valid = fixture();
  assert.throws(() => parsePlaudHeader(valid.slice(0, 512)), /没有音频正文/);
  for (const version of [0, 2, 65535]) {
    const bytes = valid.slice(); view(bytes).setUint16(8, version, true);
    assert.throws(() => parsePlaudHeader(bytes), /版本/);
  }
  const length = valid.slice(); view(length).setUint16(10, 32, true);
  assert.throws(() => parsePlaudHeader(length), /文件头长度/);
  const channels = valid.slice(); view(channels).setUint16(50, 0, true);
  assert.throws(() => parsePlaudHeader(channels), /声道数/);
});

test('Node原生RSA与ChaCha20分段80字节fixture互通，末段不足80也不截断', async () => {
  const bytes = fixture(80), original = bytes.slice();
  const result = await decryptPlaudRecording(bytes, pair.privateKey);
  assert.deepEqual(result.data, plaintext); assert.equal(result.data.length, 253);
  assert.equal(result.channels, 1); assert.equal(result.fileType, 5); assert.equal(result.isOggAudio, false);
  assert.equal(result.notice, undefined); assert.deepEqual(bytes, original);
  assert.notDeepEqual(nativeChaCha(plaintext, 80).slice(80), nativeChaCha(plaintext, 0).slice(80), '分段和连续流不能混用');
});

test('连续ChaCha20跨64字节块互通，遵循APK忽略header counter且保留多声道元信息', async () => {
  const bytes = fixture(0, { fileType: 1, channels: 2 }), original = bytes.slice();
  const result = await decryptPlaudRecording(bytes, pair.privateKey);
  assert.deepEqual(result.data, plaintext); assert.equal(result.channels, 2); assert.equal(result.fileType, 1); assert.equal(result.isOggAudio, true);
  assert.deepEqual(bytes, original);
});

test('错误或缺少私钥时拒绝解密，错误消息不含私钥、密钥或第三方异常', async () => {
  const bytes = fixture();
  for (const key of [wrongPair.privateKey, 'PRIVATE-KEY-DO-NOT-LOG', undefined, '   ']) {
    await assert.rejects(decryptPlaudRecording(bytes, key), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, /RSA私钥|录音内容密钥/);
      assert.equal(error.message.includes('PRIVATE-KEY-DO-NOT-LOG'), false);
      assert.equal(error.message.includes('BEGIN PRIVATE KEY'), false);
      assert.equal(error.message.includes(Buffer.from(contentKey).toString('hex')), false);
      assert.equal('cause' in error, false);
      return true;
    });
  }
});

test('RSA解出的内容密钥必须精确32字节，未知encryptType不盲目解密', async () => {
  const wrongSize = publicEncrypt({ key: pair.publicKey, padding: constants.RSA_PKCS1_PADDING }, new Uint8Array(31).fill(9));
  await assert.rejects(decryptPlaudRecording(fixture(80, { cipher: wrongSize }), pair.privateKey), /录音内容密钥/);
  for (const type of [0, 2, 65535]) {
    const bytes = fixture(); view(bytes).setUint16(52, type, true);
    assert.equal(parsePlaudHeader(bytes)?.encryptType, type);
    await assert.rejects(decryptPlaudRecording(bytes, pair.privateKey), /加密类型/);
  }
  await assert.rejects(decryptPlaudRecording(utf8('not-a-plaud-recording'), pair.privateKey), /文件头/);
});

test('仅精确厂商异常标记允许末32字节key兼容，且返回明确notice', async () => {
  const cipher = new Uint8Array(256).fill(0x79); cipher[0] = 0; cipher[1] = 2; cipher[223] = 0; cipher.set(contentKey, 224);
  const bytes = fixture(80, { cipher });
  for (const key of [undefined, wrongPair.privateKey]) {
    const result = await decryptPlaudRecording(bytes, key);
    assert.deepEqual(result.data, plaintext); assert.match(result.notice!, /官方客户端.*固件.*兼容/);
  }
  for (const offset of [0, 1, 223]) {
    const invalid = cipher.slice(); invalid[offset] ^= 1;
    await assert.rejects(decryptPlaudRecording(fixture(80, { cipher: invalid })), /RSA私钥/);
  }
});
