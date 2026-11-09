import { command, view } from './bytes.ts';

function check(b: Uint8Array, cmd: number, minimum: number) {
  if (command(b) !== cmd || b.length < minimum) throw new Error(`命令 ${cmd} 的响应格式或长度无效`);
}
export function decodeState(b: Uint8Array) {
  check(b, 3, 8);
  return {
    stateCode: view(b).getUint32(3, true), privacy: b[7] === 1,
    keyStateCode: b.length >= 9 ? b[8] : undefined,
    usb: b.length >= 10 ? b[9] === 1 : undefined,
    scene: b.length >= 15 ? b[10] : undefined,
    sessionId: b.length >= 15 ? view(b).getUint32(11, true) : undefined,
    findMy: b.length >= 16 ? b[15] : undefined,
    sndp: b.length >= 17 ? b[16] : undefined,
    http: b.length >= 18 ? b[17] : undefined,
    signal: b.length >= 19 ? b[18] : undefined,
    esim: b.length >= 20 ? b[19] : undefined,
  };
}
export function decodeBattery(b: Uint8Array) {
  check(b, 9, 5);
  if (b[4] > 100) throw new Error('设备返回的电量超出 0–100%');
  return { charging: b[3] === 1, level: b[4] };
}
export function decodeStorage(b: Uint8Array) {
  check(b, 6, 19);
  const free = view(b).getBigUint64(3, true), total = view(b).getBigUint64(11, true);
  if (free > total) throw new Error('设备返回的可用容量大于总容量');
  return { free, total, duration: b.length >= 27 ? view(b).getBigUint64(19, true) : undefined };
}
export function decodeHandshake(b: Uint8Array) {
  check(b, 1, 4);
  return {
    status: b[3], portVersion: b.length >= 6 ? view(b).getUint16(4, true) : undefined,
    timeZone: b.length >= 7 ? b[6] : undefined,
    audioChannels: b.length >= 9 ? b[8] : undefined,
    noNsAgc: b.length >= 11 ? b[10] === 1 : undefined,
    isOggAudio: b.length >= 12 ? b[11] === 1 : undefined,
  };
}
export type DeviceState = ReturnType<typeof decodeState>;
export type Battery = { level: number; charging?: boolean };
export type Storage = ReturnType<typeof decodeStorage>;

export function formatBytes(n: bigint): string {
  if (n < 1024n) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let unit = 1024n, i = 0;
  while (n >= unit * 1024n && i < units.length - 1) { unit *= 1024n; i++; }
  return `${n * 100n / unit / 100n}.${String(n * 100n / unit % 100n).padStart(2, '0')} ${units[i]}`;
}
