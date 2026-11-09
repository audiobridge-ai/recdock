import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:plaud_app/app.dart';
import 'package:plaud_app/core/device/device_controller.dart';
import 'package:plaud_app/core/failure.dart';
import 'package:plaud_app/core/protocol/advertisement.dart';
import 'package:plaud_app/features/auth/auth_controller.dart';
import 'package:plaud_app/features/auth/cloud_client.dart';
import 'package:plaud_app/features/auth/secret_store.dart';
import 'package:plaud_app/features/devices/device_scanner.dart';
import 'package:plaud_app/features/library/recording_store.dart';
import '../test/fixtures/peer_material.dart';
import '../test/helpers/peer.dart';

class ScopedNativeSecrets implements SecretStore {
  final platform = PlatformSecretStore();
  final used = <String>{};
  @override
  Future<String?> read(String key) => platform.read('smoke_$key');
  @override
  Future<void> write(String key, String value) async {
    used.add(key);
    await platform.write('smoke_$key', value);
  }

  @override
  Future<void> delete(String key) => platform.delete('smoke_$key');
  Future<void> cleanup() async {
    for (final key in used) {
      await delete(key);
    }
  }
}

class FixtureScanner extends DeviceScanner {
  bool _found = false;
  @override
  List<NearbyDevice> get devices => !_found
      ? []
      : [
          NearbyDevice(
              'fixture-native-peer',
              '合成验收设备',
              -42,
              PlaudAdvertisement(
                  serialNumber: peerFixture['serial'] as String,
                  project: 888,
                  model: 'Plaud Note',
                  firmware: 'fixture',
                  portVersion: 20))
        ];
  @override
  Future<void> start() async {
    _found = true;
    notifyListeners();
  }

  @override
  Future<void> stop() async {
    scanning = false;
    notifyListeners();
  }
}

class OfflineTransport implements CloudTransport {
  @override
  Future<CloudResponse> send(Uri uri,
      {required String method,
      required Map<String, String> headers,
      String? body}) async {
    throw const AppFailure(
        'CLOUD_NETWORK_ERROR', 'Synthetic offline verification');
  }
}

Future<void> until(WidgetTester tester, bool Function() condition,
    {Duration timeout = const Duration(seconds: 40)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw StateError('Integration condition timed out');
    }
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pump();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('第一阶段原生验收：安全存储、加密登录与设备、下载、播放、离线重启', (tester) async {
    final root = Directory(p.join(
        (await getApplicationSupportDirectory()).path, 'phase1-native-smoke'));
    if (await root.exists()) await root.delete(recursive: true);
    final secrets = ScopedNativeSecrets();
    // Use a private namespace; never modify an existing product login.
    await secrets.delete('session_v1');
    await secrets.write('vault_probe', 'synthetic-value');
    expect(await secrets.read('vault_probe'), 'synthetic-value');
    final auth = AuthController(
        client: PlaudCloudClient(transport: FixtureCloud()), secrets: secrets);
    final device = DeviceController(),
        store = RecordingStore(root),
        scanner = FixtureScanner();
    PeerDevice? peer;
    try {
      await tester.pumpWidget(RecDockApp(
          store: store,
          auth: auth,
          device: device,
          scanner: scanner,
          linkFactory: (_) async => peer = PeerDevice()));
      await until(tester, () => auth.restored);
      await tester.tap(find.text('设备'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('登录 PLAUD'));
      await tester.pumpAndSettle();
      await tester.enterText(
          find.widgetWithText(TextField, '邮箱'), 'fixture@example.test');
      await tester.enterText(
          find.widgetWithText(TextField, '密码'), 'fixture-password');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '登录'));
      await until(tester, () => auth.session != null && !auth.busy);
      await tester.pumpAndSettle();
      expect(find.text('合成验收设备'), findsOneWidget);
      await tester.tap(find.text('扫描附近设备'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '连接'));
      await until(tester,
          () => device.connected && device.files.length == 1 && !device.busy);
      await tester.pumpAndSettle();
      expect(device.battery!.level, 66);
      expect(device.storage, isNotNull);
      await tester.scrollUntilVisible(find.text('下载'), 180,
          scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('下载'));
      await until(tester, () => find.text('录音详情').evaluate().isNotEmpty);
      await until(
          tester, () => find.byIcon(Icons.play_arrow).evaluate().isNotEmpty);
      expect(peer!.downloadRequests, 1);
      expect((await store.load()).recordings.single.playable, true);
      await tester.tap(find.byIcon(Icons.play_arrow));
      await until(
          tester,
          () =>
              find.byType(Slider).evaluate().isNotEmpty &&
              tester.widget<Slider>(find.byType(Slider)).value > 200);
      final slider = find.byType(Slider);
      final bounds = tester.getRect(slider);
      await tester
          .tapAt(Offset(bounds.left + bounds.width * 0.7, bounds.center.dy));
      await tester.pump(const Duration(milliseconds: 150));
      expect(tester.widget<Slider>(slider).value, greaterThan(500));
      await tester.pageBack();
      await tester.pumpAndSettle();
      await device.disconnect();
      // Simulate a cold App restart while offline, using the real persisted library and native secure storage.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      final offlineAuth = AuthController(
          client: PlaudCloudClient(transport: OfflineTransport()),
          secrets: secrets);
      final reloaded = RecordingStore(root);
      await tester.pumpWidget(RecDockApp(
          store: reloaded, auth: offlineAuth, scanner: FixtureScanner()));
      await until(tester, () => offlineAuth.restored);
      await tester.pumpAndSettle();
      expect(offlineAuth.offline, true);
      expect((await reloaded.load()).recordings, hasLength(1));
      final title = (await reloaded.load()).recordings.single.title;
      await until(tester, () => find.text(title).evaluate().isNotEmpty);
      await tester.tap(find.text(title));
      await tester.pumpAndSettle();
      await until(
          tester, () => find.byIcon(Icons.play_arrow).evaluate().isNotEmpty);
      await tester.tap(find.byIcon(Icons.play_arrow));
      await until(
          tester, () => tester.widget<Slider>(find.byType(Slider)).value > 100);
      await tester.pageBack();
      await tester.pumpAndSettle();
      await offlineAuth.logout();
      await tester.pumpAndSettle();
      expect((await reloaded.load()).recordings, isEmpty);
      expect(
          await root
              .list()
              .where((f) => p.basename(f.path).startsWith('rec_'))
              .length,
          1);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      await secrets.cleanup();
      if (await root.exists()) await root.delete(recursive: true);
    }
  });
}
