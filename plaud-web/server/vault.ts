import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CloudDevice, CloudSession } from './cloud-client.ts';
import type { Credentials } from '../src/auth/credentials.ts';

export interface VaultAccount {
  account: { accountId: string; email: string };
  login?: CloudSession;
  loginSavedAt?: number;
  loginValidUntil?: number;
  rsaKeys: Array<{ fingerprint: string; publicKeyPem: string; privateKeyPem: string; createdAt: number }>;
  devices: Record<string, {
    device: CloudDevice; credentials?: Credentials;
    verifiedPortVersion?: number; verifiedFirmware?: string;
    preparedAt?: number; verifiedAt?: number;
  }>;
}
export interface VaultData { version: 1; activeAccountId?: string; accounts: Record<string, VaultAccount> }
export interface KeyProvider { getMasterKey(): Promise<Uint8Array> }
export interface VaultOptions { filePath?: string; keyProvider?: KeyProvider }
export class VaultError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'VaultError'; this.code = code; }
}

const DIRECTORY = join(homedir(), 'Library', 'Application Support', 'PLAUD BLE Workspace');
// The former Keychain-backed vault-v1.json is deliberately never read or migrated.
const DEFAULT_FILE = join(DIRECTORY, 'vault-local-v1.json');
const MAX_JSON = 4 * 1024 * 1024;
const MAX_ENVELOPE = Math.ceil(MAX_JSON / 3) * 4 + 4096;
const AAD = Buffer.from('PLAUD BLE Workspace vault:v1:aes-256-gcm');
const queues = new Map<string, Promise<void>>();
type JsonObject = Record<string, unknown>;
type HeldLock = { assertHeld(): void; release(): Promise<void> };
const empty = (): VaultData => ({ version: 1, accounts: Object.create(null) as Record<string, VaultAccount> });
const hasCode = (error: unknown, code: string) => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
const owned = (uid: number) => typeof process.getuid !== 'function' || uid === process.getuid();
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const textField = (value: unknown): value is string => typeof value === 'string';
const timestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const port = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
function schemaFailure(): never { throw new VaultError('VAULT_SCHEMA', '本机凭据库的数据格式不受支持，原文件已保留。'); }

function isDevice(value: unknown): boolean {
  return object(value) && typeof value.serialNumber === 'string' && value.serialNumber.length > 0 &&
    typeof value.name === 'string' && optional(value.model, textField) && optional(value.firmware, textField) && optional(value.portVersion, port);
}
function isCredentials(value: unknown): boolean {
  if (!object(value) || !['accountId', 'bindingToken', 'serialNumber'].every(key => textField(value[key])) || !optional(value.portVersion, port)) return false;
  const rsa = value.rsa, ecc = value.ecc, second = value.secondHandshake;
  return object(rsa) && ['snSignature', 'publicKeyPem', 'privateKeyPem'].every(key => textField(rsa[key])) && typeof rsa.alternateCommand === 'boolean' &&
    object(ecc) && textField(ecc.devicePublicKeyHex) && textField(ecc.userPrivateKeyHex) &&
    object(second) && textField(second.extra8) && textField(second.extraText);
}
function validate(value: unknown): asserts value is VaultData {
  if (!object(value) || value.version !== 1 || !object(value.accounts)) schemaFailure();
  const accounts = value.accounts;
  for (const [id, row] of Object.entries(accounts)) {
    if (!id || id.length > 1024 || !object(row) || !object(row.account) || row.account.accountId !== id || !textField(row.account.email) ||
        !Array.isArray(row.rsaKeys) || !object(row.devices) || !optional(row.loginSavedAt, timestamp) || !optional(row.loginValidUntil, timestamp)) schemaFailure();
    for (const rsa of row.rsaKeys) {
      if (!object(rsa) || !textField(rsa.fingerprint) || !rsa.fingerprint || !textField(rsa.publicKeyPem) || !rsa.publicKeyPem ||
          !textField(rsa.privateKeyPem) || !rsa.privateKeyPem || !timestamp(rsa.createdAt)) schemaFailure();
    }
    for (const [serial, entry] of Object.entries(row.devices)) {
      if (!object(entry) || !isDevice(entry.device) || (entry.device as JsonObject).serialNumber !== serial ||
          !optional(entry.credentials, isCredentials) || !optional(entry.verifiedPortVersion, port) || !optional(entry.verifiedFirmware, textField) ||
          !optional(entry.preparedAt, timestamp) || !optional(entry.verifiedAt, timestamp)) schemaFailure();
    }
    if (row.login !== undefined) {
      const login = row.login;
      if (!object(login) || !textField(login.userToken) || !login.userToken || !textField(login.userBaseUrl) ||
          !object(login.account) || login.account.accountId !== id || !textField(login.account.email) ||
          !Array.isArray(login.devices) || !login.devices.every(isDevice) ||
          !['workspaceToken', 'workspaceBaseUrl', 'workspaceId'].every(key => optional(login[key], textField))) schemaFailure();
    }
  }
  if (value.activeAccountId !== undefined && (typeof value.activeAccountId !== 'string' || !Object.hasOwn(accounts, value.activeAccountId))) schemaFailure();
}
function jsonBytes(value: unknown): Buffer {
  let encoded: string;
  try {
    encoded = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || (typeof item === 'number' && !Number.isFinite(item))) schemaFailure();
      return item;
    });
  } catch (error) { if (error instanceof VaultError) throw error; schemaFailure(); }
  if (typeof encoded !== 'string') schemaFailure();
  const bytes = Buffer.from(encoded, 'utf8');
  if (bytes.length > MAX_JSON) { bytes.fill(0); throw new VaultError('VAULT_LIMIT', '本机凭据库数据超过4 MiB限制，未保存更改。'); }
  return bytes;
}
function clone(value: VaultData): VaultData {
  const bytes = jsonBytes(value);
  try {
    const result = JSON.parse(bytes.toString('utf8')) as VaultData;
    result.accounts = Object.assign(Object.create(null), result.accounts) as Record<string, VaultAccount>;
    for (const account of Object.values(result.accounts)) account.devices = Object.assign(Object.create(null), account.devices) as VaultAccount['devices'];
    return result;
  } finally { bytes.fill(0); }
}
async function serialised<T>(path: string, action: () => Promise<T>): Promise<T> {
  const prior = queues.get(path) ?? Promise.resolve();
  const task = prior.then(action), settled = task.then(() => {}, () => {});
  queues.set(path, settled);
  void settled.then(() => { if (queues.get(path) === settled) queues.delete(path); });
  return task;
}
async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info.uid)) throw new VaultError('VAULT_PERMISSIONS', '本机凭据库目录不安全，已停止读写。');
  if ((info.mode & 0o077) !== 0) {
    if (path !== DIRECTORY && path !== join(DIRECTORY, 'native')) throw new VaultError('VAULT_PERMISSIONS', '请为凭据库选择仅当前用户可访问的独立目录。');
    await chmod(path, 0o700);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); }
  catch (error) { if (!hasCode(error, 'EINVAL') && !hasCode(error, 'ENOTSUP')) throw error; }
  finally { await directory.close(); }
}

/** At-rest protection relies on this user's private directory and file permissions. */
export class LocalFileKeyProvider implements KeyProvider {
  private filePath: string;
  constructor(filePath = join(DIRECTORY, 'master-key-v1.bin')) { this.filePath = resolve(filePath); }
  private async existing(): Promise<Uint8Array | undefined> {
    let handle;
    try { handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error; }
    let bytes: Buffer | undefined;
    try {
      const info = await handle.stat();
      if (!info.isFile() || !owned(info.uid) || (info.mode & 0o077)) throw new VaultError('VAULT_PERMISSIONS', '本机密钥文件权限不安全，已停止读写。');
      if (info.size !== 32) throw new VaultError('LOCAL_KEY_INVALID', '本机密钥文件长度错误，原文件已保留。');
      bytes = await handle.readFile();
      if (bytes.length !== 32) throw new VaultError('LOCAL_KEY_INVALID', '本机密钥文件长度错误，原文件已保留。');
      return Uint8Array.from(bytes);
    } finally { bytes?.fill(0); await handle.close(); }
  }
  async getMasterKey(): Promise<Uint8Array> {
    let temporary: string | undefined, generated: Buffer | undefined, handle;
    try {
      await secureDirectory(dirname(this.filePath));
      const existing = await this.existing(); if (existing) return existing;
      generated = randomBytes(32);
      temporary = join(dirname(this.filePath), `.master-key-${randomBytes(16).toString('hex')}.tmp`);
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.chmod(0o600); await handle.writeFile(generated); await handle.sync(); await handle.close(); handle = undefined;
      // A hard-link publishes the already complete inode atomically, without
      // replacing another creator's winner or following an existing symlink.
      try { await link(temporary, this.filePath); }
      catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
      await syncDirectory(dirname(this.filePath));
      const winner = await this.existing();
      if (!winner) throw new Error();
      return winner;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError('LOCAL_KEY_UNAVAILABLE', '无法访问本机密钥文件，凭据未保存。');
    } finally {
      generated?.fill(0); await handle?.close();
      if (temporary) await unlink(temporary).catch(() => {});
    }
  }
}

class NativeFileLock {
  private helper?: Promise<string>;
  private directory: string;
  constructor(directory: string) { this.directory = directory; }
  private executable(): Promise<string> {
    if (process.env.RECDOCK_FILELOCK_HELPER) return Promise.resolve(process.env.RECDOCK_FILELOCK_HELPER);
    if (!this.helper) this.helper = this.compile().catch(error => { this.helper = undefined; throw error; });
    return this.helper;
  }
  private async compile(): Promise<string> {
    if (process.platform !== 'darwin') throw new VaultError('VAULT_LOCK_UNAVAILABLE', '当前系统无法使用本机文件锁，凭据未保存。');
    const source = fileURLToPath(new URL('./native/FileLock.swift', import.meta.url));
    const digest = createHash('sha256').update(await readFile(source)).digest('hex');
    const nativeDirectory = join(this.directory, 'native'); await secureDirectory(nativeDirectory);
    const target = join(nativeDirectory, `FileLock-${digest.slice(0, 24)}`);
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || !owned(info.uid) || (info.mode & 0o077)) throw new Error();
      return target;
    } catch (error) { if (!hasCode(error, 'ENOENT')) throw new VaultError('VAULT_LOCK_UNAVAILABLE', '本机文件锁辅助程序不可用，凭据未保存。'); }
    const temporary = `${target}.${randomBytes(12).toString('hex')}.tmp`;
    try {
      await new Promise<void>((resolveCompile, reject) => {
        const child = spawn('/usr/bin/swiftc', [source, '-O', '-module-cache-path', join(nativeDirectory, 'module-cache'), '-o', temporary], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error()); }, 60000);
        child.once('error', () => { clearTimeout(timer); reject(new Error()); });
        child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveCompile() : reject(new Error()); });
      });
      await chmod(temporary, 0o700); await rename(temporary, target); return target;
    } catch { throw new VaultError('VAULT_LOCK_UNAVAILABLE', '无法准备本机文件锁辅助程序，凭据未保存。'); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async lock(path: string): Promise<HeldLock> {
    const executable = await this.executable();
    return new Promise<HeldLock>((resolveLock, reject) => {
      const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
      let ready = false, ended = false;
      const fail = (busy = false) => reject(new VaultError(busy ? 'VAULT_BUSY' : 'VAULT_LOCK_UNAVAILABLE', busy ? '另一个进程正在使用本机凭据库，请稍后重试。' : '本机凭据库锁不可用，已停止读写。'));
      const timer = setTimeout(() => { child.kill('SIGKILL'); fail(); }, 15000);
      child.once('error', () => { ended = true; clearTimeout(timer); if (!ready) fail(); });
      child.stdin.on('error', () => {});
      child.once('exit', code => { ended = true; clearTimeout(timer); if (!ready) fail(code === 75); });
      child.stdout.once('data', (chunk: Buffer) => {
        clearTimeout(timer);
        if (chunk.length !== 1 || chunk[0] !== 1) { child.kill('SIGKILL'); fail(); return; }
        ready = true;
        resolveLock({
          assertHeld() { if (ended) throw new VaultError('VAULT_BUSY', '本机凭据库锁已释放，未保存更改。'); },
          async release() {
            if (ended) return;
            await new Promise<void>(done => {
              const releaseTimer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 2000);
              child.once('exit', () => { clearTimeout(releaseTimer); done(); }); child.stdin.end();
            });
          },
        });
      });
      child.stdin.write(JSON.stringify({ action: 'lock', path }) + '\n');
    });
  }
}

export class Vault {
  private filePath: string;
  private provider: KeyProvider;
  private native?: NativeFileLock;
  private ownsProvider: boolean;
  constructor(options: VaultOptions = {}) {
    this.filePath = resolve(options.filePath ?? DEFAULT_FILE);
    this.ownsProvider = !options.keyProvider;
    this.provider = options.keyProvider ?? new LocalFileKeyProvider(join(dirname(this.filePath), 'master-key-v1.bin'));
    if (this.ownsProvider) this.native = new NativeFileLock(dirname(this.filePath));
  }
  private async transaction<T>(action: (key: Buffer, assertHeld: () => void) => Promise<T>): Promise<T> {
    return serialised(this.filePath, async () => {
      let key: Buffer | undefined, provided: Uint8Array | undefined, lock: HeldLock | undefined;
      try {
        await secureDirectory(dirname(this.filePath));
        // Default macOS storage has a crash-safe cross-process flock. Injected
        // providers are intentionally limited to this process's per-path queue.
        lock = await this.native?.lock(`${this.filePath}.lock`);
        provided = await this.provider.getMasterKey();
        if (!(provided instanceof Uint8Array) || provided.length !== 32) throw new VaultError('LOCAL_KEY_INVALID', '本机密钥来源未返回有效主密钥，已停止读写。');
        key = Buffer.from(provided);
        return await action(key, () => lock?.assertHeld());
      } catch (error) {
        if (error instanceof VaultError) throw error;
        throw new VaultError('VAULT_UNAVAILABLE', '无法访问本机加密凭据库，原文件已保留。');
      } finally {
        key?.fill(0); if (this.ownsProvider) provided?.fill(0); await lock?.release();
      }
    });
  }
  private async read(key: Buffer): Promise<VaultData> {
    let handle;
    try { handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (hasCode(error, 'ENOENT')) return empty(); throw error; }
    let plaintext: Buffer | undefined;
    const pieces: Buffer[] = [];
    try {
      const info = await handle.stat();
      if (!info.isFile() || !owned(info.uid) || (info.mode & 0o077)) throw new VaultError('VAULT_PERMISSIONS', '本机凭据库文件权限不安全，已停止读写。');
      if (info.size > MAX_ENVELOPE) throw new VaultError('VAULT_LIMIT', '本机凭据库文件超过允许大小，原文件已保留。');
      const raw = await handle.readFile();
      if (raw.length > MAX_ENVELOPE) throw new Error();
      const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      if (!object(envelope) || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error();
      const decode = (value: unknown, length?: number) => {
        if (typeof value !== 'string' || !/^(?:[a-z\d+/]{4})*(?:[a-z\d+/]{2}==|[a-z\d+/]{3}=)?$/i.test(value)) throw new Error();
        const result = Buffer.from(value, 'base64');
        if (result.toString('base64') !== value || (length !== undefined && result.length !== length)) throw new Error();
        return result;
      };
      const iv = decode(envelope.iv, 12), tag = decode(envelope.tag, 16), ciphertext = decode(envelope.ciphertext);
      if (!ciphertext.length || ciphertext.length > MAX_JSON) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(AAD); decipher.setAuthTag(tag);
      pieces.push(decipher.update(ciphertext)); pieces.push(decipher.final()); plaintext = Buffer.concat(pieces);
      if (plaintext.length > MAX_JSON) throw new Error();
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)); validate(decoded);
      return clone(decoded);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError('VAULT_CORRUPT', '本机凭据库无法通过解密或格式校验，原文件已保留，请勿覆盖。');
    } finally { plaintext?.fill(0); for (const piece of pieces) piece.fill(0); await handle.close(); }
  }
  private async write(data: VaultData, key: Buffer, assertHeld: () => void): Promise<void> {
    validate(data);
    const plaintext = jsonBytes(data), iv = randomBytes(12);
    const temporary = join(dirname(this.filePath), `.vault-${randomBytes(16).toString('hex')}.tmp`);
    let handle;
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope = JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.chmod(0o600); await handle.writeFile(envelope, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
      assertHeld(); await rename(temporary, this.filePath);
      await syncDirectory(dirname(this.filePath));
    } finally { plaintext.fill(0); await handle?.close(); await unlink(temporary).catch(() => {}); }
  }
  async load(): Promise<VaultData> { return this.transaction(async key => clone(await this.read(key))); }
  async update(mutator: (draft: VaultData) => void | Promise<void>): Promise<void> {
    await this.transaction(async (key, assertHeld) => {
      const draft = clone(await this.read(key));
      try { await mutator(draft); } catch { throw new VaultError('VAULT_UPDATE_FAILED', '凭据库更新未完成，原有数据未更改。'); }
      await this.write(draft, key, assertHeld);
    });
  }
}
