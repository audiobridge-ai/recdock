import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import '../../features/auth/models.dart';
import '../crypto/protocol_crypto.dart';
import '../failure.dart';
import '../protocol/bytes.dart';
import '../protocol/files.dart';
import '../protocol/recording.dart';
import '../protocol/status.dart';
import 'authenticate.dart';
import 'packet_io.dart';

class DeviceController {
  void Function()? onChanged;
  String phase = 'disconnected', stage = '未连接设备';
  String? error;
  bool busy = false;
  DeviceCredentials? credentials;
  DeviceState? state;
  ({int level, bool charging})? battery;
  ({BigInt free, BigInt total, BigInt? duration})? storage;
  RecordingStatus recording = const RecordingStatus();
  List<RecordingFile> files = const [];
  int? audioChannels;
  bool? isOggAudio;
  int received = 0, total = 0;
  int? downloadingSession;
  String transferPhase = 'idle';
  String? transferNotice;
  bool get connected => phase == 'ready';

  DeviceLink? _link;
  StreamSubscription<Uint8List>? _subscription;
  PacketInbox _raw = PacketInbox(), _business = PacketInbox();
  SessionCodec? _codec;
  Future<void> _writes = Future.value();
  final _timedOut = <int>{};
  int _epoch = 0, _requestId = 0;
  bool _cancelled = false, _disposed = false;
  bool _foreground = true;
  void setForeground(bool value) {
    _foreground = value;
    if (!value) {
      cancelDownload();
    } else if (connected && !busy) {
      unawaited(refreshStatus().catchError((Object _) {}));
    }
  }

  ({
    String identity,
    int session,
    int size,
    String path,
    int received
  })? _checkpoint;
  Timer? _poll;
  int _lastProgress = 0;
  void _notify() {
    if (!_disposed) onChanged?.call();
  }

  void _check(int epoch) {
    if (_disposed || epoch != _epoch || _link == null) {
      throw const AppFailure('DEVICE_DISCONNECTED', '设备连接已改变');
    }
  }

  Future<void> _send(Uint8List packet, int epoch, {bool raw = false}) {
    final operation = _writes.then((_) async {
      _check(epoch);
      await _link!.write(raw ? packet : _codec!.encode(packet));
      _check(epoch);
    });
    _writes = operation.catchError((Object _) {});
    return operation;
  }

  Future<void> connect(DeviceLink link, DeviceCredentials current) async {
    await disconnect();
    final epoch = ++_epoch;
    _link = link;
    credentials = current;
    _raw = PacketInbox();
    _business = PacketInbox();
    _writes = Future.value();
    _timedOut.clear();
    phase = 'authenticating';
    stage = '正在认证设备';
    busy = true;
    error = null;
    _notify();
    _subscription = link.packets.listen((packet) => _receive(packet, epoch),
        onError: (Object _) {
      if (epoch == _epoch) unawaited(disconnect(message: '设备通知中断，请重新连接'));
    });
    unawaited(link.closed.then((_) {
      if (epoch == _epoch) unawaited(disconnect(message: '设备已断开，可重新连接'));
    }));
    try {
      final codec = await authenticateDevice(
          AuthIo(
              send: (b) => _send(b, epoch, raw: true),
              receive: (predicate, timeout) {
                _check(epoch);
                return _raw.receive(predicate, timeout: timeout);
              },
              stage: (message) {
                if (epoch == _epoch) {
                  stage = message;
                  _notify();
                }
              },
              handshake: (packet) {
                audioChannels = packet.length >= 9 ? packet[8] : null;
                isOggAudio = packet.length >= 12 ? packet[11] == 1 : null;
              }),
          current);
      try {
        _check(epoch);
      } catch (_) {
        codec.dispose();
        rethrow;
      }
      _codec = codec;
      stage = '正在读取设备状态';
      _notify();
      await _query(3, epoch);
      _check(epoch);
      phase = 'ready';
      stage = '设备已连接';
      await _optionalStatus(epoch);
      _check(epoch);
      _poll = Timer.periodic(const Duration(seconds: 10), (_) {
        if (_foreground && !busy && connected) {
          unawaited(refreshStatus().catchError((Object _) {}));
        }
      });
    } catch (e) {
      if (epoch == _epoch) {
        await disconnect(message: e is AppFailure ? e.message : '设备认证失败，请重新连接');
      }
      rethrow;
    } finally {
      if (epoch == _epoch && !_disposed) {
        busy = false;
        _notify();
      }
    }
  }

  void _receive(Uint8List raw, int epoch) {
    if (epoch != _epoch || _disposed) return;
    if (_codec == null) {
      _raw.push(raw);
      return;
    }
    try {
      final packet = _codec!.decode(raw);
      // Business decoding is performed exactly once per encrypted notification.
      final command = commandOf(packet);
      if (command == 3) {
        state = decodeDeviceState(packet);
        recording = recordingFromState(
            state!, recording, DateTime.now().millisecondsSinceEpoch);
        _pauseIfRecording();
        _notify();
      }
      if ([19, 20, 21, 22, 23].contains(command)) {
        final event = decodeRecordingEvent(packet, credentials!.serialNumber);
        if (event.ack != null) {
          unawaited(_send(event.ack!, epoch).catchError((Object _) {
            if (epoch == _epoch) {
              unawaited(disconnect(message: '设备事件确认失败，请重新连接'));
            }
          }));
        }
        if (event.event != null) {
          recording = applyRecordingEvent(
              recording, event.event!, DateTime.now().millisecondsSinceEpoch);
          if (event.event!.kind == 'new-file') transferNotice = '设备有新录音，可刷新目录';
          _pauseIfRecording();
          _notify();
        }
        return;
      }
      if ((packet.isNotEmpty && packet[0] == 2) ||
          [3, 6, 9, 26, 28, 29, 30].contains(command)) {
        _business.push(packet);
      }
    } on ReplayFailure {
      /* Previously authenticated notification, deliberately ignored. */
    } catch (_) {
      unawaited(disconnect(message: '设备响应校验失败，请重新连接'));
    }
  }

  void _pauseIfRecording() {
    if (downloadingSession != null && recording.active && !_cancelled) {
      transferNotice = '设备正在录音，下载已暂停，录音结束后可继续';
      cancelDownload();
    }
  }

  Future<Uint8List> _query(int command, int epoch) async {
    _check(epoch);
    if (_timedOut.contains(command)) {
      throw const AppFailure('QUERY_STALE', '设备查询曾超时，请重新连接后刷新');
    }
    _business.discard((p) => commandOf(p) == command);
    await _send(request(command), epoch);
    try {
      final response = await _business.receive((p) => commandOf(p) == command);
      _check(epoch);
      return response;
    } on AppFailure catch (e) {
      if (e.code == 'DEVICE_TIMEOUT') _timedOut.add(command);
      rethrow;
    }
  }

  Future<void> _optionalStatus(int epoch) async {
    final notices = <String>[];
    try {
      battery = decodeBattery(await _query(9, epoch));
    } catch (_) {
      _check(epoch);
      battery = null;
      notices.add('电量暂未获取');
    }
    try {
      storage = decodeStorage(await _query(6, epoch));
    } catch (_) {
      _check(epoch);
      storage = null;
      notices.add('存储暂未获取');
    }
    if (notices.isNotEmpty) error = notices.join('；');
  }

  Future<T> _operation<T>(Future<T> Function(int) operation) async {
    if (!connected) throw const AppFailure('DEVICE_DISCONNECTED', '请先连接设备');
    if (busy) throw const AppFailure('DEVICE_BUSY', '设备操作进行中，请稍候');
    final epoch = _epoch;
    busy = true;
    error = null;
    _notify();
    try {
      return await operation(epoch);
    } on AppFailure catch (e) {
      if (epoch == _epoch) error = e.message;
      rethrow;
    } finally {
      if (epoch == _epoch && !_disposed) {
        busy = false;
        _notify();
      }
    }
  }

  Future<void> refreshStatus() => _operation((epoch) async {
        await _query(3, epoch);
        await _optionalStatus(epoch);
        _check(epoch);
      });
  Future<void> _requireIdle(int epoch) async {
    await _query(3, epoch);
    if (recording.mode != 'idle') {
      throw const AppFailure('DEVICE_RECORDING', '请等设备结束录音或传输后再读取文件');
    }
  }

  Future<void> listFiles() => _operation((epoch) async {
        await _requireIdle(epoch);
        final id = ++_requestId & 0xffffffff;
        _business.discard((p) => commandOf(p) == 26);
        await _send(listRecordingsRequest(id), epoch);
        final result = <RecordingFile>[];
        int? expected;
        final deadline = DateTime.now().add(const Duration(seconds: 20));
        do {
          final remaining = deadline.difference(DateTime.now());
          if (remaining.isNegative) {
            throw const AppFailure('DEVICE_TIMEOUT', '录音目录读取超时，请刷新');
          }
          final frame = await _business.receive(
              (p) =>
                  commandOf(p) == 26 &&
                  p.length >= 7 &&
                  fields(p).getUint32(3, Endian.little) == id,
              timeout: remaining);
          _check(epoch);
          final page = decodeRecordingPage(frame, credentials!.portVersion);
          if (expected != null && expected != page.total) {
            throw const AppFailure('DIRECTORY_CHANGED', '录音目录发生变化，请刷新');
          }
          expected = page.total;
          if (page.index < result.length) {
            if (page.index + page.files.length > result.length) {
              throw const AppFailure('DIRECTORY_INVALID', '录音目录条目冲突');
            }
            for (var i = 0; i < page.files.length; i++) {
              final a = result[page.index + i], b = page.files[i];
              if (a.sessionId != b.sessionId ||
                  a.size != b.size ||
                  a.scene != b.scene ||
                  a.attribute != b.attribute) {
                throw const AppFailure('DIRECTORY_INVALID', '录音目录条目冲突');
              }
            }
            continue;
          }
          if (page.index != result.length) {
            throw const AppFailure('DIRECTORY_INCOMPLETE', '录音目录不完整，请刷新');
          }
          result.addAll(page.files);
        } while (result.length != expected);
        if (result.map((f) => f.sessionId).toSet().length != result.length) {
          throw const AppFailure('DIRECTORY_INVALID', '录音目录包含重复编号');
        }
        files = result;
      });

  Future<void> _stop(int epoch) async {
    _business.discard((p) => commandOf(p) == 30);
    await _send(stopRecordingSyncRequest(), epoch);
    final response = await _business.receive((p) => commandOf(p) == 30,
        timeout: const Duration(seconds: 3));
    decodeFileStop(response);
    _check(epoch);
  }

  void cancelDownload() {
    if (downloadingSession == null || _cancelled) return;
    _cancelled = true;
    transferPhase = 'cancelling';
    _business.close(const AppFailure('TRANSFER_CANCELLED', '下载已暂停，已接收部分保留'));
    _business = PacketInbox();
    _notify();
  }

  Future<File> download(RecordingFile file, File target) =>
      _operation((epoch) async {
        if (file.size <= 0 || file.size > 256 * 1024 * 1024) {
          throw const AppFailure('FILE_SIZE_INVALID', '设备录音为空或超过 256 MiB 下载上限');
        }
        await _requireIdle(epoch);
        final identity =
            '${credentials!.accountId}:${credentials!.serialNumber}:${credentials!.portVersion}';
        final saved = _checkpoint;
        var offset = saved != null &&
                saved.identity == identity &&
                saved.session == file.sessionId &&
                saved.size == file.size &&
                saved.path == target.path &&
                await target.exists() &&
                await target.length() == saved.received
            ? saved.received
            : 0;
        await target.parent.create(recursive: true);
        final writer = await target.open(
            mode: offset == 0 ? FileMode.write : FileMode.append);
        _cancelled = false;
        downloadingSession = file.sessionId;
        total = file.size;
        received = offset;
        transferPhase = 'downloading';
        transferNotice = null;
        _notify();
        var retries = 0, success = false;
        void checkpoint() {
          _checkpoint = (
            identity: identity,
            session: file.sessionId,
            size: file.size,
            path: target.path,
            received: offset
          );
          received = offset;
          final now = DateTime.now().millisecondsSinceEpoch;
          if (offset == file.size || now - _lastProgress > 100) {
            _lastProgress = now;
            _notify();
          }
        }

        try {
          checkpoint();
          while (true) {
            _check(epoch);
            if (_cancelled) {
              throw const AppFailure('TRANSFER_CANCELLED', '下载已暂停');
            }
            _business.discard((p) =>
                (p.isNotEmpty && p[0] == 2) || [28, 29].contains(commandOf(p)));
            await _send(syncRecordingRequest(file.sessionId, offset), epoch);
            var headSeen = false;
            try {
              while (true) {
                final frame = await _business.receive((p) {
                  if (p.isNotEmpty && p[0] == 2) {
                    return credentials!.portVersion < 7 ||
                        p.length < 5 ||
                        fields(p).getUint32(1, Endian.little) == file.sessionId;
                  }
                  return [28, 29].contains(commandOf(p)) &&
                      (p.length < 7 ||
                          fields(p).getUint32(3, Endian.little) ==
                              file.sessionId);
                }, timeout: const Duration(seconds: 12));
                _check(epoch);
                if (_cancelled) {
                  throw const AppFailure('TRANSFER_CANCELLED', '下载已暂停');
                }
                if (commandOf(frame) == 28) {
                  if (decodeFileHead(frame).status != 0) {
                    throw const AppFailure(
                        'TRANSFER_REJECTED', '设备未接受下载，请刷新目录后重试');
                  }
                  headSeen = true;
                  continue;
                }
                if (!headSeen) {
                  throw const AppFailure('TRANSFER_INVALID', '未收到下载开始确认，已停止保存');
                }
                if (commandOf(frame) == 29) {
                  decodeFileTail(frame);
                  if (offset != file.size) {
                    throw const AppFailure('TRANSFER_GAP', '录音文件长度不完整');
                  }
                  success = true;
                  break;
                }
                final chunk = decodeFileData(frame, credentials!.portVersion);
                if (chunk.offset == 0xffffffff) {
                  if (offset != file.size) {
                    throw const AppFailure('TRANSFER_GAP', '设备提前结束了下载');
                  }
                  continue;
                }
                if (chunk.offset + chunk.data.length > file.size) {
                  throw const AppFailure('TRANSFER_INVALID', '设备数据超出文件声明长度');
                }
                if (chunk.offset > offset) {
                  throw const AppFailure('TRANSFER_GAP', '录音数据存在缺口');
                }
                final overlap =
                    (offset - chunk.offset).clamp(0, chunk.data.length);
                if (overlap > 0) {
                  await writer.flush();
                  final original = await target
                      .openRead(chunk.offset, chunk.offset + overlap)
                      .fold<BytesBuilder>(BytesBuilder(), (b, p) => b..add(p));
                  if (!equalBytes(
                      original.takeBytes(), chunk.data.sublist(0, overlap))) {
                    throw const AppFailure(
                        'TRANSFER_CONFLICT', '重复数据不一致，已保留原件');
                  }
                }
                if (overlap < chunk.data.length) {
                  await writer.writeFrom(chunk.data, overlap);
                  offset += chunk.data.length - overlap;
                  checkpoint();
                }
              }
              if (success) break;
            } on AppFailure catch (e) {
              if (_cancelled ||
                  !['TRANSFER_GAP', 'DEVICE_TIMEOUT'].contains(e.code) ||
                  ++retries > 2) {
                rethrow;
              }
              transferNotice = '正在从已接收位置恢复（$retries/2）';
              _notify();
              await _stop(epoch);
            }
          }
          await writer.flush();
          _check(epoch);
          transferPhase = 'complete';
          stage = '设备文件已接收，正在保存';
          _notify();
          return target;
        } finally {
          try {
            try {
              await writer.flush();
            } finally {
              await writer.close();
            }
          } finally {
            if (epoch == _epoch) {
              downloadingSession = null;
              if (!success) {
                transferPhase = 'paused';
                try {
                  await _stop(epoch);
                } catch (_) {
                  await disconnect(message: '设备未确认停止，已断开连接；重连后可继续');
                }
              }
              _notify();
            }
          }
        }
      });

  Future<void> disconnect({String? message}) async {
    ++_epoch;
    _poll?.cancel();
    _poll = null;
    final link = _link, subscription = _subscription;
    _link = null;
    _subscription = null;
    _raw.close();
    _business.close();
    _codec?.dispose();
    _codec = null;
    phase = 'disconnected';
    stage = message ?? '未连接设备';
    error = message;
    busy = false;
    state = null;
    battery = null;
    storage = null;
    recording = const RecordingStatus();
    files = const [];
    audioChannels = null;
    isOggAudio = null;
    downloadingSession = null;
    credentials = null;
    if (transferPhase == 'downloading' || transferPhase == 'cancelling') {
      transferPhase = 'paused';
    }
    _notify();
    await subscription?.cancel();
    await link?.close();
  }

  Future<void> dispose() async {
    _disposed = true;
    onChanged = null;
    await disconnect();
  }
}
