import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:ogg_caf_converter/ogg_caf_converter.dart';
import 'package:path/path.dart' as p;
import 'package:plaud_app/core/audio/device_audio.dart';
import 'package:plaud_app/core/crypto/protocol_crypto.dart';
import 'package:plaud_app/core/device/authenticate.dart';
import 'package:plaud_app/core/device/device_controller.dart';
import 'package:plaud_app/core/failure.dart';
import 'package:plaud_app/core/protocol/bytes.dart';
import 'package:plaud_app/features/auth/auth_controller.dart';
import 'package:plaud_app/features/auth/cloud_client.dart';
import 'package:plaud_app/features/library/recording_store.dart';
import 'fixtures/peer_material.dart';
import 'helpers/peer.dart';

class UnavailableCloud implements CloudTransport {
  UnavailableCloud({this.unauthorized = false});
  final bool unauthorized;
  @override
  Future<CloudResponse> send(Uri uri,
      {required String method,
      required Map<String, String> headers,
      String? body}) async {
    if (unauthorized) return const CloudResponse(401, {}, '{}');
    throw const AppFailure('CLOUD_NETWORK_ERROR', 'Synthetic network failure');
  }
}

void main() {
  group('独立 Web/Node 密码学材料', () {
    test('Fernet 真实格式验证签名后解码，篡改时拒绝且不暴露材料', () {
      final token = peerFixture['responseToken'] as String;
      expect(decryptCloudResponse(token), peerFixture['responsePlain']);
      final changed = base64Url.decode(base64Url.normalize(token));
      changed[changed.length - 4] ^= 1;
      expect(() => decryptCloudResponse(base64Url.encode(changed)),
          throwsA(isA<AppFailure>()));
    });
    test('secp256k1 完整共享点/HKDF/16 字节 GCM nonce 与 Node 完全一致', () {
      final scalar = Uint8List(32)..[31] = 2;
      final value = encryptLoginPassword(
          'fixture-password', unhex(peerFixture['serverPublic'] as String),
          privateKey: scalar,
          iv: Uint8List(16)..fillRange(0, 16, 3),
          unixSeconds: 1700000000);
      expect(value, peerFixture['expectedPassword']);
    });
    test('PKCS8/SPKI RSA 与 Node 录音密钥匹配', () {
      validateRsaPair(peerFixture['publicKey'] as String,
          peerFixture['privateKey'] as String);
      final original = base64Decode(peerFixture['encrypted'] as String);
      expect(
          rsaDecrypt(
              peerFixture['privateKey'] as String, original.sublist(256, 512)),
          List.filled(32, 7));
    });
    test('ChaCha 会话报文与 Web 一致，拒绝重放和已销毁会话', () {
      final codec = EncryptedCodec(unhex(peerFixture['material'] as String));
      final encrypted = codec.encode(unhex('010300'));
      expect(hex(encrypted), peerFixture['sessionCipher']);
      expect(codec.decode(encrypted), [1, 3, 0]);
      expect(() => codec.decode(encrypted), throwsA(isA<ReplayFailure>()));
      codec.dispose();
      expect(() => codec.encode(unhex('010300')), throwsA(isA<AppFailure>()));
    });
  });
  group('账号、区域与安全存储语义', () {
    test('加密登录→绑定设备→RSA 准备→重启恢复→退出只删除授权', () async {
      final server = FixtureCloud(), vault = MemorySecrets();
      final auth = AuthController(
          client: PlaudCloudClient(transport: server), secrets: vault);
      await auth.login('fixture@example.test', 'fixture-password');
      expect(auth.session!.devices.single.serialNumber, peerFixture['serial']);
      final credentials =
          await auth.prepare(peerFixture['serial'] as String, 20);
      expect(credentials.rsa!.privateKeyPem, peerFixture['privateKey']);
      final form = Uri.splitQueryString(server.requests
          .firstWhere((r) => r.uri.path == '/auth/access-token')
          .body!);
      expect(form['password_encrypted'], 'true');
      expect(form['password'], isNot('fixture-password'));
      final restored = AuthController(
          client: PlaudCloudClient(transport: server), secrets: vault);
      await restored.restore();
      expect(restored.session!.accountId, 'fixture-account');
      expect(restored.session!.rsa!.privateKeyPem, peerFixture['privateKey']);
      await restored.logout();
      expect(vault.values.containsKey('session_v1'), false);
      expect(vault.values.keys.any((k) => k.startsWith('rsa_')), true);
      auth.dispose();
      restored.dispose();
    });
    test('错误密码不会保存会话或暴露请求原文', () async {
      final vault = MemorySecrets();
      final auth = AuthController(
          client: PlaudCloudClient(transport: FixtureCloud()), secrets: vault);
      await expectLater(auth.login('fixture@example.test', 'wrong-password'),
          throwsA(isA<AppFailure>()));
      expect(auth.session, isNull);
      expect(vault.values, isEmpty);
      expect(auth.error, isNot(contains('wrong-password')));
      auth.dispose();
    });
    test('并发刷新只有一次请求，并原子轮换两个 token', () async {
      final server = FixtureCloud(),
          client = PlaudCloudClient(transport: FixtureCloud());
      final current =
          await client.login('fixture@example.test', 'fixture-password');
      final refreshing = PlaudCloudClient(transport: server);
      await Future.wait(
          [refreshing.refresh(current), refreshing.refresh(current)]);
      expect(server.refreshCount, 1);
      expect(current.refreshToken, 'fixture-next-refresh');
      expect(current.userToken, 'fixture-access');
    });
    test('退出使迟到登录失效，不复活或重新保存账号', () async {
      final delayed = Completer<CloudResponse>(),
          server = FixtureCloud()
            ..delayLogin = Completer<CloudResponse>().future;
      server.delayLogin = delayed.future;
      final vault = MemorySecrets();
      final auth = AuthController(
          client: PlaudCloudClient(transport: server), secrets: vault);
      final login = auth.login('fixture@example.test', 'fixture-password');
      await Future<void>.delayed(Duration.zero);
      await auth.logout();
      delayed.complete(
          const CloudResponse(200, {}, '{"access_token":"fixture-access"}'));
      await login;
      expect(auth.session, isNull);
      expect(vault.values, isEmpty);
      auth.dispose();
    });
    test('区域地址拒绝非官方主机、明文、用户信息和端口', () {
      expect(officialBase('https://api-euc1.plaud.ai/'),
          'https://api-euc1.plaud.ai');
      for (final value in [
        'http://api.plaud.ai',
        'https://evil.test',
        'https://api.plaud.ai.evil.test',
        'https://u:p@api.plaud.ai',
        'https://api.plaud.ai:443'
      ]) {
        expect(() => officialBase(value), throwsA(isA<AppFailure>()));
      }
    });
    test('已验证登录允许七天内离线读本机录音，离线禁止设备授权', () async {
      final vault = MemorySecrets();
      final original = AuthController(
          client: PlaudCloudClient(transport: FixtureCloud()), secrets: vault);
      await original.login('fixture@example.test', 'fixture-password');
      original.dispose();
      final restored = AuthController(
          client: PlaudCloudClient(transport: UnavailableCloud()),
          secrets: vault);
      await restored.restore();
      expect(restored.session!.accountId, 'fixture-account');
      expect(restored.offline, true);
      await expectLater(
          restored.prepare(peerFixture['serial'] as String, 20),
          throwsA(isA<AppFailure>()
              .having((e) => e.code, 'code', 'OFFLINE_LOCAL_ONLY')));
      restored.dispose();
    });
    test('过期、未验证、未来时间、401 和账号不匹配均不可离线恢复', () async {
      final vault = MemorySecrets();
      final original = AuthController(
          client: PlaudCloudClient(transport: FixtureCloud()), secrets: vault);
      await original.login('fixture@example.test', 'fixture-password');
      original.dispose();
      final valid = vault.values['session_v1']!;
      final now = DateTime.now().millisecondsSinceEpoch;
      for (final verifiedAt in [
        null,
        now - const Duration(days: 8).inMilliseconds,
        now + 600000
      ]) {
        final data = object(jsonDecode(valid))..['verifiedAt'] = verifiedAt;
        vault.values['session_v1'] = jsonEncode(data);
        final restored = AuthController(
            client: PlaudCloudClient(transport: UnavailableCloud()),
            secrets: vault);
        await restored.restore();
        expect(restored.session, isNull);
        expect(restored.offline, false);
        restored.dispose();
      }
      for (final transport in <CloudTransport>[
        UnavailableCloud(unauthorized: true),
        FixtureCloud()..account = 'other-account'
      ]) {
        vault.values['session_v1'] = valid;
        final restored = AuthController(
            client: PlaudCloudClient(transport: transport), secrets: vault);
        await restored.restore();
        expect(restored.session, isNull);
        expect(restored.offline, false);
        restored.dispose();
      }
    });
  });
  group('认证、状态、目录、流式下载、音频恢复和播放资产', () {
    late Directory directory;
    setUp(() async {
      directory = await Directory.systemTemp.createTemp('recdock-phase1-');
    });
    tearDown(() async {
      await directory.delete(recursive: true);
    });
    test('协议20完整握手，真实加密报文读取状态/目录并下载', () async {
      final peer = PeerDevice(), device = DeviceController();
      await device.connect(peer, fixtureCredentials());
      expect(device.connected, true);
      expect(device.battery!.level, 66);
      expect(device.recording.mode, 'idle');
      await device.listFiles();
      expect(device.files.single.sessionId, peerFixture['sessionId']);
      final output = File(p.join(directory.path, 'download.bin'));
      await device.download(device.files.single, output);
      expect(await output.readAsBytes(), peer.raw);
      expect(peer.downloadRequests, 1);
      await device.dispose();
      expect(device.state, isNull);
      expect(device.battery, isNull);
    });
    test('SN 不匹配不会显示已连接', () async {
      final device = DeviceController();
      await expectLater(
          device.connect(PeerDevice(wrongSerial: true), fixtureCredentials()),
          throwsA(isA<AppFailure>()));
      expect(device.connected, false);
      expect(device.state, isNull);
      await device.dispose();
    });
    test('取消后保留连续字节，同账号设备重连继续，不覆盖已接收部分', () async {
      final first = PeerDevice(chunkDelay: const Duration(milliseconds: 1)),
          device = DeviceController();
      await device.connect(first, fixtureCredentials());
      await device.listFiles();
      final file = device.files.single,
          target = File(p.join(directory.path, 'partial.bin'));
      var cancelled = false;
      device.onChanged = () {
        if (!cancelled &&
            device.received >= 320 &&
            device.downloadingSession != null) {
          cancelled = true;
          device.cancelDownload();
        }
      };
      await expectLater(
          device.download(file, target), throwsA(isA<AppFailure>()));
      final count = await target.length();
      expect(count, greaterThanOrEqualTo(320));
      expect(count, lessThan(file.size));
      device.onChanged = null;
      await device.disconnect();
      final second = PeerDevice();
      await device.connect(second, fixtureCredentials());
      await device.download(file, target);
      expect(second.receivedStart, count);
      expect(await target.readAsBytes(), second.raw);
      await device.dispose();
    });
    test('下载中设备开始录音只暂停文件同步，保留原件且不发送录音控制命令', () async {
      final peer = PeerDevice(chunkDelay: const Duration(milliseconds: 1)),
          device = DeviceController();
      await device.connect(peer, fixtureCredentials());
      await device.listFiles();
      final file = device.files.single;
      final target = File(p.join(directory.path, 'recording-interrupted.bin'));
      var recordingStarted = false;
      device.onChanged = () {
        if (!recordingStarted &&
            device.received >= 320 &&
            device.downloadingSession != null) {
          recordingStarted = true;
          peer.emitRecording(Uint8List.fromList(
              [1, 20, 0, ...le32(1700000100), 0, 0, 0, 0, 0]));
        }
      };
      await expectLater(
          device.download(file, target), throwsA(isA<AppFailure>()));
      expect(device.connected, true);
      expect(device.recording.mode, 'recording');
      expect(device.transferPhase, 'paused');
      expect(await target.length(), inInclusiveRange(320, file.size - 1));
      expect(peer.commands, contains(29));
      expect(peer.commands.where((c) => [20, 21, 22, 23].contains(c)), isEmpty);
      device.onChanged = null;
      await device.dispose();
    });
    test('RSA 原件解密、Ogg CRC、流式 CAF 与独立转换器输出一致', () async {
      final original = await File(p.join(directory.path, 'source.bin'))
          .writeAsBytes(base64Decode(peerFixture['encrypted'] as String));
      final recovered = await recoverDeviceAudio(original,
          output: File(p.join(directory.path, 'audio.ogg')), rsa: fixtureRsa());
      expect(recovered.playable, isNotNull);
      expect(await recovered.playable!.readAsBytes(),
          base64Decode(peerFixture['ogg'] as String));
      await validateOggFile(recovered.playable!);
      final caf = await iosPlayableFile(recovered.playable!, ios: true);
      final reference = await OggCafConverter()
          .convertOggToCafInMemory(input: recovered.playable!.path);
      // Compare decoded packet/time metadata, not optional encoder info chunk.
      final reader = CafReader();
      final actualBytes = await caf.readAsBytes();
      expect(reader.readAudioFormat(actualBytes).formatID.toString(), 'opus');
      expect(reader.readAudioFormat(actualBytes).sampleRate, 48000);
      final a = reader.readPacketTable(actualBytes),
          b = reader.readPacketTable(reference);
      expect(a.header.numberPackets, b.header.numberPackets);
      expect(a.header.numberValidFrames, b.header.numberValidFrames);
      expect(a.header.primingFrames, b.header.primingFrames);
      expect(a.header.remainderFrames, b.header.remainderFrames);
      expect(a.entries, b.entries);
      expect(await original.readAsBytes(),
          base64Decode(peerFixture['encrypted'] as String));
    });
    test('音频校验失败保留原件，不生成可播放资产', () async {
      final bytes = base64Decode(peerFixture['ogg'] as String)..[50] ^= 1;
      final original =
          await File(p.join(directory.path, 'bad.bin')).writeAsBytes(bytes);
      final output = File(p.join(directory.path, 'bad.ogg'));
      final result = await recoverDeviceAudio(original, output: output);
      expect(result.playable, isNull);
      expect(await original.readAsBytes(), bytes);
      expect(await output.exists(), false);
    });
    test('账号录音退出隐藏、跨账号不可读，个人录音始终存在', () async {
      final store = RecordingStore(Directory(p.join(directory.path, 'library')))
        ..activeAccountId = 'account-A';
      final original = await File(p.join(directory.path, 'source.bin'))
          .writeAsBytes(base64Decode(peerFixture['encrypted'] as String));
      final playable = await File(p.join(directory.path, 'audio.ogg'))
          .writeAsBytes(base64Decode(peerFixture['ogg'] as String));
      final personal = await store.importFile(playable, title: 'personal');
      final private = await store.saveDevice(
          owner: 'account-A',
          serial: '888fixture',
          session: 1700000000,
          original: original,
          playable: playable);
      expect((await store.load()).recordings, hasLength(2));
      store.activeAccountId = 'account-B';
      expect((await store.load()).recordings.single.id, personal.id);
      expect(() => store.audioFile(private), throwsA(isA<AppFailure>()));
      await expectLater(
          store.rename(private.id, 'leak'), throwsA(isA<AppFailure>()));
      store.activeAccountId = null;
      expect((await store.load()).recordings.single.id, personal.id);
      store.activeAccountId = 'account-A';
      expect((await store.load()).recordings, hasLength(2));
    });
    test('原件补回播放资产时保留同一录音编号、标题和原件，不重复入库', () async {
      final store = RecordingStore(Directory(p.join(directory.path, 'library')))
        ..activeAccountId = 'account-A';
      final original = await File(p.join(directory.path, 'source.bin'))
          .writeAsBytes(base64Decode(peerFixture['encrypted'] as String));
      final playable = await File(p.join(directory.path, 'audio.ogg'))
          .writeAsBytes(base64Decode(peerFixture['ogg'] as String));
      final raw = await store.saveDevice(
          owner: 'account-A',
          serial: '888fixture',
          session: 1700000000,
          original: original,
          notice: '原件已保存');
      expect(raw.playable, false);
      await store.rename(raw.id, '我的会议');
      final recovered = await store.saveDevice(
          owner: 'account-A',
          serial: '888fixture',
          session: 1700000000,
          original: original,
          playable: playable);
      expect(recovered.id, raw.id);
      expect(recovered.title, '我的会议');
      expect(recovered.createdAt, raw.createdAt);
      expect(recovered.notice, isNull);
      expect((await store.load()).recordings, hasLength(1));
      expect(await store.originalFile(recovered).readAsBytes(),
          await original.readAsBytes());
      expect(await store.audioFile(recovered).readAsBytes(),
          await playable.readAsBytes());
    });
  });
}
