import type { LibraryRecording } from './types.ts';

/** Display contemporary Unix-second IDs as dates; retain counters/unknown IDs. */
export function deviceRecordingDate(sessionId: number | null, timeZone?: string): string | null {
  if (sessionId === null || !Number.isInteger(sessionId) || sessionId < 946684800 || sessionId > 0xffffffff) return null;
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(sessionId * 1000));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

export function deviceRecordingTitle(sessionId: number, timeZone?: string): string {
  return deviceRecordingDate(sessionId, timeZone) ?? `设备录音 ${sessionId}`;
}

export function recordingTitle(recording: Pick<LibraryRecording, 'title' | 'source'>, timeZone?: string): string {
  const { title, source } = recording;
  if (source.kind !== 'ble' || source.sessionId === null) return title;
  const defaults = [`plaud-${source.sessionId}`, `设备录音 ${source.sessionId}`, String(source.sessionId)];
  return defaults.includes(title) ? deviceRecordingDate(source.sessionId, timeZone) ?? title : title;
}
