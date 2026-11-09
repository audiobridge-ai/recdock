import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { concat, hex, request, unhex, view } from '../src/protocol/bytes.ts';
import { decodeBattery, decodeHandshake, decodeState, decodeStorage, formatBytes } from '../src/protocol/status.ts';
import { eccTokenHandshake, fragments, legacyHandshake } from '../src/auth/handshake.ts';
import { EncryptedSession, ReplayError } from '../src/auth/session.ts';
import { emptyCredentials, importCredentials, validateCredentials } from '../src/auth/credentials.ts';
import { decodeAdvertisement } from '../src/protocol/advertisement.ts';

test('固定请求和传统握手字节，含不同版本的 token 长度与第二阶段', () => {
  assert.equal(hex(request(3)), '010300');
  assert.equal(hex(legacyHandshake('AB', 2)), '010100020041423030303030303030303030303030');
  assert.equal(hex(legacyHandshake('AB', 3)), '01010002000041423030303030303030303030303030');
  assert.equal(legacyHandshake('x'.repeat(40), 9).length, 38);
  assert.equal(legacyHandshake('abc', 9, true)[5], 1);
  const extra = legacyHandshake('x', 9, true, 'r', 's');
  assert.equal(hex(extra.slice(38)), '72000000000000000173');
  assert.equal(hex(eccTokenHandshake('A').slice(0, 8)), '0101000201014130');
});
test('短状态响应保留缺失字段，完整响应按偏移解析', () => {
  const short = unhex('0103000310000001');
  assert.equal(decodeState(short).stateCode, 4099);
  assert.equal(decodeState(short).privacy, true);
  assert.equal(decodeState(short).usb, undefined);
  assert.equal(decodeState(short).keyStateCode, undefined);
  assert.throws(() => decodeState(short.slice(0, 7)));
  const full = unhex('0103000000000000010102785634120102030405');
  const d = decodeState(full);
  assert.equal(d.sessionId, 0x12345678); assert.equal(d.scene, 2);
  assert.equal(d.esim, 5); assert.equal(d.signal, 4); assert.equal(d.http, 3);
  assert.equal(decodeHandshake(unhex('01010000')).portVersion, undefined);
});
test('电量值及无损 uint64 容量', () => {
  assert.deepEqual(decodeBattery(unhex('0109000164')), { charging: true, level: 100 });
  assert.throws(() => decodeBattery(unhex('01090000ff')));
  const storage = unhex('01060001000000000020000200000000002000');
  assert.equal(decodeStorage(storage).free, 9007199254740993n);
  assert.equal(decodeStorage(storage).total, 9007199254740994n);
  assert.equal(decodeStorage(storage).duration, undefined);
  assert.equal(formatBytes(0n), '0 B'); assert.equal(formatBytes(1073741824n), '1.00 GiB');
  assert.throws(() => decodeStorage(storage.slice(0, 18)));
});
test('导入登录响应只使用账号 ID，拒绝将 JWT 用作 BLE token', () => {
  const c = importCredentials({ data: { access_token: 'secret', user_id: 'owner-id' }, portVersion: 9 });
  assert.equal(c.accountId, 'owner-id'); assert.equal(c.bindingToken, '');
  assert.equal(JSON.stringify(c).includes('secret'), false);
  validateCredentials(c);
  assert.throws(() => importCredentials({ access_token: 'only-login' }), /只有云端/);
  assert.throws(() => validateCredentials({ ...c, bindingToken: 'eyJhbGci.foo.bar' }), /access_token/);
  assert.throws(() => validateCredentials(emptyCredentials()), /portVersion/);
});
test('RSA 分片为 100 字节载荷，索引从 0 开始', () => {
  const parts = fragments(0xfe12, new Uint8Array(201));
  assert.deepEqual(Array.from(parts[0].slice(0, 4)), [0x12, 0xfe, 3, 0]);
  assert.equal(parts[1].length, 104); assert.equal(parts[2].length, 5);
  assert.equal(parts[2][3], 2);
});
test('会话封装与 Node 原生 ChaCha20-Poly1305 互通，首个发送序号为 2', () => {
  const m = Uint8Array.from({ length: 56 }, (_, i) => i);
  const codec = new EncryptedSession(m), encoded = codec.encode(request(3));
  const decipher = createDecipheriv('chacha20-poly1305', m.slice(0, 32), m.slice(32, 44), { authTagLength: 16 });
  decipher.setAAD(m.slice(44), { plaintextLength: encoded.length - 16 }); decipher.setAuthTag(encoded.slice(-16));
  const p = Buffer.concat([decipher.update(encoded.slice(0, -16)), decipher.final()]);
  assert.equal(p.readInt32LE(0), 2); assert.equal(hex(p.subarray(4)), '010300');
  const seq = new Uint8Array(4); view(seq).setInt32(0, 7, true);
  const native = createCipheriv('chacha20-poly1305', m.slice(0, 32), m.slice(32, 44), { authTagLength: 16 });
  native.setAAD(m.slice(44), { plaintextLength: 7 });
  const wire = concat(native.update(concat(seq, request(6))), native.final(), native.getAuthTag());
  assert.equal(hex(codec.decode(wire)), '010600');
  assert.throws(() => codec.decode(wire), ReplayError);
  const bad = wire.slice(); bad[0] ^= 1; assert.throws(() => codec.decode(bad));
  codec.dispose(); assert.throws(() => codec.encode(request(3)), /会话已结束/);
});
test('Note 紧凑广播按 APK 固定偏移读取端口，不按型号假定', () => {
  const b = new Uint8Array(22);
  b.set([2, 0x78, 0x03, 4, 0x56, 1, 0, 0, 8, 0x88, 0x80, 0x01, 0x23, 0x45, 0x67, 0x89, 0x00]);
  b.set([30, 0], 18);
  const a = decodeAdvertisement(b);
  assert.equal(a?.project, 888); assert.equal(a?.portVersion, 30);
  assert.equal(a?.serialNumber, '8880012345678900');
  assert.equal(decodeAdvertisement(b.slice(0, 10)), undefined);
});
