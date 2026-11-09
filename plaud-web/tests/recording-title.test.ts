import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceRecordingDate, deviceRecordingTitle, recordingTitle } from '../src/library/recording-title.ts';

const sessionId = 1793762511;

test('设备秒级时间戳按指定时区显示，跨日时保留当地日期', () => {
  assert.equal(deviceRecordingDate(sessionId, 'Asia/Shanghai'), '2026-11-04 11:21:51');
  assert.equal(deviceRecordingDate(sessionId, 'UTC'), '2026-11-04 03:21:51');
  assert.equal(deviceRecordingDate(sessionId, 'America/Los_Angeles'), '2026-11-03 19:21:51');
});

test('只格式化设备默认标题，自定义标题与本机文件名保留', () => {
  const source = { kind: 'ble' as const, deviceId: 'device-test', sessionId };
  for (const title of [`plaud-${sessionId}`, `设备录音 ${sessionId}`, String(sessionId)]) assert.equal(recordingTitle({ title, source }, 'Asia/Shanghai'), '2026-11-04 11:21:51');
  assert.equal(recordingTitle({ title: '项目例会', source }, 'Asia/Shanghai'), '项目例会');
  assert.equal(recordingTitle({ title: `plaud-${sessionId}`, source: { kind: 'import', deviceId: null, sessionId: null } }), `plaud-${sessionId}`);
});

test('计数型或异常文件编号不显示误导性的日期', () => {
  for (const value of [null, 0, 42, -1, NaN, Infinity, sessionId + .5, 0x100000000]) assert.equal(deviceRecordingDate(value), null);
  assert.equal(deviceRecordingTitle(42), '设备录音 42');
  assert.equal(recordingTitle({ title: 'plaud-42', source: { kind: 'ble', deviceId: 'device-test', sessionId: 42 } }), 'plaud-42');
});
