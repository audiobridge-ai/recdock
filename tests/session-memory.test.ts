import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { accountEntry, cachedDevice, injectAccountKeys, publicDevices, retainKey, withKeyHistory } from '../server/session-memory.ts';
import { emptyCredentials } from '../src/auth/credentials.ts';
import type { CloudSession } from '../server/cloud-client.ts';
import type { VaultData } from '../server/vault.ts';
function fixture() {
  const auth: CloudSession = { account: { accountId: 'account', email: 'a@example.com' }, devices: [{ serialNumber: 'SN1', name: 'Renamed', firmware: 'v1' }], userToken: 'test-token', userBaseUrl: 'https://api.plaud.ai' };
  const data: VaultData = { version: 1, accounts: {} }, account = accountEntry(data, auth);
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const c = { ...emptyCredentials(), accountId: 'account', serialNumber: 'SN1', portVersion: 20 };
  c.rsa = { publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), snSignature: 'AAAA', alternateCommand: false };
  account.devices.SN1 = { device: { ...auth.devices[0] }, credentials: c, verifiedPortVersion: 20, verifiedFirmware: 'v1', verifiedAt: 123 };
  return { auth, data, account, c };
}
test('只复用匹配账号、SN、固件和协议的完整材料，支持离线无需重复gen_key', () => {
  const f = fixture(); retainKey(f.account, f.c.rsa, 1);
  assert.equal(cachedDevice(f.auth, f.account, 'SN1')?.source, 'cache');
  assert.equal(cachedDevice(f.auth, f.account, 'SN1')?.portSource, 'verified');
  assert.equal(cachedDevice(f.auth, f.account, 'SN1', 10), undefined);
  assert.equal(cachedDevice(f.auth, f.account, 'OTHER'), undefined);
  f.auth.account.accountId = 'other'; assert.equal(cachedDevice(f.auth, f.account, 'SN1'), undefined);
  f.auth.account.accountId = 'account'; f.auth.devices[0].firmware = 'v2';
  assert.equal(cachedDevice(f.auth, f.account, 'SN1'), undefined);
  assert.equal(publicDevices(f.auth, f.account)[0].portVersion, undefined);
});
test('RSA版本去重并保留旧版本，不接受不匹配的公私钥', () => {
  const f = fixture(); retainKey(f.account, f.c.rsa, 1); retainKey(f.account, f.c.rsa, 2);
  assert.equal(f.account.rsaKeys.length, 1);
  const g = fixture(); retainKey(f.account, g.c.rsa, 3); injectAccountKeys(f.auth, f.account);
  assert.equal(f.auth.rsaCache?.privateKeyPem, g.c.rsa.privateKeyPem);
  assert.deepEqual(withKeyHistory(g.c, f.account).rsa.privateKeyHistory, [f.c.rsa.privateKeyPem]);
  assert.throws(() => retainKey(f.account, { ...g.c.rsa, publicKeyPem: f.c.rsa.publicKeyPem }, 4));
  assert.equal(f.account.rsaKeys.length, 2);
});
