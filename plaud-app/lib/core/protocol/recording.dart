import 'dart:typed_data';
import '../failure.dart';
import 'bytes.dart';
import 'status.dart';

class RecordingStatus {
  const RecordingStatus(
      {this.mode = 'unknown',
      this.sessionId,
      this.durationMs,
      this.updatedAt,
      this.scene});
  final String mode;
  final int? sessionId, durationMs, updatedAt, scene;
  bool get active => mode == 'recording' || mode == 'paused';
  int? durationAt(int now) => durationMs == null
      ? null
      : mode == 'recording' && updatedAt != null
          ? durationMs! + (now - updatedAt!).clamp(0, 1 << 62)
          : durationMs;
  RecordingStatus transition(
      String next, int? session, int? nextScene, int now) {
    final same = session == sessionId && (session != null || active);
    return RecordingStatus(
        mode: next,
        sessionId: session,
        durationMs: same ? durationAt(now) : null,
        updatedAt: now,
        scene: nextScene ?? (same ? scene : null));
  }
}

class RecordingEvent {
  const RecordingEvent(this.kind, this.sessionId,
      {this.durationMs, this.scene, this.fileSize});
  final String kind;
  final int sessionId;
  final int? durationMs, scene, fileSize;
}

RecordingStatus recordingFromState(
    DeviceState state, RecordingStatus previous, int now) {
  final session =
      state.sessionId != null && state.sessionId! > 0 ? state.sessionId : null;
  final keepPause = previous.mode == 'paused' &&
      session != null &&
      session == previous.sessionId;
  final mode = keepPause
      ? 'paused'
      : state.stateCode == 4099
          ? 'recording'
          : state.keyStateCode == null
              ? 'unknown'
              : state.keyStateCode == 2
                  ? 'transferring'
                  : 'idle';
  return previous.transition(
      mode,
      session ??
          ((mode == 'recording' && !previous.active)
              ? null
              : previous.sessionId),
      state.scene,
      now);
}

({RecordingEvent? event, Uint8List? ack}) decodeRecordingEvent(
    Uint8List frame, String serial) {
  void minimum(int length) {
    if (frame.length < length) {
      throw const AppFailure('DEVICE_PACKET_INVALID', '录音状态响应过短');
    }
  }

  minimum(3);
  final cmd = commandOf(frame), data = fields(frame);
  if (![19, 20, 21, 22, 23].contains(cmd)) return (event: null, ack: null);
  if (cmd == 19) {
    minimum(11);
    final type = data.getUint16(3, Endian.little);
    final ack = frame[7] == 1
        ? Uint8List.fromList([1, 19, 0, ...frame.sublist(3, 7)])
        : null;
    if (type != 1 && type != 3) return (event: null, ack: ack);
    minimum(19);
    final session = data.getUint32(11, Endian.little),
        value = data.getUint32(15, Endian.little);
    return (
      event: RecordingEvent(type == 1 ? 'duration' : 'new-file', session,
          durationMs: type == 1 ? value : null,
          fileSize: type == 3 ? value : null),
      ack: ack
    );
  }
  if (cmd == 20 || cmd == 22) {
    minimum(12);
    final session = data.getUint32(3, Endian.little), status = frame[11];
    if (status != 0 && !(cmd == 20 && status == 4 && session > 0)) {
      return (event: null, ack: null);
    }
    return (
      event: RecordingEvent(cmd == 20 ? 'start' : 'resume', session,
          scene: frame.length >= (cmd == 20 ? 13 : 17) ? frame[12] : null),
      ack: null
    );
  }
  if (cmd == 21) {
    minimum(13);
    final session = data.getUint32(3, Endian.little);
    if (serial.startsWith('860')) {
      return (
        event: frame[11] == 0 ? RecordingEvent('pause', session) : null,
        ack: null
      );
    }
    return (
      event: RecordingEvent('pause', session,
          fileSize: data.getUint32(9, Endian.little)),
      ack: null
    );
  }
  minimum(8);
  return (
    event: RecordingEvent('stop', data.getUint32(3, Endian.little),
        fileSize: frame.length >= 13 ? data.getUint32(9, Endian.little) : null),
    ack: null
  );
}

RecordingStatus applyRecordingEvent(
    RecordingStatus previous, RecordingEvent event, int now) {
  if (event.kind == 'new-file') return previous;
  final session = event.sessionId > 0 ? event.sessionId : null;
  final prior = previous.sessionId != null && previous.sessionId! > 0
      ? previous.sessionId
      : null;
  if (event.kind == 'duration') {
    if (session == null ||
        event.durationMs == null ||
        event.durationMs! < 0 ||
        (previous.active && prior != null && prior != session) ||
        (!previous.active && prior == session)) {
      return previous;
    }
    return RecordingStatus(
        mode: previous.mode == 'paused' ? 'paused' : 'recording',
        sessionId: session,
        durationMs: event.durationMs,
        updatedAt: now,
        scene: prior == session ? previous.scene : null);
  }
  if (event.kind != 'start') {
    if (previous.active &&
        session != null &&
        prior != null &&
        session != prior) {
      return previous;
    }
    if ((event.kind == 'pause' || event.kind == 'resume') &&
        previous.mode == 'idle' &&
        session != null &&
        session == prior) {
      return previous;
    }
  }
  return previous.transition(
      event.kind == 'stop'
          ? 'idle'
          : event.kind == 'pause'
              ? 'paused'
              : 'recording',
      session ?? ((previous.active || event.kind == 'stop') ? prior : null),
      event.scene,
      now);
}
