import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_reactive_ble/flutter_reactive_ble.dart';

import '../../core/device/packet_io.dart';
import '../../core/failure.dart';
import '../../core/protocol/advertisement.dart';

class ReactiveDeviceLink implements DeviceLink {
  ReactiveDeviceLink._(this._ble, this.id);
  final FlutterReactiveBle _ble;
  final String id;
  final _packets = StreamController<Uint8List>.broadcast(sync: true);
  final _closed = Completer<void>();
  StreamSubscription<ConnectionStateUpdate>? _connection;
  StreamSubscription<List<int>>? _notifications;
  late QualifiedCharacteristic _tx;
  bool _withResponse = true;
  bool _closing = false;
  @override
  Stream<Uint8List> get packets => _packets.stream;
  @override
  Future<void> get closed => _closed.future;

  static Future<ReactiveDeviceLink> open(
      FlutterReactiveBle ble, String id) async {
    final link = ReactiveDeviceLink._(ble, id), connected = Completer<void>();
    try {
      link._connection = ble.connectToDevice(
          id: id,
          connectionTimeout: const Duration(seconds: 20),
          servicesWithCharacteristicsToDiscover: {
            Uuid.parse(plaudService): [
              Uuid.parse(plaudReceive),
              Uuid.parse(plaudTransmit)
            ]
          }).listen((update) {
        if (update.connectionState == DeviceConnectionState.connected &&
            !connected.isCompleted) {
          connected.complete();
        }
        if (update.connectionState == DeviceConnectionState.disconnected) {
          if (!connected.isCompleted) {
            connected.completeError(
                const AppFailure('DEVICE_DISCONNECTED', '设备未能连接，请唤醒设备后重试'));
          }
          if (!link._closed.isCompleted) link._closed.complete();
        }
      }, onError: (Object _) {
        if (!connected.isCompleted) {
          connected.completeError(
              const AppFailure('DEVICE_CONNECT_FAILED', '蓝牙连接失败，请检查设备是否被占用'));
        }
        if (!link._closed.isCompleted) link._closed.complete();
      });
      await connected.future.timeout(const Duration(seconds: 25));
      if (link._closed.isCompleted) {
        throw const AppFailure('DEVICE_DISCONNECTED', '设备已断开');
      }
      final mtu = await ble
          .requestMtu(deviceId: id, mtu: 247)
          .timeout(const Duration(seconds: 10));
      if (mtu < 107) {
        throw const AppFailure('DEVICE_MTU_INVALID', '蓝牙传输长度不足，请重新连接设备');
      }
      await ble.discoverAllServices(id).timeout(const Duration(seconds: 15));
      final services = await ble
          .getDiscoveredServices(id)
          .timeout(const Duration(seconds: 10));
      final matches = services.where((s) => s.id == Uuid.parse(plaudService));
      if (matches.length != 1) {
        throw const AppFailure('DEVICE_SERVICE_MISSING', '设备没有提供所需录音服务');
      }
      final characteristics = matches.single.characteristics;
      final rx = characteristics.where((c) => c.id == Uuid.parse(plaudReceive));
      final tx =
          characteristics.where((c) => c.id == Uuid.parse(plaudTransmit));
      if (rx.length != 1 ||
          tx.length != 1 ||
          (!rx.single.isNotifiable && !rx.single.isIndicatable) ||
          (!tx.single.isWritableWithResponse &&
              !tx.single.isWritableWithoutResponse)) {
        throw const AppFailure('DEVICE_SERVICE_INVALID', '设备蓝牙特征不兼容');
      }
      link._withResponse = tx.single.isWritableWithResponse;
      link._tx = QualifiedCharacteristic(
          deviceId: id,
          serviceId: Uuid.parse(plaudService),
          characteristicId: Uuid.parse(plaudTransmit));
      link._notifications = ble
          .subscribeToCharacteristic(QualifiedCharacteristic(
              deviceId: id,
              serviceId: Uuid.parse(plaudService),
              characteristicId: Uuid.parse(plaudReceive)))
          .listen((bytes) {
        if (!link._packets.isClosed) {
          link._packets.add(Uint8List.fromList(bytes));
        }
      }, onError: (Object _) {
        if (!link._closed.isCompleted) link._closed.complete();
      });
      await Future<void>.delayed(Duration.zero);
      return link;
    } catch (_) {
      await link.close();
      rethrow;
    }
  }

  @override
  Future<void> write(Uint8List packet) async {
    if (_closed.isCompleted || _closing) {
      throw const AppFailure('DEVICE_DISCONNECTED', '设备已断开');
    }
    try {
      if (_withResponse) {
        await _ble
            .writeCharacteristicWithResponse(_tx, value: packet)
            .timeout(const Duration(seconds: 10));
      } else {
        await _ble
            .writeCharacteristicWithoutResponse(_tx, value: packet)
            .timeout(const Duration(seconds: 10));
      }
    } catch (_) {
      throw const AppFailure('DEVICE_WRITE_FAILED', '设备写入失败，请重新连接');
    }
  }

  @override
  Future<void> close() async {
    if (_closing) return;
    _closing = true;
    if (!_closed.isCompleted) _closed.complete();
    await _notifications?.cancel();
    await _connection?.cancel();
    await _packets.close();
  }
}
