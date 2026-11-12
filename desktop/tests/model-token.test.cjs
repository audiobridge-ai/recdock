const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, stat, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ModelToken } = require('../src/model-token.cjs');

test('状态查询和无令牌运行不访问钥匙串；拒绝解密保留密文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recdock-token-'));
  let calls = 0, deny = false;
  const storage = {
    isEncryptionAvailable() { calls++; return true; },
    encryptString(value) { calls++; return Buffer.from('encrypted:' + value); },
    decryptString(value) { calls++; if (deny) throw Error('denied'); return value.toString().slice(10); },
  };
  try {
    const file = join(root, 'hf.enc'), tokens = new ModelToken(file, storage);
    assert.equal(await tokens.saved(), false); assert.equal(await tokens.read(), ''); assert.equal(calls, 0);
    await tokens.save('hf_TestOnly123456'); const encrypted = await readFile(file);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    calls = 0; assert.equal(await tokens.saved(), true); assert.equal(calls, 0);
    deny = true; await assert.rejects(tokens.read(), /已有模型仍可离线使用/);
    assert.deepEqual(await readFile(file), encrypted);
    deny = false; assert.equal(await tokens.read(), 'hf_TestOnly123456');
    calls = 0; await tokens.remove(); assert.equal(await tokens.saved(), false); assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
