import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class LibraryError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export function validId(value: string) {
  if (!/^[a-z]+_[A-Za-z0-9_-]{1,120}$/.test(value)) throw new LibraryError('NOT_FOUND', '未找到此录音或任务。', 404);
  return value;
}
export const scopeFor = (account?: string) => account ? `scope_${createHash('sha256').update(account).digest('hex').slice(0, 32)}` : 'scope_personal';
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function secureDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new LibraryError('STORAGE_UNSAFE', '录音库目录不可用，请检查本机存储权限。', 500);
  await chmod(path, 0o700);
}
export async function jsonFile<T>(path: string): Promise<T> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new LibraryError('STORAGE_INVALID', '本机资料格式或大小不受支持，原文件已保留。', 500);
    return JSON.parse(await handle.readFile('utf8')) as T;
  } finally { await handle.close(); }
}
export async function atomicJson(path: string, value: unknown) {
  await secureDirectory(dirname(path));
  const temporary = join(dirname(path), `.${id('tmp')}.json`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}
export async function fileSha256(path: string) {
  const hash = createHash('sha256');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes); }
  finally { await handle.close(); }
  return hash.digest('hex');
}
export function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
export async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; } }
export async function acquireLock(root: string) {
  const path = join(root, 'service.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); await handle.close();
      return async () => { const held = await jsonFile<{ pid: number }>(path); if (held.pid === process.pid) await unlink(path); };
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
      const owner = await jsonFile<{ pid: number }>(path);
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new LibraryError('LIBRARY_LOCKED', '录音库锁状态异常，原数据已保留。', 503);
      try { process.kill(owner.pid, 0); }
      catch (e) {
        if (e && typeof e === 'object' && 'code' in e && e.code === 'ESRCH') { await unlink(path); continue; }
        throw e;
      }
      throw new LibraryError('LIBRARY_LOCKED', '另一工作台服务正在使用录音库，请先关闭另一服务。', 503);
    }
  }
  throw new LibraryError('LIBRARY_LOCKED', '录音库正在启动，请稍后重试。', 503);
}
export async function readText(path: string) { return readFile(path, 'utf8'); }
