import { initializeLocale } from '../src/i18n/index.ts';
initializeLocale('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { canSaveCompletedDownload, downloadActionLabel, formatRecordingDuration, recordingFilesBlocked,
  recordingFilesHint, recordingFileView, recordingView, transferView } from '../src/ui/recordings.ts';
import type { TransferStatus } from '../src/ui/recordings.ts';

test('录音时长只平滑设备提供的数值，暂停保留时长且未知不伪造零秒', () => {
  assert.equal(recordingView({ mode: 'recording' }, 9000).duration, '—');
  assert.equal(recordingView({ mode: 'recording', durationMs: 5100, durationUpdatedAt: 1000 }, 4000).duration, '00:08');
  assert.equal(recordingView({ mode: 'paused', durationMs: 5100, durationUpdatedAt: 1000 }, 4000).duration, '00:05');
  assert.equal(formatRecordingDuration(3_661_999), '01:01:01');
  assert.equal(formatRecordingDuration(-1), '—');
  assert.equal(formatRecordingDuration(Number.NaN), '—');
});

test('录音和暂停暂缓文件操作，未知状态可由 controller 预检', () => {
  for (const mode of ['recording', 'paused', 'transferring'] as const) assert.equal(recordingFilesBlocked({ mode }), true);
  for (const mode of ['unknown', 'idle'] as const) assert.equal(recordingFilesBlocked({ mode }), false);
  assert.match(recordingFilesHint({ mode: 'paused' }, true), /暂缓/);
  assert.match(recordingFilesHint({ mode: 'unknown' }, true), /先检查设备是否空闲/);
  assert.match(recordingFilesHint({ mode: 'idle' }, false), /认证完成/);
});

test('文件和录音展示使用会话 ID 原值，不推算日期且保留零值字段', () => {
  assert.deepEqual(recordingFileView({ sessionId: 1_700_000_000, size: 2048, scene: 0, attribute: 0 }), {
    id: '1700000000', metadata: '场景 0 · 属性 0',
  });
  assert.deepEqual(recordingFileView({ sessionId: 42, size: 2048 }), { id: '42', metadata: '' });
  const recording = recordingView({ mode: 'idle', sessionId: 42, scene: 0 }, 0);
  assert.equal(recording.session, '42'); assert.equal(recording.scene, '0');
});

test('仅同一会话且存在已收数据才展示续传，错误零进度可重试', () => {
  const base: TransferStatus = { phase: 'paused', sessionId: 42, received: 3, total: 10 };
  for (const phase of ['paused', 'cancelled', 'error'] as const) assert.equal(downloadActionLabel(42, { ...base, phase }), '继续下载');
  assert.equal(downloadActionLabel(43, base), '下载');
  assert.equal(downloadActionLabel(42, { ...base, phase: 'error', received: 0 }), '重试');
  assert.equal(downloadActionLabel(42, { ...base, phase: 'downloading' }), '下载中…');
});

test('进度显示有界，失败/断线提示保留原因及重试续传说明', () => {
  const base: TransferStatus = { phase: 'error', sessionId: 42, received: 12, total: 10, error: '校验失败', notice: '原始格式' };
  const view = transferView(base);
  assert.equal(view.percent, 100); assert.equal(view.received, 12);
  assert.match(view.detail, /校验失败/); assert.match(view.detail, /原始格式/); assert.match(view.detail, /重试同一文件/);
  assert.match(transferView({ ...base, phase: 'paused' }).detail, /重新连接同一设备/);
  assert.equal(transferView({ ...base, total: 0 }).percent, 0);
  assert.equal(transferView({ ...base, total: Number.NaN, received: -2 }).received, 0);
});

test('下载忙碌时仍可取消，取消处理中不重复发送取消', () => {
  const base: TransferStatus = { phase: 'downloading', received: 1, total: 10 };
  assert.equal(transferView(base).canCancel, true);
  assert.equal(transferView({ ...base, phase: 'cancelling' }).canCancel, false);
  assert.equal(transferView({ ...base, phase: 'cancelling' }).cancelling, true);
  assert.equal(transferView({ ...base, phase: 'complete' }).canCancel, false);
});

test('浏览器仅保存同一会话的完整结果，取消和部分数据均不保存', () => {
  const base: TransferStatus = { phase: 'complete', sessionId: 42, received: 10, total: 10 };
  assert.equal(canSaveCompletedDownload(base, 42), true);
  assert.equal(canSaveCompletedDownload(base, 43), false);
  assert.equal(canSaveCompletedDownload({ ...base, received: 9 }, 42), false);
  assert.equal(canSaveCompletedDownload({ ...base, received: 11 }, 42), false);
  assert.equal(canSaveCompletedDownload({ ...base, received: -1, total: -1 }, 42), false);
  for (const phase of ['idle', 'downloading', 'cancelling', 'paused', 'cancelled', 'error'] as const) {
    assert.equal(canSaveCompletedDownload({ ...base, phase }, 42), false);
  }
});
