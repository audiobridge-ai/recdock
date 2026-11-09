import { chmod, copyFile, lstat, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, exists, fileSha256, id, jsonFile, LibraryError, secureDirectory } from './common.ts';

/** Copy legacy data without changing it. Publish only after every copied file is verified. */
export async function migrateLegacyLibrary(root: string, legacy: string) {
  if (root === legacy || await exists(join(root, 'migration.json')) || !await exists(join(legacy, 'scopes'))) return;
  if ((await readdir(join(root, 'scopes'))).length) return;
  if (await exists(join(legacy, 'service.lock'))) {
    const owner = await jsonFile<{ pid: number }>(join(legacy, 'service.lock'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new LibraryError('LIBRARY_LOCKED', '旧录音库锁状态异常，请先关闭旧工作台。', 503);
    try { process.kill(owner.pid, 0); throw new LibraryError('LIBRARY_LOCKED', '旧工作台仍在使用录音库，请先关闭旧服务再迁移。', 503); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error; }
  }
  const staging = join(root, '.' + id('migration')); let files = 0;
  async function copy(source: string, target: string) {
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new LibraryError('STORAGE_UNSAFE', '旧录音库包含链接，迁移已停止，原数据保留。', 500);
    if (info.isDirectory()) {
      await secureDirectory(target);
      for (const name of await readdir(source)) await copy(join(source, name), join(target, name));
    } else if (info.isFile()) {
      await copyFile(source, target);
      await chmod(target, 0o600);
      if (await fileSha256(source) !== await fileSha256(target)) throw new LibraryError('MIGRATION_INCOMPLETE', '录音复制校验未通过，原数据保留，请重试。', 500);
      files++;
    } else throw new LibraryError('STORAGE_UNSAFE', '旧录音库包含不支持的文件，原数据保留。', 500);
  }
  try {
    await secureDirectory(staging); await copy(join(legacy, 'scopes'), join(staging, 'scopes'));
    await rename(join(staging, 'scopes'), join(root, 'scopes'));
    await atomicJson(join(root, 'migration.json'), { version: 1, source: legacy, copiedFiles: files, verifiedAt: Date.now(), originalPreserved: true });
  } finally { await rm(staging, { recursive: true, force: true }); }
}
