import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_reactive_ble/flutter_reactive_ble.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/protocol/advertisement.dart';

class NearbyDevice {
  const NearbyDevice(this.id, this.name, this.rssi, this.advertisement);
  final String id;
  final String name;
  final int rssi;
  final PlaudAdvertisement advertisement;
}

/// Foreground discovery; account matching and authentication happen separately.
class DeviceScanner extends ChangeNotifier {
  FlutterReactiveBle? _ble;
  FlutterReactiveBle get ble => _ble ??= FlutterReactiveBle();
  StreamSubscription<DiscoveredDevice>? _scan;
  Timer? _timeout;
  int _generation = 0;
  bool _disposed = false;
  bool scanning = false;
  String? error;
  final Map<String, NearbyDevice> _devices = {};
  List<NearbyDevice> get devices =>
      _devices.values.toList()..sort((a, b) => b.rssi.compareTo(a.rssi));

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> start() async {
    if (scanning || _disposed) return;
    final generation = ++_generation;
    scanning = true;
    error = null;
    _devices.clear();
    _notify();
    try {
      if (Platform.isAndroid) {
        final sdk = await const MethodChannel('ai.audiobridge.recdock/platform')
            .invokeMethod<int>('sdkInt');
        if (sdk == null) throw StateError('无法获取系统蓝牙权限信息');
        final requested = sdk >= 31
            ? [Permission.bluetoothScan, Permission.bluetoothConnect]
            : [Permission.locationWhenInUse];
        final permissions = await requested.request();
        if (permissions.values.any((status) => !status.isGranted)) {
          throw StateError(
              sdk >= 31 ? '请在系统设置中允许“附近的设备”权限' : '扫描蓝牙需要位置权限和系统定位服务');
        }
      }
      if (_disposed || generation != _generation) return;
      final ble = _ble ??= FlutterReactiveBle();
      final status = await ble.statusStream
          .firstWhere((s) => s != BleStatus.unknown)
          .timeout(const Duration(seconds: 12));
      if (_disposed || generation != _generation) return;
      if (status != BleStatus.ready) {
        throw StateError(switch (status) {
          BleStatus.poweredOff => '请打开手机蓝牙后重新扫描',
          BleStatus.unauthorized => '请在系统设置中允许 RecDock 使用蓝牙',
          BleStatus.locationServicesDisabled => '请打开系统定位服务后重新扫描',
          BleStatus.unsupported => '此设备不支持低功耗蓝牙',
          _ => '蓝牙尚未就绪，请稍后重试',
        });
      }
      _scan = ble.scanForDevices(
          withServices: const [],
          scanMode: ScanMode.lowLatency).listen((device) {
        if (_disposed || generation != _generation) return;
        final identity = decodeMobileManufacturer(device.manufacturerData);
        if (identity == null) return;
        _devices[device.id] =
            NearbyDevice(device.id, device.name, device.rssi, identity);
        _notify();
      }, onError: (Object _) {
        if (_disposed || generation != _generation) return;
        error = '蓝牙扫描中断，请检查权限和系统蓝牙后重试';
        unawaited(stop());
      });
      _timeout = Timer(const Duration(seconds: 20), () => unawaited(stop()));
    } catch (e) {
      if (_disposed || generation != _generation) return;
      error = e is StateError ? e.message : '蓝牙暂不可用，请检查系统设置后重试';
      await stop();
    }
  }

  Future<void> stop() async {
    ++_generation;
    _timeout?.cancel();
    _timeout = null;
    final subscription = _scan;
    _scan = null;
    scanning = false;
    try {
      await subscription?.cancel();
    } finally {
      _notify();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    ++_generation;
    _timeout?.cancel();
    unawaited(_scan?.cancel());
    super.dispose();
  }
}
