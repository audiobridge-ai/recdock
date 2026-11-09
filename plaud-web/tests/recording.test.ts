import test from 'node:test';
import assert from 'node:assert/strict';
import { hex, request, view } from '../src/protocol/bytes.ts';
import { decodeState } from '../src/protocol/status.ts';
import { applyRecordingEvent, decodeRecordingEvent, recordingDuration, recordingFromState } from '../src/protocol/recording.ts';
import type { RecordingStatus } from '../src/protocol/recording.ts';

const unknown: RecordingStatus = { mode: 'unknown' };
function frame(cmd: number, length: number, sessionId = 123) {
  const b = new Uint8Array(length); b.set(request(cmd));
  if (length >= 7) view(b).setUint32(3, sessionId, true);
  return b;
}
function state(code: number, key?: number, sessionId?: number) {
  const b = frame(3, sessionId === undefined ? key === undefined ? 8 : 9 : 15, code);
  if (key !== undefined) b[8] = key;
  if (sessionId !== undefined) { b[10] = 7; view(b).setUint32(11, sessionId, true); }
  return decodeState(b);
}
function push(type: number, sessionId: number, value: number, needAck = true) {
  const b = frame(19, 19);
  view(b).setUint16(3, type, true); view(b).setUint16(5, 0x9876, true); b[7] = +needAck;
  view(b).setUint32(11, sessionId, true); view(b).setUint32(15, value, true);
  return b;
}

test('CMD3 仅4099表示录音，按键码3/4不作为开关机或录音状态', () => {
  assert.equal(recordingFromState(state(4099), unknown, 1).mode, 'recording');
  assert.equal(recordingFromState(state(1, 1), unknown, 1).mode, 'idle');
  for (const key of [0, 3, 4]) assert.equal(recordingFromState(state(0, key), unknown, 1).mode, 'idle');
  assert.equal(recordingFromState(state(2, 2), unknown, 1).mode, 'transferring');
  assert.equal(recordingFromState(state(0), unknown, 1).mode, 'unknown');
  assert.equal(recordingFromState(state(4099, 4, 42), unknown, 1).sessionId, 42);
  assert.equal(recordingFromState(state(4099), unknown, 1).durationMs, undefined);
});

test('明确暂停不会被同session的CMD3冲掉，设备不再持有该session或换session才清除', () => {
  const paused: RecordingStatus = { mode: 'paused', sessionId: 42, durationMs: 5000, durationUpdatedAt: 100 };
  for (const code of [0, 4099]) {
    const next = recordingFromState(state(code, 1, 42), paused, 2000);
    assert.equal(next.mode, 'paused'); assert.equal(recordingDuration(next, 9000), 5000);
  }
  assert.equal(recordingFromState(state(4099, 1, 43), paused, 2000).mode, 'recording');
  assert.equal(recordingFromState(state(4099, 1, 43), paused, 2000).durationMs, undefined);
  assert.equal(recordingFromState(state(0, 1, 0), paused, 2000).mode, 'idle');
  assert.equal(recordingFromState(state(0), paused, 2000).mode, 'unknown');
});

test('时长和新文件推送使用11字节头，ACK保留16位事件类型及序号', () => {
  const duration = decodeRecordingEvent(push(1, 0xfedcba98, 0xffffffff), '888');
  assert.deepEqual(duration.event, { kind: 'duration', sessionId: 0xfedcba98, durationMs: 0xffffffff });
  assert.equal(hex(duration.ack!), '01130001007698');
  assert.deepEqual(decodeRecordingEvent(push(3, 99, 600, false), '888'), { event: { kind: 'new-file', sessionId: 99, fileSize: 600 } });
  const unsupported = push(0x1234, 99, 0).slice(0, 11);
  assert.deepEqual(decodeRecordingEvent(unsupported, '888'), { ack: Uint8Array.of(1, 19, 0, 0x34, 0x12, 0x76, 0x98) });
  unsupported[7] = 0;
  assert.deepEqual(decodeRecordingEvent(unsupported, '888'), {});
});

test('开始和恢复只接受成功状态，开始status4有session也按App视为已有录音', () => {
  const start = frame(20, 13); start[12] = 7;
  assert.deepEqual(decodeRecordingEvent(start, '888').event, { kind: 'start', sessionId: 123, scene: 7 });
  start[11] = 4;
  assert.equal(decodeRecordingEvent(start, '888').event?.kind, 'start');
  view(start).setUint32(3, 0, true);
  assert.deepEqual(decodeRecordingEvent(start, '888'), {});
  start[11] = 13;
  assert.deepEqual(decodeRecordingEvent(start, '888'), {});
  const resume = frame(22, 17); resume[12] = 1;
  assert.deepEqual(decodeRecordingEvent(resume, '888').event, { kind: 'resume', sessionId: 123, scene: 1 });
  resume[11] = 4;
  assert.deepEqual(decodeRecordingEvent(resume, '888'), {});
  const shortResume = frame(22, 13); shortResume[12] = 7;
  assert.equal(decodeRecordingEvent(shortResume, '888').event?.scene, undefined);
});

test('暂停按860型号SN选择布局，普通Note不会把文件大小字节误读为失败状态', () => {
  const pause = frame(21, 13); pause[8] = 1; view(pause).setUint32(9, 0x12345678, true);
  assert.deepEqual(decodeRecordingEvent(pause, '88800123').event, { kind: 'pause', sessionId: 123, fileSize: 0x12345678 });
  assert.deepEqual(decodeRecordingEvent(pause, '86000123'), {});
  pause[11] = 0;
  assert.deepEqual(decodeRecordingEvent(pause, '86000123').event, { kind: 'pause', sessionId: 123 });
});

test('停止响应接受旧短布局并保留可选文件大小', () => {
  assert.deepEqual(decodeRecordingEvent(frame(23, 8), '').event, { kind: 'stop', sessionId: 123 });
  const stop = frame(23, 13); view(stop).setUint32(9, 64000, true);
  assert.deepEqual(decodeRecordingEvent(stop, '').event, { kind: 'stop', sessionId: 123, fileSize: 64000 });
});

test('已知命令短包明确报错，未知命令忽略，支持非零byteOffset视图', () => {
  for (const cmd of [19, 20, 21, 22, 23]) {
    const minimum = cmd === 19 ? 11 : cmd === 21 ? 13 : cmd === 23 ? 8 : 12;
    for (let n = 3; n < minimum; n++) assert.throws(() => decodeRecordingEvent(frame(cmd, n), '860'), /过短/);
  }
  for (let n = 0; n < 3; n++) assert.throws(() => decodeRecordingEvent(new Uint8Array(n), ''), /过短/);
  for (const kind of [1, 3]) assert.throws(() => decodeRecordingEvent(push(kind, 1, 2).slice(0, 18), ''), /过短/);
  assert.deepEqual(decodeRecordingEvent(request(99), ''), {});
  const wrapped = new Uint8Array(24); wrapped.set(push(1, 42, 3000, false), 3);
  assert.equal(decodeRecordingEvent(wrapped.subarray(3, 22), '').event?.durationMs, 3000);
});

test('以设备时长平滑计时，暂停冻结、恢复续计、停止冻结，不伪造未知时长', () => {
  let status = applyRecordingEvent(unknown, { kind: 'start', sessionId: 42 }, 1000);
  assert.equal(recordingDuration(status, 2000), undefined);
  status = applyRecordingEvent(status, { kind: 'duration', sessionId: 42, durationMs: 5000 }, 2000);
  assert.equal(recordingDuration(status, 3000), 6000);
  assert.equal(recordingDuration(status, 1000), 5000, '本地时间回退不产生负增量');
  status = applyRecordingEvent(status, { kind: 'pause', sessionId: 42 }, 3500);
  assert.equal(status.mode, 'paused'); assert.equal(recordingDuration(status, 9000), 6500);
  status = applyRecordingEvent(status, { kind: 'duration', sessionId: 42, durationMs: 6400 }, 9100);
  assert.equal(status.mode, 'paused'); assert.equal(recordingDuration(status, 9900), 6400);
  status = applyRecordingEvent(status, { kind: 'resume', sessionId: 42 }, 10000);
  assert.equal(recordingDuration(status, 11000), 7400);
  status = applyRecordingEvent(status, { kind: 'stop', sessionId: 0 }, 12000);
  assert.equal(status.mode, 'idle'); assert.equal(status.sessionId, 42);
  assert.equal(recordingDuration(status, 20000), 8400);
});

test('旧session时长/停止不覆盖活动session，停止后迟到时长不能复活', () => {
  const current: RecordingStatus = { mode: 'recording', sessionId: 42, durationMs: 1000, durationUpdatedAt: 100 };
  assert.equal(applyRecordingEvent(current, { kind: 'duration', sessionId: 41, durationMs: 9000 }, 200), current);
  assert.equal(applyRecordingEvent(current, { kind: 'stop', sessionId: 41 }, 200), current);
  const stopped = applyRecordingEvent(current, { kind: 'stop', sessionId: 42 }, 200);
  assert.equal(applyRecordingEvent(stopped, { kind: 'duration', sessionId: 42, durationMs: 9000 }, 300), stopped);
  const refreshed = recordingFromState(state(0, 0, 0), stopped, 400);
  assert.equal(applyRecordingEvent(refreshed, { kind: 'duration', sessionId: 42, durationMs: 9000 }, 500), refreshed);
  const shortStatus = recordingFromState(state(0), stopped, 400);
  assert.equal(shortStatus.mode, 'unknown');
  assert.equal(applyRecordingEvent(shortStatus, { kind: 'duration', sessionId: 42, durationMs: 9000 }, 500), shortStatus);
  const next = applyRecordingEvent(stopped, { kind: 'start', sessionId: 43 }, 400);
  assert.equal(next.mode, 'recording'); assert.equal(next.durationMs, undefined);
});

test('时长推送可补回漏掉的开始事件，新文件事件不会结束录音', () => {
  const recovered = applyRecordingEvent(unknown, { kind: 'duration', sessionId: 42, durationMs: 500 }, 1000);
  assert.equal(recovered.mode, 'recording'); assert.equal(recovered.sessionId, 42);
  assert.equal(applyRecordingEvent(recovered, { kind: 'new-file', sessionId: 42, fileSize: 3000 }, 1500), recovered);
  assert.equal(applyRecordingEvent(unknown, { kind: 'duration', sessionId: 0, durationMs: 500 }, 1000), unknown);
  assert.equal(applyRecordingEvent(unknown, { kind: 'duration', sessionId: 42 }, 1000), unknown);
});
