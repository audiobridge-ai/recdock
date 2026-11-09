import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createCipheriv, generateKeyPairSync, publicEncrypt } from 'node:crypto';
import { recoverRecording } from '../src/audio/recovery.ts';
import { playableRecording } from '../src/audio/ogg.ts';
import { concat, utf8, view } from '../src/protocol/bytes.ts';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const raw = new Uint8Array(160).fill(1); raw[0] = 0x48; raw[80] = 0x48;
function encryptedFile(channels = 1) {
  const key = Buffer.alloc(32, 7), nonce = Buffer.alloc(12, 9), header = new Uint8Array(512), fields = view(header);
  header.set(utf8('PLAUD.AI')); fields.setUint16(8, 1, true); fields.setUint16(10, 512, true);
  fields.setUint16(48, 5, true); fields.setUint16(50, channels, true); fields.setUint16(52, 1, true);
  fields.setUint32(144, 80, true); header.set(nonce, 132);
  header.set(publicEncrypt({ key: rsa.publicKey, padding: constants.RSA_PKCS1_PADDING }, key), 256);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < raw.length; offset += 80) {
    const cipher = createCipheriv('chacha20', key, concat(new Uint8Array(4), nonce));
    chunks.push(concat(cipher.update(raw.subarray(offset, offset + 80)), cipher.final()));
  }
  return concat(header, ...chunks);
}

test('PLAUD私有头和独立文件加密恢复后封装成Ogg，文件头优先于BLE音频猜测且原文件不变', async () => {
  const bytes = encryptedFile(), original = bytes.slice();
  const output = await recoverRecording(bytes, { sessionId: 123, privateKeyPem, channels: 2, isOggAudio: true });
  assert.equal(output.format, 'ogg'); assert.equal(output.filename, 'plaud-123.ogg');
  assert.equal(new TextDecoder().decode(output.data.subarray(0, 4)), 'OggS');
  assert.deepEqual(output.data.subarray(-raw.length), raw); assert.deepEqual(bytes, original);
});

test('缺少或错误账号RSA时保留完整加密原件，提示不泄露密钥', async () => {
  const bytes = encryptedFile();
  for (const key of [undefined, 'SECRET_PRIVATE_KEY_INVALID']) {
    const output = await recoverRecording(bytes, { sessionId: 123, privateKeyPem: key });
    assert.equal(output.format, 'raw'); assert.equal(output.data, bytes);
    assert.match(output.notice!, /RSA材料/); assert.doesNotMatch(output.notice!, /SECRET_PRIVATE_KEY|BEGIN/);
  }
});

test('Node Buffer输入也复制密钥字段，清理临时材料不能擦除原始文件', async () => {
  const bytes = Buffer.from(encryptedFile()), original = Buffer.from(bytes);
  const output = await recoverRecording(bytes, { sessionId: 123, privateKeyPem });
  assert.equal(output.format, 'ogg'); assert.deepEqual(bytes, original);
});

test('账号新密钥不能解密旧录音时可使用保留版本，原文件不变', async () => {
  const newer = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const bytes = encryptedFile(), original = bytes.slice();
  const output = await recoverRecording(bytes, { sessionId: 123, privateKeyPem: newer, privateKeyHistory: [privateKeyPem] });
  assert.equal(output.format, 'ogg'); assert.deepEqual(bytes, original);
});

test('解密后的多流格式不支持时仍保留原有加密封装，供原账号后续恢复', async () => {
  const bytes = encryptedFile(2), output = await recoverRecording(bytes, { sessionId: 123, privateKeyPem });
  assert.equal(output.format, 'raw'); assert.equal(output.data, bytes); assert.match(output.notice!, /保留原始加密文件/);
});

test('已有标准Ogg无需RSA仍可保存，截断PLAUD头不会伪装成音频', async () => {
  const ogg = playableRecording(raw, { sessionId: 123, channels: 1, isOggAudio: false });
  const output = await recoverRecording(ogg.data, { sessionId: 123 });
  assert.equal(output.format, 'ogg'); assert.equal(output.data, ogg.data);
  const broken = utf8('PLAUD.AI');
  const failure = await recoverRecording(broken, { sessionId: 123, privateKeyPem });
  assert.equal(failure.format, 'raw'); assert.equal(failure.data, broken);
});
