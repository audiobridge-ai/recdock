'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, symlink, rm, readFile, stat } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { staticPath, tokenEqual, externalUrl } = require('../src/security.cjs');
const { privateJson, readSettings } = require('../src/settings.cjs');

test('desktop serves only packaged public files and rejects encoded traversal and foreign tokens', () => {
  assert.equal(staticPath('/app/public', '/'), '/app/public/index.html');
  assert.equal(staticPath('/app/public', '/assets/main.js'), '/app/public/assets/main.js');
  for (const name of ['/../vault.json', '/%2e%2e/token', '/assets/%2e%2e/%2e%2e/token', '/%00secret', '/a\\b', '/%E0%A4%A']) assert.equal(staticPath('/app/public', name), null, name);
  assert.equal(tokenEqual('abc', 'abc'), true); assert.equal(tokenEqual('abc', 'abd'), false); assert.equal(tokenEqual(['abc'], 'abc'), false);
  assert.equal(externalUrl('javascript:alert(1)'), null); assert.equal(externalUrl('https://chatgpt.com.evil.test/'), null); assert.equal(externalUrl('https://user:secret@chatgpt.com/'), null);
  assert.equal(externalUrl('https://chatgpt.com/c/known'), 'https://chatgpt.com/c/known');
});
test('existing model directory settings survive desktop migration and atomic updates stay private', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recdock-settings-'));
  try {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ modelsDirectory: '/existing/models', preserved: true }));
    const settings = await readSettings(dir); assert.equal(settings.modelsDirectory, '/existing/models');
    await privateJson(join(dir, 'settings.json'), { ...settings, newPreference: true });
    assert.equal(JSON.parse(await readFile(join(dir, 'settings.json'))).preserved, true);
    assert.equal((await stat(join(dir, 'settings.json'))).mode & 0o077, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('settings symlinks fail closed instead of reading another application file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recdock-settings-'));
  try { await writeFile(join(dir, 'other.json'), '{}'); await symlink(join(dir, 'other.json'), join(dir, 'settings.json')); await assert.rejects(() => readSettings(dir), /UNSAFE/); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
