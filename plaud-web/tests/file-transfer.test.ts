import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameInbox } from '../src/ble/inbox.ts';
import { FileStopError, TransferCancelled, receiveRecording, receiveRecordingList } from '../src/app/file-transfer.ts';
import type { FileIO, TransferBuffer } from '../src/app/file-transfer.ts';
import type { RecordingFile } from '../src/protocol/files.ts';

// Fixtures deliberately build wire bytes without using the production request/response codecs.
function control(cmd: number, length: number) {
  const b = new Uint8Array(length); b[0] = 1; new DataView(b.buffer).setUint16(1, cmd, true); return b;
}
function directory(requestId: number, total: number, index: number, files: RecordingFile[], port = 20) {
  const width = port === 1 ? 8 : port <= 6 ? 9 : 10;
  const b = control(26, 11 + files.length * width), fields = new DataView(b.buffer);
  fields.setUint32(3, requestId, true); fields.setUint16(7, total, true); fields.setUint16(9, index, true);
  files.forEach((file, i) => {
    const at = 11 + i * width;
    fields.setUint32(at, file.sessionId, true); fields.setUint32(at + 4, file.size, true);
    if (width === 9) b[at + 8] = file.attribute ?? 0;
    if (width === 10) { b[at + 8] = file.scene ?? 0; b[at + 9] = file.attribute ?? 0; }
  });
  return b;
}
function head(sessionId: number, status = 0) {
  const b = control(28, 8); new DataView(b.buffer).setUint32(3, sessionId, true); b[7] = status; return b;
}
function chunk(sessionId: number, offset: number, bytes: number[], port = 20) {
  const at = port >= 7 ? 5 : 1, b = new Uint8Array(at + 5 + bytes.length), fields = new DataView(b.buffer);
  b[0] = 2;
  if (port >= 7) fields.setUint32(1, sessionId, true);
  fields.setUint32(at, offset, true); b[at + 4] = bytes.length; b.set(bytes, at + 5); return b;
}
function tail(sessionId: number) {
  const b = control(29, 9), fields = new DataView(b.buffer);
  fields.setUint32(3, sessionId, true); fields.setUint16(7, 0x29b1, true); return b;
}
function ended(sessionId: number, reason = 0) {
  const b = chunk(sessionId, 0xffffffff, [reason]); b[9] = 0; return b;
}
function transfer(size: number, sessionId = 0x12345678): TransferBuffer {
  return { file: { sessionId, size, scene: 1 }, data: new Uint8Array(size), received: 0 };
}
const wireCommand = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(1, true);
const uint32At = (b: Uint8Array, offset: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(offset, true);

class FakeIO implements FileIO {
  inbox = new FrameInbox(256);
  sent: Uint8Array[] = [];
  order: string[] = [];
  notices: { received: number; notice?: string }[] = [];
  stopCalls = 0;
  cancelledFlag = false;
  onSend?: (packet: Uint8Array, attempt: number) => void;
  onStop?: () => void;
  onProgress?: (received: number) => void;
  afterReceive?: (packet: Uint8Array) => void;
  failReceive = false;
  push(...packets: Uint8Array[]) { for (const packet of packets) this.inbox.push(packet); }
  async send(packet: Uint8Array) {
    this.sent.push(packet.slice()); this.order.push(`send:${wireCommand(packet)}:${uint32At(packet, 7)}`);
    this.onSend?.(packet, this.sent.length);
  }
  async receive(predicate: (packet: Uint8Array) => boolean, timeout: number) {
    if (this.failReceive) throw new Error('设备响应超时');
    const packet = await this.inbox.next(predicate, Math.min(timeout, 10));
    this.afterReceive?.(packet); return packet;
  }
  async stop() {
    this.stopCalls++; this.order.push('stop'); this.onStop?.(); this.inbox.clear();
  }
  cancelled() { return this.cancelledFlag; }
  progress(received: number, notice?: string) {
    this.notices.push({ received, notice }); this.onProgress?.(received);
  }
}

const entries: RecordingFile[] = [
  { sessionId: 100, size: 6, scene: 1, attribute: 2 },
  { sessionId: 101, size: 8, scene: 7, attribute: 3 },
  { sessionId: 102, size: 2, scene: 1, attribute: 0 },
];

test('目录按requestId隔离，合并多包并容忍一致的重复页', async () => {
  const io = new FakeIO(), id = 0xfedcba98, unrelated = directory(id - 1, 1, 0, entries.slice(0, 1));
  io.onSend = () => io.push(unrelated, directory(id, 3, 0, entries.slice(0, 2)),
    directory(id, 3, 0, entries.slice(0, 2)), directory(id, 3, 2, entries.slice(2)));
  assert.deepEqual(await receiveRecordingList(io, id, 20, 5), entries);
  assert.deepEqual(Array.from(io.sent[0]), [1, 26, 0, 0x98, 0xba, 0xdc, 0xfe, 0, 0, 0, 0, 0]);
  assert.deepEqual(await io.inbox.next(() => true, 5), unrelated, '其他requestId的包未被本次目录消费');
});

test('空目录合法，其他requestId不能完成当前目录请求', async () => {
  const empty = new FakeIO(); empty.onSend = () => empty.push(directory(7, 0, 0, []));
  assert.deepEqual(await receiveRecordingList(empty, 7, 20, 5), []);
  const wrong = new FakeIO(); wrong.onSend = () => wrong.push(directory(8, 0, 0, []));
  await assert.rejects(receiveRecordingList(wrong, 7, 20, 1), /响应超时/);
});

test('目录拒绝前跳缺页、重复页内容冲突、读取期间总数变化和重复录音编号', async () => {
  const cases: [Uint8Array[], RegExp][] = [
    [[directory(7, 3, 2, entries.slice(2))], /缺少部分条目/],
    [[directory(7, 2, 0, entries.slice(0, 1)), directory(7, 2, 0, [{ ...entries[0], size: 99 }])], /冲突条目/],
    [[directory(7, 2, 0, entries.slice(0, 1)), directory(7, 3, 1, entries.slice(1))], /读取期间发生变化/],
    [[directory(7, 2, 0, [entries[0], entries[0]])], /重复的录音编号/],
  ];
  for (const [packets, error] of cases) {
    const io = new FakeIO(); io.onSend = () => io.push(...packets);
    await assert.rejects(receiveRecordingList(io, 7, 20, 5), error);
  }
});

test('下载只有同session的head、连续type02数据和tail齐全才返回完整缓冲区', async () => {
  const io = new FakeIO(), buffer = transfer(6), sid = buffer.file.sessionId, other = sid + 1;
  const unrelated = [head(other), chunk(other, 0, [9, 9, 9, 9, 9, 9]), tail(other)];
  io.onSend = () => io.push(...unrelated, head(sid), chunk(sid, 0, [1, 2]), chunk(sid, 2, [3, 4, 5, 6]), tail(sid));
  assert.equal(await receiveRecording(io, buffer, 20, 5), buffer.data);
  assert.deepEqual(Array.from(buffer.data), [1, 2, 3, 4, 5, 6]); assert.equal(buffer.received, 6);
  assert.equal(io.sent.length, 1); assert.equal(uint32At(io.sent[0], 3), sid);
  assert.equal(uint32At(io.sent[0], 7), 0); assert.equal(uint32At(io.sent[0], 11), 0, 'App下载范围end=0');
  for (const packet of unrelated) assert.deepEqual(await io.inbox.next(() => true, 5), packet);
});

test('旧协议无session的数据布局仍需匹配控制head/tail', async () => {
  const io = new FakeIO(), buffer = transfer(3), sid = buffer.file.sessionId;
  io.onSend = () => io.push(head(sid), chunk(sid, 0, [7, 8, 9], 6), tail(sid));
  assert.deepEqual(await receiveRecording(io, buffer, 6, 5), Uint8Array.of(7, 8, 9));
});

test('数据不能跳过head确认，head拒绝不自动重发下载', async () => {
  for (const [packets, error] of [
    [[chunk(123, 0, [1])], /尚未收到下载开始确认/],
    [[head(123, 13)], /状态码 13/],
  ] as const) {
    const io = new FakeIO(); io.onSend = () => io.push(...packets);
    await assert.rejects(receiveRecording(io, transfer(1, 123), 20, 5), error);
    assert.equal(io.sent.length, 1); assert.equal(io.stopCalls, 0);
  }
});

test('一致重叠/完整重复数据不重复计数，部分重叠只追加未接收后缀', async () => {
  const io = new FakeIO(), buffer = transfer(6), sid = buffer.file.sessionId;
  io.onSend = () => io.push(head(sid), chunk(sid, 0, [1, 2, 3, 4]), chunk(sid, 0, [1, 2, 3, 4]),
    chunk(sid, 2, [3, 4, 5, 6]), tail(sid));
  assert.deepEqual(await receiveRecording(io, buffer, 20, 5), Uint8Array.of(1, 2, 3, 4, 5, 6));
  assert.deepEqual(io.notices.map(n => n.received), [4, 6, 6]); assert.equal(io.stopCalls, 0);
});

test('重叠内容冲突以及超出目录长度的数据均硬失败，不返回或自动重试', async () => {
  const conflict = new FakeIO(), buffer = transfer(6), sid = buffer.file.sessionId;
  conflict.onSend = () => conflict.push(head(sid), chunk(sid, 0, [1, 2, 3, 4]), chunk(sid, 2, [99, 4, 5, 6]), tail(sid));
  await assert.rejects(receiveRecording(conflict, buffer, 20, 5), /内容不一致/);
  assert.equal(buffer.received, 4); assert.deepEqual(Array.from(buffer.data), [1, 2, 3, 4, 0, 0]);
  assert.equal(conflict.sent.length, 1); assert.equal(conflict.stopCalls, 0);
  const oversized = new FakeIO(); oversized.onSend = () => oversized.push(head(sid), chunk(sid, 0, [1, 2, 3]));
  await assert.rejects(receiveRecording(oversized, transfer(2), 20, 5), /超出.*文件长度/);
  assert.equal(oversized.sent.length, 1);
});

test('出现gap先确认stop，再从已连续收到的位置恢复，丢弃gap后的旧队列', async () => {
  const io = new FakeIO(), buffer = transfer(6), sid = buffer.file.sessionId;
  io.onSend = (_packet, attempt) => {
    if (attempt === 1) io.push(head(sid), chunk(sid, 0, [1, 2]), chunk(sid, 4, [5, 6]), tail(sid));
    else io.push(head(sid), chunk(sid, 2, [3, 4, 5, 6]), tail(sid));
  };
  io.onStop = () => assert.equal(buffer.received, 2);
  assert.deepEqual(await receiveRecording(io, buffer, 20, 5), Uint8Array.of(1, 2, 3, 4, 5, 6));
  assert.deepEqual(io.order, ['send:28:0', 'stop', 'send:28:2']);
  assert.equal(uint32At(io.sent[1], 11), 0); assert.equal(io.stopCalls, 1);
  assert.ok(io.notices.some(n => n.received === 2 && /恢复/.test(n.notice ?? '')));
});

test('手动继续下载复用已收字节，初始请求从buffer.received而非0开始', async () => {
  const io = new FakeIO(), buffer = transfer(4), sid = buffer.file.sessionId;
  buffer.received = 2; buffer.data.set([10, 20]);
  io.onSend = () => io.push(head(sid), chunk(sid, 2, [30, 40]), tail(sid));
  assert.deepEqual(await receiveRecording(io, buffer, 20, 5), Uint8Array.of(10, 20, 30, 40));
  assert.equal(uint32At(io.sent[0], 7), 2);
});

test('超时重试次数有限，retryLimit=2最多三次请求和两次停止', async () => {
  const io = new FakeIO(), buffer = transfer(4); io.failReceive = true;
  await assert.rejects(receiveRecording(io, buffer, 20, 1, 2), /多次中断/);
  assert.equal(io.sent.length, 3); assert.equal(io.stopCalls, 2); assert.equal(buffer.received, 0);
  assert.deepEqual(io.order, ['send:28:0', 'stop', 'send:28:0', 'stop', 'send:28:0']);
});

test('不完整tail只能触发有限恢复，不能把零填充的缺失部分当完整文件返回', async () => {
  const io = new FakeIO(), buffer = transfer(6), sid = buffer.file.sessionId;
  io.onSend = (_packet, attempt) => {
    if (attempt === 1) io.push(head(sid), chunk(sid, 0, [1, 2]), tail(sid));
    else io.push(head(sid), tail(sid));
  };
  await assert.rejects(receiveRecording(io, buffer, 20, 5, 1), /多次中断/);
  assert.equal(buffer.received, 2); assert.equal(io.sent.length, 2); assert.equal(io.stopCalls, 1);
  assert.equal(uint32At(io.sent[1], 7), 2);
});

test('完整字节和特殊结束包仍不能替代同session的tail验收', async () => {
  const io = new FakeIO(), buffer = transfer(2), sid = buffer.file.sessionId;
  io.onSend = () => io.push(head(sid), chunk(sid, 0, [1, 2]), ended(sid), tail(sid + 1));
  await assert.rejects(receiveRecording(io, buffer, 20, 1, 0), /多次中断/);
  assert.equal(buffer.received, 2); assert.equal(io.sent.length, 1);
});

test('传输前取消不发请求；传输中取消保留连续数据但不返回bytes', async () => {
  const before = new FakeIO(); before.cancelledFlag = true;
  await assert.rejects(receiveRecording(before, transfer(4), 20, 5), TransferCancelled);
  assert.equal(before.sent.length, 0);
  const during = new FakeIO(), buffer = transfer(4), sid = buffer.file.sessionId;
  during.onSend = () => during.push(head(sid), chunk(sid, 0, [1, 2]), chunk(sid, 2, [3, 4]), tail(sid));
  during.onProgress = () => { during.cancelledFlag = true; };
  await assert.rejects(receiveRecording(during, buffer, 20, 5), TransferCancelled);
  assert.equal(buffer.received, 2); assert.deepEqual(Array.from(buffer.data), [1, 2, 0, 0]);
  assert.equal(during.sent.length, 1); assert.equal(during.stopCalls, 0);
});

test('在tail送达的同一时刻取消仍拒绝返回完整bytes', async () => {
  const io = new FakeIO(), buffer = transfer(2), sid = buffer.file.sessionId;
  io.onSend = () => io.push(head(sid), chunk(sid, 0, [1, 2]), tail(sid));
  io.afterReceive = packet => { if (packet[0] === 1 && wireCommand(packet) === 29) io.cancelledFlag = true; };
  await assert.rejects(receiveRecording(io, buffer, 20, 5), TransferCancelled);
  assert.equal(buffer.received, 2);
});

test('stop失败直接上抛，不盲目发送第二次下载或清除已接收数据', async () => {
  const io = new FakeIO(), buffer = transfer(6), sid = buffer.file.sessionId;
  io.onSend = () => io.push(head(sid), chunk(sid, 0, [1, 2]), chunk(sid, 4, [5, 6]));
  const failure = new FileStopError('无法确认设备已经停止'); io.onStop = () => { throw failure; };
  await assert.rejects(receiveRecording(io, buffer, 20, 5), error => error === failure);
  assert.equal(io.sent.length, 1); assert.equal(io.stopCalls, 1); assert.equal(buffer.received, 2);
  assert.deepEqual(io.order, ['send:28:0', 'stop']);
});
