import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAdvertisement } from '../src/protocol/advertisement.ts';
import { CloudError } from './cloud-client.ts';

export interface DetectedDevice { serialNumber: string; portVersion: number; firmware: string; source: 'native-advertisement' }
export type DeviceDetector = (serialNumber: string, signal: AbortSignal) => Promise<DetectedDevice>;
type Launch = (executable: string) => ChildProcessWithoutNullStreams;
const fail = (code: string, message: string, status = 503) => new CloudError(code, message, status);
const messages: Record<string, string> = {
  DEVICE_NOT_FOUND: '未能识别所选设备。请唤醒设备、关闭手机 App 的连接并靠近电脑，然后重试。',
  BLUETOOTH_PERMISSION_REQUIRED: '请在 macOS“隐私与安全性 → 蓝牙”中允许“PLAUD 设备识别”或启动本地服务的应用访问蓝牙，然后重试。',
  BLUETOOTH_POWERED_OFF: '电脑蓝牙尚未开启，请开启后重试。',
  BLUETOOTH_UNSUPPORTED: '此电脑不支持蓝牙设备识别。',
  BLUETOOTH_UNAVAILABLE: '系统蓝牙暂不可用，请稍后重试。',
  OPERATION_CANCELLED: '设备识别已取消。',
};
const cancelled = () => fail('OPERATION_CANCELLED', messages.OPERATION_CANCELLED, 409);
export function parseDiscoveredDevice(line: string, target: string): DetectedDevice | undefined {
  if (line.length > 2048) throw fail('DEVICE_DISCOVERY_INVALID', '设备识别结果无效，请重试。');
  let row: Record<string, unknown>;
  try { row = JSON.parse(line); } catch { throw fail('DEVICE_DISCOVERY_INVALID', '设备识别结果无效，请重试。'); }
  if (!row || typeof row !== 'object') throw fail('DEVICE_DISCOVERY_INVALID', '设备识别结果无效，请重试。');
  if (row.type === 'error') {
    const code = typeof row.code === 'string' && Object.hasOwn(messages, row.code) ? row.code : 'BLUETOOTH_UNAVAILABLE';
    throw fail(code, messages[code], code === 'OPERATION_CANCELLED' ? 409 : 503);
  }
  if (row.type !== 'advertisement' || typeof row.manufacturerHex !== 'string' || !/^(?:[0-9a-f]{2}){8,512}$/i.test(row.manufacturerHex)) return;
  // CoreBluetooth includes the two-byte company ID. The shared App-aligned parser excludes it.
  const bytes = Uint8Array.from(Buffer.from(row.manufacturerHex, 'hex'));
  const advertisement = decodeAdvertisement(bytes.subarray(2));
  if (!advertisement || advertisement.serialNumber !== target) return;
  return { serialNumber: advertisement.serialNumber, portVersion: advertisement.portVersion, firmware: advertisement.firmware, source: 'native-advertisement' };
}

export async function readNativeAdvertisement(executable: string, target: string, signal: AbortSignal,
  launch: Launch = path => spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }), timeoutMs = 65000): Promise<DetectedDevice> {
  if (signal.aborted) throw cancelled();
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = launch(executable); } catch { reject(fail('DEVICE_DISCOVERY_UNAVAILABLE', '无法启动设备自动识别，请重试。')); return; }
    let settled = false, pending = '', received = 0;
    const finish = (error?: unknown, value?: DetectedDevice) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      child.stdin.end(); child.kill('SIGTERM');
      const killing = setTimeout(() => child.kill('SIGKILL'), 1000); killing.unref();
      child.once('close', () => clearTimeout(killing));
      error ? reject(error) : resolve(value!);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(fail('DEVICE_NOT_FOUND', messages.DEVICE_NOT_FOUND)), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(fail('DEVICE_DISCOVERY_UNAVAILABLE', '无法启动设备自动识别，请重试。')));
    child.stdin.on('error', () => finish(fail('DEVICE_DISCOVERY_UNAVAILABLE', '设备识别中断，请重试。')));
    child.stderr.on('data', () => { /* Native diagnostics never become logs or API output. */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      received += Buffer.byteLength(chunk); pending += chunk;
      if (received > 32 * 1024 || pending.length > 4096) { finish(fail('DEVICE_DISCOVERY_INVALID', '设备识别结果无效，请重试。')); return; }
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try { const result = parseDiscoveredDevice(line, target); if (result) { finish(undefined, result); return; } }
        catch (error) { finish(error); return; }
      }
    });
    child.once('close', () => { if (!settled) finish(fail('DEVICE_DISCOVERY_UNAVAILABLE', '设备识别已停止。请检查蓝牙权限后重试。')); });
    child.stdin.write(JSON.stringify({ serialNumber: target }) + '\n');
    if (signal.aborted) abort();
  });
}

const defaultDirectory = join(homedir(), 'Library', 'Application Support', 'PLAUD BLE Workspace', 'native');
export class NativeDeviceDiscovery {
  private directory: string;
  private preparing?: Promise<string>;
  private busy = false;
  constructor(directory = defaultDirectory) { this.directory = directory; }
  async executable(): Promise<string> {
    if (process.platform !== 'darwin') throw fail('DEVICE_DISCOVERY_UNSUPPORTED', '当前系统尚未提供自动设备识别，请使用支持广播读取的浏览器。');
    this.preparing ??= this.compile().catch(error => { this.preparing = undefined; throw error; });
    return this.preparing;
  }
  private async compile(): Promise<string> {
    const source = fileURLToPath(new URL('./native/BroadcastScanner.swift', import.meta.url));
    const plist = await readFile(new URL('./native/BroadcastScanner.plist', import.meta.url));
    const hash = createHash('sha256').update(await readFile(source)).update(plist).digest('hex').slice(0, 24);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const parent = await lstat(this.directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) throw fail('DEVICE_DISCOVERY_UNAVAILABLE', '设备识别程序目录不可用，请重试。');
    const bundle = join(this.directory, `BroadcastScanner-${hash}.app`), executable = join(bundle, 'Contents', 'MacOS', 'BroadcastScanner');
    try {
      const info = await lstat(executable);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error();
      return executable;
    } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw fail('DEVICE_DISCOVERY_UNAVAILABLE', '设备识别程序不可用，请重试。'); }
    const temporary = `${bundle}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const target = join(temporary, 'Contents', 'MacOS', 'BroadcastScanner');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const infoPath = join(temporary, 'Contents', 'Info.plist'); await writeFile(infoPath, plist, { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        const child = spawn('/usr/bin/swiftc', [source, '-O', '-framework', 'CoreBluetooth', '-module-cache-path', join(this.directory, 'module-cache'), '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', infoPath, '-o', target], { stdio: 'ignore' });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error()); }, 60000);
        child.once('error', () => { clearTimeout(timer); reject(new Error()); });
        child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error()); });
      });
      await chmod(target, 0o700);
      try { await rename(temporary, bundle); } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && ['EEXIST', 'ENOTEMPTY'].includes(String(error.code)))) throw error;
      }
      return executable;
    } catch { throw fail('DEVICE_DISCOVERY_UNAVAILABLE', '无法准备设备自动识别程序，请确认本机 Swift 工具可用后重试。'); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
  readonly detect: DeviceDetector = async (serialNumber, signal) => {
    if (this.busy) throw fail('DEVICE_DISCOVERY_BUSY', '正在识别另一台设备，请稍后重试。', 409);
    if (signal.aborted) throw cancelled();
    this.busy = true;
    let onAbort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(cancelled()); signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      // Building the reusable helper may continue, but cancellation must not wait for the compiler.
      const executable = await Promise.race([this.executable(), interrupted]);
      if (signal.aborted) throw cancelled();
      return await readNativeAdvertisement(executable, serialNumber, signal);
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort); this.busy = false; }
  };
}
