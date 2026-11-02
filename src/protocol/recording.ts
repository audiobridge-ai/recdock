import { command, concat, le16, request, view } from './bytes.ts';
import type { DeviceState } from './status.ts';

export interface RecordingStatus {
  mode: 'unknown' | 'idle' | 'recording' | 'paused' | 'transferring';
  sessionId?: number;
  durationMs?: number;
  durationUpdatedAt?: number;
  updatedAt?: number;
  scene?: number;
  error?: string;
}

export interface RecordingEvent {
  kind: 'start' | 'pause' | 'resume' | 'stop' | 'duration' | 'new-file';
  sessionId: number;
  durationMs?: number;
  scene?: number;
  fileSize?: number;
}

const positiveSession = (id?: number) => id !== undefined && id > 0 ? id : undefined;
const active = (status: RecordingStatus) => status.mode === 'recording' || status.mode === 'paused';

/** Smooth only a known device duration; unknown duration must stay unknown. */
export function recordingDuration(status: RecordingStatus, now: number): number | undefined {
  if (status.durationMs === undefined || !Number.isFinite(status.durationMs) || status.durationMs < 0) return undefined;
  if (status.mode !== 'recording' || status.durationUpdatedAt === undefined) return status.durationMs;
  return status.durationMs + Math.max(0, now - status.durationUpdatedAt);
}

function transition(previous: RecordingStatus, mode: RecordingStatus['mode'], sessionId: number | undefined,
  scene: number | undefined, now: number): RecordingStatus {
  const sameSession = sessionId === previous.sessionId && (sessionId !== undefined || active(previous));
  const durationMs = sameSession ? recordingDuration(previous, now) : undefined;
  return {
    mode, sessionId, durationMs,
    durationUpdatedAt: durationMs === undefined ? undefined : now,
    updatedAt: now,
    scene: scene ?? (sameSession ? previous.scene : undefined),
  };
}

export function recordingFromState(state: DeviceState, previous: RecordingStatus, now: number): RecordingStatus {
  const stateSession = positiveSession(state.sessionId);
  // CMD3 has no pause bit. Only a matching positive session can preserve an explicit CMD21 pause.
  const keepPause = previous.mode === 'paused' && stateSession !== undefined && stateSession === previous.sessionId;
  const mode = keepPause ? 'paused' : state.stateCode === 4099 ? 'recording'
    : state.keyStateCode === undefined ? 'unknown' : state.keyStateCode === 2 ? 'transferring' : 'idle';
  const sessionId = stateSession ?? ((mode === 'recording' && !active(previous)) ? undefined : previous.sessionId);
  return transition(previous, mode, sessionId, state.scene, now);
}

function minimum(frame: Uint8Array, length: number, cmd: number) {
  if (frame.length < length) throw new Error(`录音命令 ${cmd} 的响应过短，至少需要 ${length} 字节`);
}

/** Parses unsolicited indications. ACKs must use the existing encrypted write path, without awaiting a response. */
export function decodeRecordingEvent(frame: Uint8Array, serialNumber: string): { event?: RecordingEvent; ack?: Uint8Array } {
  if (frame.length < 3) throw new Error('录音消息的控制帧头过短');
  const cmd = command(frame);
  if (cmd === undefined || ![19, 20, 21, 22, 23].includes(cmd)) return {};
  const data = view(frame);
  if (cmd === 19) {
    minimum(frame, 11, cmd);
    const eventType = data.getUint16(3, true), sequence = data.getUint16(5, true);
    const ack = frame[7] === 1 ? concat(request(19), le16(eventType), le16(sequence)) : undefined;
    if (eventType !== 1 && eventType !== 3) return ack ? { ack } : {};
    minimum(frame, 19, cmd);
    const sessionId = data.getUint32(11, true), value = data.getUint32(15, true);
    const event: RecordingEvent = eventType === 1
      ? { kind: 'duration', sessionId, durationMs: value }
      : { kind: 'new-file', sessionId, fileSize: value };
    return ack ? { event, ack } : { event };
  }
  if (cmd === 20 || cmd === 22) {
    minimum(frame, 12, cmd);
    const sessionId = data.getUint32(3, true), status = frame[11];
    // App also reconciles a start with status 4 and a nonzero session as already recording.
    if (status !== 0 && !(cmd === 20 && status === 4 && sessionId > 0)) return {};
    const event: RecordingEvent = { kind: cmd === 20 ? 'start' : 'resume', sessionId };
    if (frame.length >= (cmd === 20 ? 13 : 17)) event.scene = frame[12];
    return { event };
  }
  if (cmd === 21) {
    minimum(frame, 13, cmd);
    const sessionId = data.getUint32(3, true);
    // This is a model/SN distinction in the APK, not a BLE port-version distinction.
    if (serialNumber.startsWith('860')) return frame[11] === 0 ? { event: { kind: 'pause', sessionId } } : {};
    return { event: { kind: 'pause', sessionId, fileSize: data.getUint32(9, true) } };
  }
  minimum(frame, 8, cmd);
  const event: RecordingEvent = { kind: 'stop', sessionId: data.getUint32(3, true) };
  if (frame.length >= 13) event.fileSize = data.getUint32(9, true);
  return { event };
}

export function applyRecordingEvent(previous: RecordingStatus, event: RecordingEvent, now: number): RecordingStatus {
  if (event.kind === 'new-file') return previous; // A new segment does not establish that recording stopped.
  const eventSession = positiveSession(event.sessionId);
  const previousSession = positiveSession(previous.sessionId);
  if (event.kind === 'duration') {
    if (eventSession === undefined || event.durationMs === undefined || !Number.isFinite(event.durationMs) || event.durationMs < 0) return previous;
    if (active(previous) && previousSession !== undefined && previousSession !== eventSession) return previous;
    // Retain the stopped session as a tombstone so a delayed duration push cannot revive it.
    if (!active(previous) && previousSession === eventSession) return previous;
    return {
      mode: previous.mode === 'paused' ? 'paused' : 'recording', sessionId: eventSession,
      durationMs: event.durationMs, durationUpdatedAt: now, updatedAt: now,
      scene: previousSession === eventSession ? previous.scene : undefined,
    };
  }
  if (event.kind !== 'start') {
    if (active(previous) && eventSession !== undefined && previousSession !== undefined && eventSession !== previousSession) return previous;
    if ((event.kind === 'pause' || event.kind === 'resume') && previous.mode === 'idle'
      && eventSession !== undefined && eventSession === previousSession) return previous;
  }
  const sessionId = eventSession ?? (active(previous) || event.kind === 'stop' ? previousSession : undefined);
  const mode = event.kind === 'stop' ? 'idle' : event.kind === 'pause' ? 'paused' : 'recording';
  return transition(previous, mode, sessionId, event.scene, now);
}
