import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileKeyProvider, Vault, VaultError } from '../server/vault.ts';
import type { KeyProvider, VaultAccount } from '../server/vault.ts';

const ACCOUNT = 'fixture-account';
const SN = '888VAULTFIXTURE';
const PRIVATE = 'FIXTURE-PRIVATE-RSA-KEY';
const TOKEN = 'FIXTURE-SECRET-USER-TOKEN';
const account = (accountId = ACCOUNT): VaultAccount => ({
  account: { accountId, email: 'vault-fixture@example.com' },
  login: {
    userToken: TOKEN, userBaseUrl: 'https://api.plaud.ai', refreshToken: 'FIXTURE-REFRESH-TOKEN', utExpireAt: 1900000000,
    account: { accountId, email: 'vault-fixture@example.com' },
    workspaceToken: 'FIXTURE-SECRET-WORKSPACE-TOKEN', workspaceBaseUrl: 'https://api-us.plaud.ai', workspaceId: 'personal-fixture',
    devices: [{ serialNumber: SN, name: '测试设备', portVersion: 20 }],
    rsaCache: { publicKeyPem: 'FIXTURE-PUBLIC-KEY', privateKeyPem: PRIVATE, snSignature: 'c2lnbmF0dXJl', alternateCommand: false },
  },
  loginSavedAt: 1700000000000, loginValidUntil: 1700000300000,
  rsaKeys: [
    { fingerprint: 'first', publicKeyPem: 'FIXTURE-PUBLIC-KEY', privateKeyPem: PRIVATE, createdAt: 1700000000000 },
    { fingerprint: 'second', publicKeyPem: 'FIXTURE-PUBLIC-KEY-2', privateKeyPem: `${PRIVATE}-2`, createdAt: 1700000000001 },
  ],
  devices: {
    [SN]: {
      device: { serialNumber: SN, name: '测试设备', model: 'NOTE', portVersion: 20, firmware: '1.2.3' },
      credentials: {
        accountId, serialNumber: SN, bindingToken: '', portVersion: 20,
        rsa: { publicKeyPem: 'FIXTURE-PUBLIC-KEY-2', privateKeyPem: `${PRIVATE}-2`, privateKeyHistory: [PRIVATE], snSignature: 'c2lnbmF0dXJl', alternateCommand: false },
        ecc: { devicePublicKeyHex: '', userPrivateKeyHex: '' }, secondHandshake: { extra8: '', extraText: '' },
      },
      verifiedPortVersion: 20, verifiedFirmware: '1.2.3', preparedAt: 1700000000001, verifiedAt: 1700000000002,
    },
  },
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'plaud-vault-test-'));
  await chmod(directory, 0o700);
  const filePath = join(directory, 'vault-v1.json'), key = randomBytes(32);
  const keyProvider: KeyProvider = { getMasterKey: async () => key };
  const make = (provider = keyProvider) => new Vault({ filePath, keyProvider: provider });
  return { directory, filePath, key, make, cleanup: async () => { key.fill(0); await rm(directory, { recursive: true, force: true }); } };
}
async function populate(vault: Vault) {
  await vault.update(draft => { draft.accounts[ACCOUNT] = account(); draft.activeAccountId = ACCOUNT; });
}
async function code(promise: Promise<unknown>, expected: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof VaultError);
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes(PRIVATE));
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
}

test('空库与重启恢复保留账号、刷新令牌、全部RSA版本及准备材料', async () => {
  const f = await fixture();
  try {
    const initial = await f.make().load();
    assert.equal(initial.version, 1); assert.equal(Object.keys(initial.accounts).length, 0);
    await populate(f.make());
    const restored = await f.make().load();
    assert.equal(restored.activeAccountId, ACCOUNT);
    assert.deepEqual(restored.accounts[ACCOUNT], { ...account(), devices: Object.assign(Object.create(null), account().devices) });
    assert.equal(restored.accounts[ACCOUNT].rsaKeys.length, 2);
    assert.equal(restored.accounts[ACCOUNT].devices[SN].credentials?.rsa.privateKeyHistory?.[0], PRIVATE);
    assert.ok(f.key.some(byte => byte !== 0), '注入provider的共享key由调用方管理，不应被Vault修改');
  } finally { await f.cleanup(); }
});

test('磁盘只有AES256GCM信封且权限私有；独立解密验证AAD、IV和认证标签', async () => {
  const f = await fixture();
  try {
    await populate(f.make());
    const encoded = await readFile(f.filePath, 'utf8');
    for (const secret of [PRIVATE, TOKEN, ACCOUNT, SN, 'vault-fixture@example.com', 'FIXTURE-REFRESH-TOKEN']) assert.ok(!encoded.includes(secret));
    const envelope = JSON.parse(encoded);
    assert.deepEqual(Object.keys(envelope).sort(), ['algorithm', 'ciphertext', 'iv', 'tag', 'version']);
    assert.equal(envelope.algorithm, 'aes-256-gcm');
    assert.equal(Buffer.from(envelope.iv, 'base64').length, 12); assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
    const decryptor = createDecipheriv('aes-256-gcm', f.key, Buffer.from(envelope.iv, 'base64'));
    decryptor.setAAD(Buffer.from('PLAUD BLE Workspace vault:v1:aes-256-gcm'));
    decryptor.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([decryptor.update(Buffer.from(envelope.ciphertext, 'base64')), decryptor.final()]);
    try { assert.equal(JSON.parse(plaintext.toString()).accounts[ACCOUNT].login.userToken, TOKEN); } finally { plaintext.fill(0); }
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(f.filePath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(f.directory), ['vault-v1.json']);
    await f.make().update(() => {});
    assert.notEqual(JSON.parse(await readFile(f.filePath, 'utf8')).iv, envelope.iv);
  } finally { await f.cleanup(); }
});

test('load返回独立副本，mutator抛错不会污染原库或泄露敏感错误', async () => {
  const f = await fixture();
  try {
    await populate(f.make());
    const original = await readFile(f.filePath), loaded = await f.make().load();
    loaded.accounts[ACCOUNT].rsaKeys.length = 0;
    loaded.accounts[ACCOUNT].login!.userToken = 'changed';
    assert.equal((await f.make().load()).accounts[ACCOUNT].rsaKeys.length, 2);
    await code(f.make().update(async draft => {
      draft.accounts[ACCOUNT].rsaKeys.length = 0;
      await Promise.resolve();
      throw new Error(`${PRIVATE} ${TOKEN}`);
    }), 'VAULT_UPDATE_FAILED');
    assert.deepEqual(await readFile(f.filePath), original);
  } finally { await f.cleanup(); }
});

test('同路径不同Vault实例的异步更新按顺序完成，不丢历史RSA', async () => {
  const f = await fixture();
  try {
    await populate(f.make());
    const first = f.make(), second = f.make();
    await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second).update(async draft => {
      await new Promise<void>(resolve => setImmediate(resolve));
      draft.accounts[ACCOUNT].rsaKeys.push({ fingerprint: `revision-${index}`, publicKeyPem: 'PUBLIC', privateKeyPem: `PRIVATE-${index}`, createdAt: index });
    })));
    const restored = await f.make().load();
    assert.equal(restored.accounts[ACCOUNT].rsaKeys.length, 14);
    assert.equal(new Set(restored.accounts[ACCOUNT].rsaKeys.map(key => key.fingerprint)).size, 14);
  } finally { await f.cleanup(); }
});

test('错误主密钥拒绝解密且不得执行mutator或覆盖原始加密文件', async () => {
  const f = await fixture();
  const other = randomBytes(32);
  try {
    await populate(f.make());
    const original = await readFile(f.filePath), wrong = f.make({ getMasterKey: async () => other });
    await code(wrong.load(), 'VAULT_CORRUPT');
    let called = false;
    await code(wrong.update(() => { called = true; }), 'VAULT_CORRUPT');
    assert.equal(called, false); assert.deepEqual(await readFile(f.filePath), original);
  } finally { other.fill(0); await f.cleanup(); }
});

test('密文、认证标签、版本或编码损坏均拒绝并保留源文件', async t => {
  for (const kind of ['ciphertext', 'tag', 'version', 'invalid-base64', 'truncated'] as const) await t.test(kind, async () => {
    const f = await fixture();
    try {
      await populate(f.make());
      const envelope = JSON.parse(await readFile(f.filePath, 'utf8'));
      if (kind === 'ciphertext' || kind === 'tag') {
        const bytes = Buffer.from(envelope[kind], 'base64'); bytes[0] ^= 1; envelope[kind] = bytes.toString('base64');
      } else if (kind === 'version') envelope.version = 2;
      else if (kind === 'invalid-base64') envelope.iv = 'not+valid';
      const corrupted = kind === 'truncated' ? '{' : JSON.stringify(envelope);
      await writeFile(f.filePath, corrupted, { mode: 0o600 });
      let called = false;
      await code(f.make().update(() => { called = true; }), 'VAULT_CORRUPT');
      assert.equal(called, false); assert.equal(await readFile(f.filePath, 'utf8'), corrupted);
    } finally { await f.cleanup(); }
  });
});

test('格式、schema版本与4MiB大小不合要求时保留原库', async () => {
  const f = await fixture();
  try {
    await populate(f.make());
    const original = await readFile(f.filePath);
    await code(f.make().update(draft => { (draft as { version: number }).version = 2; }), 'VAULT_SCHEMA');
    await code(f.make().update(draft => { draft.activeAccountId = 'missing-account'; }), 'VAULT_SCHEMA');
    await code(f.make().update(draft => { draft.accounts[ACCOUNT].rsaKeys[0].privateKeyPem = 'x'.repeat(4 * 1024 * 1024); }), 'VAULT_LIMIT');
    assert.deepEqual(await readFile(f.filePath), original);
    await writeFile(f.filePath, JSON.stringify({ version: 1, accounts: {} }), { mode: 0o600 });
    const invalidSource = await readFile(f.filePath);
    await code(f.make().load(), 'VAULT_CORRUPT');
    assert.deepEqual(await readFile(f.filePath), invalidSource);
  } finally { await f.cleanup(); }
});

test('特殊账号ID使用无原型映射，往返不触发原型属性写入', async () => {
  const f = await fixture();
  try {
    await f.make().update(draft => {
      for (const id of ['__proto__', 'constructor', 'toString']) draft.accounts[id] = account(id);
      draft.activeAccountId = '__proto__';
    });
    const result = await f.make().load();
    assert.equal(Object.getPrototypeOf(result.accounts), null);
    assert.equal(Object.getPrototypeOf(result.accounts.__proto__.devices), null);
    assert.ok(Object.hasOwn(result.accounts, '__proto__'));
    assert.equal(result.accounts.__proto__.account.accountId, '__proto__');
    assert.equal(Object.keys(result.accounts).length, 3);
    assert.equal(Object.hasOwn(Object.prototype, 'account'), false);
  } finally { await f.cleanup(); }
});

test('主密钥provider失败或长度错误时不明文降级、不回传provider原始错误', async () => {
  const f = await fixture();
  try {
    await code(f.make({ getMasterKey: async () => { throw new Error(PRIVATE); } }).load(), 'VAULT_UNAVAILABLE');
    await code(f.make({ getMasterKey: async () => new Uint8Array(31) }).update(() => {}), 'LOCAL_KEY_INVALID');
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.cleanup(); }
});

test('不安全文件权限及符号链接拒绝读写且不覆盖目标', async () => {
  const f = await fixture();
  try {
    await populate(f.make());
    const original = await readFile(f.filePath);
    await chmod(f.filePath, 0o644);
    await code(f.make().update(() => {}), 'VAULT_PERMISSIONS');
    assert.deepEqual(await readFile(f.filePath), original);
    await chmod(f.filePath, 0o600);
    const linkedPath = join(f.directory, 'linked.json'); await symlink(f.filePath, linkedPath);
    await code(new Vault({ filePath: linkedPath, keyProvider: { getMasterKey: async () => f.key } }).load(), 'VAULT_UNAVAILABLE');
    assert.deepEqual(await readFile(f.filePath), original);
  } finally { await f.cleanup(); }
});

test('本地密钥并发原子创建、仅当前用户可读、不同provider复用同一密钥', async () => {
  const f = await fixture();
  const keys: Uint8Array[] = [];
  try {
    const keyPath = join(f.directory, 'master-key-v1.bin');
    keys.push(...await Promise.all(Array.from({ length: 24 }, () => new LocalFileKeyProvider(keyPath).getMasterKey())));
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(keyPath)).size, 32);
    assert.ok(keys[0].some(byte => byte !== 0));
    for (const key of keys) assert.deepEqual(key, keys[0]);
    const restarted = await new LocalFileKeyProvider(keyPath).getMasterKey(); keys.push(restarted);
    assert.deepEqual(restarted, keys[0]);
    assert.deepEqual(await readdir(f.directory), ['master-key-v1.bin']);
  } finally { for (const key of keys) key.fill(0); await f.cleanup(); }
});

test('本地密钥大小错误、宽松权限或符号链接均拒绝且不重建', async t => {
  for (const kind of ['empty', 'short', 'long', 'permissions', 'symlink'] as const) await t.test(kind, async () => {
    const f = await fixture();
    try {
      const keyPath = join(f.directory, 'master-key-v1.bin');
      const source = Buffer.alloc(kind === 'empty' ? 0 : kind === 'short' ? 31 : kind === 'long' ? 33 : 32, 0x6d);
      if (kind === 'symlink') {
        const target = join(f.directory, 'target.bin'); await writeFile(target, source, { mode: 0o600 });
        await symlink(target, keyPath);
      } else await writeFile(keyPath, source, { mode: 0o600 });
      if (kind === 'permissions') await chmod(keyPath, 0o644);
      await code(new LocalFileKeyProvider(keyPath).getMasterKey(), kind === 'symlink' ? 'LOCAL_KEY_UNAVAILABLE' : kind === 'permissions' ? 'VAULT_PERMISSIONS' : 'LOCAL_KEY_INVALID');
      assert.deepEqual(await readFile(keyPath), source);
      assert.equal((await readdir(f.directory)).some(name => name.startsWith('.master-key-')), false);
    } finally { await f.cleanup(); }
  });
});

test('默认本地provider重启恢复，不访问或改变旧vault-v1.json', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const legacyPath = join(f.directory, 'vault-v1.json'), localPath = join(f.directory, 'vault-local-v1.json');
    const legacy = 'opaque previous Keychain encrypted vault; preserve without reading';
    await writeFile(legacyPath, legacy, { mode: 0o600 });
    const first = new Vault({ filePath: localPath });
    await populate(first);
    const restored = await new Vault({ filePath: localPath }).load();
    assert.equal(restored.accounts[ACCOUNT].login?.userToken, TOKEN);
    assert.equal(restored.accounts[ACCOUNT].rsaKeys.length, 2);
    assert.equal((await stat(join(f.directory, 'master-key-v1.bin'))).mode & 0o777, 0o600);
    assert.equal(await readFile(legacyPath, 'utf8'), legacy);
    const encoded = await readFile(localPath, 'utf8');
    assert.ok(!encoded.includes(PRIVATE)); assert.ok(!encoded.includes(TOKEN));
    const helpers = await readdir(join(f.directory, 'native'));
    assert.ok(helpers.some(name => name.startsWith('FileLock-')));
    assert.ok(!helpers.some(name => name.startsWith('Keychain-')));
  } finally { await f.cleanup(); }
});
