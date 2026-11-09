import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createCipheriv, createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, publicEncrypt, sign, verify } from 'node:crypto';
import { authenticate, fragments } from '../src/auth/handshake.ts';
import { emptyCredentials } from '../src/auth/credentials.ts';
import { FrameInbox } from '../src/ble/inbox.ts';
import { concat, feCommand, hex, le16, request, unhex, utf8, view } from '../src/protocol/bytes.ts';

const material = Uint8Array.from({ length: 56 }, (_, i) => i + 1);
function encrypt(p: Uint8Array, m: Uint8Array = material) {
  const c = createCipheriv('chacha20-poly1305', m.slice(0, 32), m.slice(32, 44), { authTagLength: 16 });
  c.setAAD(m.slice(44), { plaintextLength: p.length }); return concat(c.update(p), c.final(), c.getAuthTag());
}
function decrypt(p: Uint8Array, m: Uint8Array = material) {
  const c = createDecipheriv('chacha20-poly1305', m.slice(0, 32), m.slice(32, 44), { authTagLength: 16 });
  c.setAAD(m.slice(44), { plaintextLength: p.length - 16 }); c.setAuthTag(p.slice(-16)); return concat(c.update(p.slice(0, -16)), c.final());
}
test('传统两阶段握手等待第二阶段设备 ACK，不乐观完成', async () => {
  const c = { ...emptyCredentials(), portVersion: 9, accountId: 'owner' }, inbox = new FrameInbox();
  const sent: Uint8Array[] = [];
  const codec = await authenticate({ stage() {}, receive: (p, t) => inbox.next(p, t), send: async p => {
    sent.push(p);
    inbox.push(sent.length === 1 ? concat(unhex('010200'), utf8('888TEST'), Uint8Array.of(0)) : unhex('010100000900'));
  } }, c);
  assert.equal(sent.length, 2); assert.equal(sent[0][5], 0); assert.equal(sent[1][5], 1); codec.dispose(); inbox.close();
});
test('port 20：完整 RSA 分片、PKCS1 解密、标记校验与加密 token 握手', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const c = { ...emptyCredentials(), portVersion: 20, accountId: 'owner', serialNumber: '8880012345678900' };
  c.rsa = { alternateCommand: false, snSignature: Buffer.from(new Uint8Array(201)).toString('base64'), publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKeyPem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const inbox = new FrameInbox(), collected: Uint8Array[] = []; let encryptedHandshake = false;
  const codec = await authenticate({ stage() {}, receive: (p, t) => inbox.next(p, t), send: async p => {
    if (feCommand(p) === 0xfe10) {
      if (p[3] === p[2] - 1) inbox.push(le16(0xfe11)); return;
    }
    if (feCommand(p) === 0xfe12) {
      collected.push(p.slice(4));
      if (p[3] === p[2] - 1) {
        assert.equal(new TextDecoder().decode(concat(...collected)), c.rsa.publicKeyPem);
        const r = concat(material, encrypt(utf8('PLAUD.AI')));
        const cipher = publicEncrypt({ key: rsa.publicKey, padding: constants.RSA_PKCS1_PADDING }, r);
        // 按逆序接收，含重复分片。
        const parts = fragments(0xfe12, cipher).reverse();
        inbox.push(parts[0]); for (const part of parts) inbox.push(part);
      }
      return;
    }
    const plain = decrypt(p);
    assert.equal(view(plain).getInt32(0, true), 2);
    assert.equal(hex(plain.slice(4, 10)), '010100020000'); encryptedHandshake = true;
    const seq = new Uint8Array(4); view(seq).setInt32(0, 1, true);
    inbox.push(encrypt(concat(seq, unhex('010100001400'))));
  } }, c);
  assert.equal(encryptedHandshake, true); assert.equal(hex(decrypt(codec.encode(request(3))).slice(4)), '010300'); codec.dispose(); inbox.close();
});

test('port20设备复用公钥直接返回FE12时不等待FE11、不重复上传公钥，验证RSA后再发加密token', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const c = { ...emptyCredentials(), portVersion: 20, accountId: 'owner', serialNumber: '888FIXTURE' };
  const signedBytes = Uint8Array.from({ length: 201 }, (_, i) => i % 256);
  c.rsa = { alternateCommand: false, snSignature: Buffer.from(signedBytes).toString('base64'), publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKeyPem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const encryptedMaterial = publicEncrypt({ key: rsa.publicKey, padding: constants.RSA_PKCS1_PADDING }, concat(material, encrypt(utf8('PLAUD.AI'))));
  const inbox = new FrameInbox(), signatures: Uint8Array[] = [], stages: string[] = [];
  let tokenSent = false;
  const codec = await authenticate({ stage: s => stages.push(s), receive: (p, t) => inbox.next(p, t), send: async p => {
    if (feCommand(p) === 0xfe10) {
      signatures.push(p.slice(4));
      if (p[3] === p[2] - 1) {
        // 独立编码设备分片，先收到非零索引且有重复帧；设备从不发送 FE11。
        for (const i of [2, 2, 0, 1]) inbox.push(concat(le16(0xfe12), Uint8Array.of(3, i), encryptedMaterial.slice(i * 100, (i + 1) * 100)));
      }
      return;
    }
    assert.notEqual(feCommand(p), 0xfe12, '复用设备已有公钥时不能额外上传新公钥');
    const plain = decrypt(p);
    assert.equal(view(plain).getInt32(0, true), 2); assert.equal(hex(plain.slice(4, 10)), '010100020000');
    tokenSent = true;
    const seq = new Uint8Array(4); view(seq).setInt32(0, 1, true);
    inbox.push(encrypt(concat(seq, unhex('010100001400'))));
  } }, c);
  assert.deepEqual(concat(...signatures), signedBytes); assert.equal(tokenSent, true);
  assert.ok(stages.some(s => s.includes('直接返回 FE12')));
  codec.dispose(); inbox.close();
});

test('直接FE12路径仍验证PLAUD.AI标记，失败时不发送BLE token', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const c = { ...emptyCredentials(), portVersion: 20, accountId: 'owner', serialNumber: '888FIXTURE' };
  c.rsa = { alternateCommand: false, snSignature: 'AQID', publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKeyPem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const encryptedMaterial = publicEncrypt({ key: rsa.publicKey, padding: constants.RSA_PKCS1_PADDING }, concat(material, encrypt(utf8('WRONG-ID'))));
  const inbox = new FrameInbox();
  await assert.rejects(authenticate({ stage() {}, receive: (p, t) => inbox.next(p, t), send: async p => {
    assert.equal(feCommand(p), 0xfe10, '验证失败前只能发送SN签名');
    for (let i = 0; i < 3; i++) inbox.push(concat(le16(0xfe12), Uint8Array.of(3, i), encryptedMaterial.slice(i * 100, (i + 1) * 100)));
  } }, c), /RSA 会话校验失败/);
  inbox.close();
});

test('签名阶段超时指出FE11或FE12且不自动重试或切FE20', async () => {
  const c = { ...emptyCredentials(), portVersion: 20, accountId: 'owner', serialNumber: '888FIXTURE' };
  c.rsa = { alternateCommand: false, snSignature: 'AQID', publicKeyPem: 'public-fixture', privateKeyPem: 'private-fixture' };
  const sent: Uint8Array[] = [];
  await assert.rejects(authenticate({ stage() {}, send: async p => { sent.push(p); }, receive: async () => { throw new Error('设备响应超时'); } }, c), /等待 FE11 确认或 FE12 会话材料超时/);
  assert.equal(sent.length, 1); assert.equal(feCommand(sent[0]), 0xfe10);
});
test('port 30：原生 ECDSA 验证双方签名，原生 ECDH/HKDF 与会话派生互通', async () => {
  const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const user = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const devJwk = device.publicKey.export({ format: 'jwk' }), userJwk = user.privateKey.export({ format: 'jwk' });
  const devicePub = concat(Uint8Array.of(4), Buffer.from(devJwk.x!, 'base64url'), Buffer.from(devJwk.y!, 'base64url'));
  const c = { ...emptyCredentials(), portVersion: 30, serialNumber: '8880012345678900', accountId: 'owner' };
  c.ecc = { devicePublicKeyHex: hex(devicePub), userPrivateKeyHex: Buffer.from(userJwk.d!, 'base64url').toString('hex') };
  const ecdh = createECDH('prime256v1'), ephDev = ecdh.generateKeys(), nonceDev = new Uint8Array(16).fill(7);
  const devSig = sign('sha256', concat(nonceDev, utf8(c.serialNumber), ephDev), { key: device.privateKey, dsaEncoding: 'ieee-p1363' });
  const inbox = new FrameInbox(); inbox.push(concat(le16(0xfe30), Uint8Array.of(2), nonceDev, devSig, ephDev));
  let derived: Uint8Array | undefined, tokenChecked = false;
  const codec = await authenticate({ stage() {}, receive: (p, t) => inbox.next(p, t), send: async p => {
    if (feCommand(p) === 0xfe31) {
      assert.equal(p.length, 147);
      const nonceApp = p.slice(2, 18), sig = p.slice(18, 82), ephApp = p.slice(82);
      assert.equal(verify('sha256', concat(nonceDev, nonceApp, utf8(c.serialNumber), ephDev, ephApp), { key: user.publicKey, dsaEncoding: 'ieee-p1363' }, sig), true);
      const secret = ecdh.computeSecret(ephApp);
      derived = new Uint8Array(hkdfSync('sha256', secret, concat(nonceDev, nonceApp), utf8('plaud-v2:ble-session'), 56));
      inbox.push(unhex('34fe00')); return;
    }
    assert.ok(derived);
    const plain = decrypt(p, derived);
    assert.equal(view(plain).getInt32(0, true), 2);
    assert.equal(hex(plain.slice(4, 10)), '010100020101'); assert.equal(plain.length, 42); tokenChecked = true;
  } }, c);
  assert.equal(tokenChecked, true);
  const seq = new Uint8Array(4); view(seq).setInt32(0, 1, true);
  assert.equal(hex(codec.decode(encrypt(concat(seq, request(3)), derived!))), '010300'); codec.dispose(); inbox.close();
});
test('port 30 首次绑定模式明确停止，不伪造云签名', async () => {
  const c = { ...emptyCredentials(), portVersion: 30, accountId: 'owner', serialNumber: '888test', ecc: { devicePublicKeyHex: '04', userPrivateKeyHex: '01' } };
  const inbox = new FrameInbox(), challenge = new Uint8Array(148); challenge.set([0x30, 0xfe, 1]); inbox.push(challenge);
  await assert.rejects(authenticate({ stage() {}, receive: (p, t) => inbox.next(p, t), send: async () => assert.fail('不应发送') }, c), /绑定流程（mode=1）/);
  inbox.close();
});
