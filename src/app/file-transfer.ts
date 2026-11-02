import { command, view } from '../protocol/bytes.ts';
import { decodeRecordingPage, listRecordingsRequest, decodeFileHead, decodeFileData, decodeFileTail, syncRecordingRequest } from '../protocol/files.ts';
import type { RecordingFile } from '../protocol/files.ts';

export interface FileIO {
  send(packet: Uint8Array): Promise<void>;
  receive(predicate: (packet: Uint8Array) => boolean, timeout: number): Promise<Uint8Array>;
  stop(): Promise<void>;
  cancelled(): boolean;
  progress(received: number, notice?: string): void;
}
export interface TransferBuffer { file: RecordingFile; data: Uint8Array; received: number }
export class TransferCancelled extends Error { constructor() { super('下载已取消'); } }
export class FileStopError extends Error {}
class FileGap extends Error {}

export async function receiveRecordingList(io: FileIO, requestId: number, port: number, timeout = 10000): Promise<RecordingFile[]> {
  const files: RecordingFile[] = [];
  let total: number | undefined;
  await io.send(listRecordingsRequest(requestId));
  do {
    if (io.cancelled()) throw new TransferCancelled();
    const packet = await io.receive(p => command(p) === 26 && p.length >= 7 && view(p).getUint32(3, true) === requestId, timeout);
    if (io.cancelled()) throw new TransferCancelled();
    const page = decodeRecordingPage(packet, port);
    if (total !== undefined && total !== page.total) throw new Error('设备录音目录在读取期间发生变化，请刷新列表');
    total = page.total;
    if (page.index < files.length) {
      if (page.index + page.files.length > files.length || page.files.some((f, i) => JSON.stringify(f) !== JSON.stringify(files[page.index + i]))) {
        throw new Error('设备录音目录包含冲突条目，请重新刷新');
      }
      continue;
    }
    if (page.index !== files.length) throw new Error('设备录音目录缺少部分条目，请重新刷新');
    if (!page.files.length && total > files.length) throw new Error('设备返回了不完整的录音目录');
    files.push(...page.files);
    if (files.length > total) throw new Error('设备录音目录条目数无效');
  } while (files.length !== total);
  if (new Set(files.map(f => f.sessionId)).size !== files.length) throw new Error('设备目录包含重复的录音编号，请重新刷新');
  return files;
}

export async function receiveRecording(io: FileIO, buffer: TransferBuffer, port: number, timeout = 12000, retryLimit = 2): Promise<Uint8Array> {
  const { file, data } = buffer;
  let retries = 0;
  for (;;) {
    if (io.cancelled()) throw new TransferCancelled();
    let headSeen = false;
    await io.send(syncRecordingRequest(file.sessionId, buffer.received, 0));
    try {
      for (;;) {
        if (io.cancelled()) throw new TransferCancelled();
        const packet = await io.receive(p => {
          if (p[0] === 2) return port < 7 || p.length < 5 || view(p).getUint32(1, true) === file.sessionId;
          const cmd = command(p);
          return (cmd === 28 || cmd === 29) && (p.length < 7 || view(p).getUint32(3, true) === file.sessionId);
        }, timeout);
        if (io.cancelled()) throw new TransferCancelled();
        if (command(packet) === 28) {
          const head = decodeFileHead(packet);
          if (head.status !== 0) throw new Error(`设备未接受录音下载（状态码 ${head.status}），请刷新目录后重试`);
          headSeen = true; continue;
        }
        if (!headSeen) throw new Error('尚未收到下载开始确认，已停止保存');
        if (command(packet) === 29) {
          decodeFileTail(packet);
          if (buffer.received !== file.size) throw new FileGap('文件尾已到达，但文件长度不完整');
          io.progress(buffer.received); return data;
        }
        const chunk = decodeFileData(packet, port);
        if (chunk.offset === 0xffffffff) {
          if (buffer.received !== file.size) throw new FileGap(`设备提前结束传输（原因码 ${chunk.endReason ?? '未知'}）`);
          continue; // 完整长度仍需等待同一 session 的文件尾，不能凭特殊空包保存。
        }
        if (!chunk.data.length) throw new Error('设备返回了无内容的录音数据包');
        if (chunk.offset + chunk.data.length > file.size) throw new Error('收到的数据超出录音目录声明的文件长度');
        if (chunk.offset > buffer.received) throw new FileGap('录音数据出现缺口');
        const overlap = Math.min(buffer.received - chunk.offset, chunk.data.length);
        for (let i = 0; i < overlap; i++) if (data[chunk.offset + i] !== chunk.data[i]) throw new Error('重复的录音数据内容不一致，已停止保存');
        if (overlap < chunk.data.length) {
          data.set(chunk.data.subarray(overlap), buffer.received);
          buffer.received += chunk.data.length - overlap;
          io.progress(buffer.received);
        }
      }
    } catch (error) {
      if (io.cancelled()) throw new TransferCancelled();
      const timedOut = error instanceof Error && error.message === '设备响应超时';
      if (!(error instanceof FileGap) && !timedOut) throw error;
      if (++retries > retryLimit) throw new Error('录音传输多次中断，已保留连续接收的部分，请重试继续下载');
      io.progress(buffer.received, `传输中断，正在从已接收位置恢复（${retries}/${retryLimit}）`);
      await io.stop();
    }
  }
}
