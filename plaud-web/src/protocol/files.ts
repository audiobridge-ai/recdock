import { concat, request, view } from './bytes.ts';

export interface RecordingFile {
  sessionId: number;
  size: number;
  scene?: number;
  attribute?: number;
}

function uint32(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('文件协议字段应为无符号32位整数');
  return value;
}
function le32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  view(bytes).setUint32(0, uint32(value), true);
  return bytes;
}
function checkedPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('文件协议需要设备实际的协议版本');
  return port;
}
function control(frame: Uint8Array, command: number, length?: number): void {
  if (frame.length < 3 || frame[0] !== 1 || view(frame).getUint16(1, true) !== command ||
      (length !== undefined && frame.length !== length)) throw new Error('文件控制响应类型或长度无效');
}

// APK js2.getRecSessions / wza：设备主动分包推送目录，sessionId不是页号。
export function listRecordingsRequest(requestId: number, sessionId = 0): Uint8Array {
  return concat(request(0x1a), le32(requestId), le32(sessionId), Uint8Array.of(0));
}

export function decodeRecordingPage(frame: Uint8Array, port: number): { requestId: number; total: number; index: number; files: RecordingFile[] } {
  control(frame, 0x1a);
  checkedPort(port);
  if (frame.length < 11) throw new Error('录音目录响应过短');
  const data = view(frame), requestId = data.getUint32(3, true);
  const total = data.getUint16(7, true), index = data.getUint16(9, true);
  const itemSize = port === 1 ? 8 : port <= 6 ? 9 : 10;
  const payloadSize = frame.length - 11;
  if (payloadSize % itemSize) throw new Error('录音目录条目长度无效');
  const count = payloadSize / itemSize;
  if (index > total || count > total - index || (total === 0 && (index !== 0 || count !== 0)) ||
      (total > 0 && count === 0)) throw new Error('录音目录条目数量或索引无效');
  const files: RecordingFile[] = [];
  for (let offset = 11; offset < frame.length; offset += itemSize) {
    const entry: RecordingFile = { sessionId: data.getUint32(offset, true), size: data.getUint32(offset + 4, true) };
    // GetRecSessionsRsp → BleFile(session,size,attribute,scene)，不要交换构造参数。
    if (itemSize === 9) entry.attribute = frame[offset + 8];
    if (itemSize === 10) { entry.scene = frame[offset + 8]; entry.attribute = frame[offset + 9]; }
    files.push(entry);
  }
  return { requestId, total, index, files };
}

export function syncRecordingRequest(sessionId: number, start: number, end = 0): Uint8Array {
  uint32(start); uint32(end);
  if (end !== 0 && end < start) throw new Error('文件下载范围无效');
  // APK npi.startRecordingDataSync使用end=0；文件长度由目录单独验收。
  return concat(request(0x1c), le32(sessionId), le32(start), le32(end));
}
export const stopRecordingSyncRequest = (): Uint8Array => request(0x1d);

export function decodeFileHead(frame: Uint8Array): { sessionId: number; status: number } {
  control(frame, 0x1c, 8);
  return { sessionId: view(frame).getUint32(3, true), status: frame[7] };
}

export function decodeFileData(frame: Uint8Array, port: number): { sessionId?: number; offset: number; data: Uint8Array; endReason?: number } {
  checkedPort(port);
  const hasSession = port >= 7, offsetAt = hasSession ? 5 : 1, payloadAt = offsetAt + 5;
  if (frame[0] !== 2 || frame.length < payloadAt) throw new Error('录音数据响应类型或长度无效');
  const fields = view(frame), offset = fields.getUint32(offsetAt, true);
  const session = hasSession ? { sessionId: fields.getUint32(1, true) } : {};
  if (offset === 0xffffffff) {
    // rr2.java:125-132直接读取offsetAt+5处原因；此分支不以length解释原因码。
    if (frame.length <= payloadAt) throw new Error('录音结束数据缺少原因码');
    return { ...session, offset, data: new Uint8Array(), endReason: frame[payloadAt] };
  }
  const length = frame[offsetAt + 4];
  if (!length || frame.length !== payloadAt + length || offset + length > 0xffffffff) throw new Error('录音数据载荷长度或偏移无效');
  return { ...session, offset, data: frame.slice(payloadAt) };
}

export function decodeFileTail(frame: Uint8Array): { sessionId: number; crc: number } {
  control(frame, 0x1d, 9);
  return { sessionId: view(frame).getUint32(3, true), crc: view(frame).getUint16(7, true) };
}

export function decodeFileStop(frame: Uint8Array): void {
  control(frame, 0x1e, 3);
}
