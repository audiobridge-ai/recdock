import 'dart:async';
import 'dart:typed_data';

import '../failure.dart';

typedef PacketPredicate = bool Function(Uint8List packet);

abstract interface class DeviceLink {
  Stream<Uint8List> get packets;
  Future<void> get closed;
  Future<void> write(Uint8List packet);
  Future<void> close();
}

class PacketInbox {
  final _queued = <Uint8List>[];
  final _waiters = <({
    PacketPredicate predicate,
    Completer<Uint8List> result,
    Timer timer
  })>[];
  Object? _closed;
  static const maxPackets = 4096;

  void push(Uint8List bytes) {
    if (_closed != null) return;
    for (var i = 0; i < _waiters.length; i++) {
      final waiter = _waiters[i];
      if (waiter.predicate(bytes)) {
        _waiters.removeAt(i);
        waiter.timer.cancel();
        waiter.result.complete(bytes);
        return;
      }
    }
    if (_queued.length >= maxPackets) {
      close(const AppFailure('DEVICE_QUEUE_OVERFLOW', '设备通知积压，请重新连接'));
      return;
    }
    _queued.add(Uint8List.fromList(bytes));
  }

  Future<Uint8List> receive(PacketPredicate predicate,
      {Duration timeout = const Duration(seconds: 15)}) {
    if (_closed != null) return Future.error(_closed!);
    final index = _queued.indexWhere(predicate);
    if (index >= 0) return Future.value(_queued.removeAt(index));
    final result = Completer<Uint8List>();
    final timer = Timer(timeout, () {
      _waiters.removeWhere((w) => identical(w.result, result));
      result.completeError(const AppFailure('DEVICE_TIMEOUT', '设备响应超时'));
    });
    _waiters.add((predicate: predicate, result: result, timer: timer));
    return result.future;
  }

  void discard(PacketPredicate predicate) => _queued.removeWhere(predicate);

  void close(
      [Object error = const AppFailure('DEVICE_DISCONNECTED', '设备连接已断开')]) {
    _closed = error;
    _queued.clear();
    for (final waiter in _waiters) {
      waiter.timer.cancel();
      waiter.result.completeError(error);
    }
    _waiters.clear();
  }
}
