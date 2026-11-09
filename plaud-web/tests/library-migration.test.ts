import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyLibrary } from '../server/library/migration.ts';
import { exists, fileSha256 } from '../server/library/common.ts';

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'recdock-migrate-')), root = join(temp, 'project', 'library'), legacy = join(temp, 'legacy');
  await mkdir(join(root, 'scopes'), { recursive: true });
  const source = join(legacy, 'scopes', 'scope_personal', 'recordings', 'rec_test'); await mkdir(source, { recursive: true });
  await writeFile(join(source, 'source.ogg'), Buffer.from([0, 1, 2, 255])); await writeFile(join(source, 'transcript.json'), '{"revisionId":"rev_test"}');
  return { temp, root, legacy, source, close: () => rm(temp, { recursive: true, force: true }) };
}
test('旧录音库逐文件校验后迁入项目，保留原目录，重复启动不覆盖新文件', async () => {
  const f = await fixture();
  try {
    await migrateLegacyLibrary(f.root, f.legacy);
    const copied = join(f.root, 'scopes', 'scope_personal', 'recordings', 'rec_test');
    assert.equal(await fileSha256(join(copied, 'source.ogg')), await fileSha256(join(f.source, 'source.ogg')));
    assert.equal(JSON.parse(await readFile(join(f.root, 'migration.json'), 'utf8')).copiedFiles, 2);
    await writeFile(join(copied, 'transcript.json'), 'new local revision');
    await migrateLegacyLibrary(f.root, f.legacy);
    assert.equal(await readFile(join(copied, 'transcript.json'), 'utf8'), 'new local revision');
    assert.equal(await readFile(join(f.source, 'transcript.json'), 'utf8'), '{"revisionId":"rev_test"}');
  } finally { await f.close(); }
});
test('迁移不读取链接或运行中的旧库，失败不发布半份录音库', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.legacy, 'service.lock'), JSON.stringify({ pid: process.pid }));
    await assert.rejects(migrateLegacyLibrary(f.root, f.legacy), { code: 'LIBRARY_LOCKED' });
    await rm(join(f.legacy, 'service.lock'));
    await symlink(join(f.source, 'source.ogg'), join(f.source, 'link.ogg'));
    await assert.rejects(migrateLegacyLibrary(f.root, f.legacy), { code: 'STORAGE_UNSAFE' });
    assert.deepEqual(await readdir(join(f.root, 'scopes')), []);
    assert.equal(await exists(join(f.root, 'migration.json')), false);
    assert.equal((await readdir(f.root)).some(name => name.startsWith('.migration_')), false);
  } finally { await f.close(); }
});
test('已有项目录音库不会被旧库合并或替换', async () => {
  const f = await fixture();
  try { await mkdir(join(f.root, 'scopes', 'scope_existing')); await migrateLegacyLibrary(f.root, f.legacy); assert.deepEqual(await readdir(join(f.root, 'scopes')), ['scope_existing']); }
  finally { await f.close(); }
});
