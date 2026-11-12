'use strict';
const { mkdir, readFile, writeFile, rename, lstat } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { randomUUID } = require('node:crypto');

async function privateJson(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
async function readSettings(support) {
  await mkdir(support, { recursive: true, mode: 0o700 });
  const path = join(support, 'settings.json');
  let settings = {};
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw Error('UNSAFE_SETTINGS');
    settings = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (settings.modelsDirectory !== undefined && (typeof settings.modelsDirectory !== 'string' || !isAbsolute(settings.modelsDirectory))) throw Error('INVALID_MODEL_DIRECTORY');
  return settings;
}
module.exports = { privateJson, readSettings };
