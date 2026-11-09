// In-process device and cloud peers for tests only. Never imported by lib/.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';
import 'package:plaud_app/core/crypto/protocol_crypto.dart';
import 'package:plaud_app/core/device/authenticate.dart';
import 'package:plaud_app/core/device/packet_io.dart';
import 'package:plaud_app/core/protocol/bytes.dart';
import 'package:plaud_app/features/auth/cloud_client.dart';
import 'package:plaud_app/features/auth/models.dart';
import 'package:plaud_app/features/auth/secret_store.dart';
import '../fixtures/peer_material.dart';

RsaMaterial fixtureRsa() => RsaMaterial(
    publicKeyPem: peerFixture['publicKey'] as String,
    privateKeyPem: peerFixture['privateKey'] as String,
    snSignature: base64Encode(utf8.encode('synthetic-signature')));
DeviceCredentials fixtureCredentials({int port = 20}) => DeviceCredentials(
    accountId: 'fixture-account',
    serialNumber: peerFixture['serial'] as String,
    portVersion: port,
    rsa: port == 20 ? fixtureRsa() : null);

class MemorySecrets implements SecretStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

class FixtureCloud implements CloudTransport {
  final requests =
      <({Uri uri, String method, Map<String, String> headers, String? body})>[];
  bool encryptedPassword = true;
  int refreshCount = 0;
  Future<CloudResponse>? delayLogin;
  String account = 'fixture-account';
  @override
  Future<CloudResponse> send(Uri uri,
      {required String method,
      required Map<String, String> headers,
      String? body}) async {
    requests.add((uri: uri, method: method, headers: headers, body: body));
    CloudResponse response(Json value, {int code = 200}) =>
        CloudResponse(code, {}, jsonEncode(value));
    if (uri.path == '/config/security') {
      return response({
        'status': 0,
        'data': {
          'pass_algorithm': encryptedPassword ? 'secp256k1' : 'not-supported',
          'pass_pub_key': peerFixture['serverPublic']
        }
      });
    }
    if (uri.path == '/auth/access-token') {
      if (delayLogin != null) return delayLogin!;
      final form = Uri.splitQueryString(body!);
      var password = form['password'];
      if (form['password_encrypted'] == 'true') {
        final bytes = base64Decode(password!), point = bytes.sublist(0, 65);
        // Server test key is scalar 1: shared point equals the received point.
        final key = hkdf(Uint8List.fromList([...point, ...point]), 32);
        final cipher = GCMBlockCipher(AESEngine())
          ..init(
              false,
              AEADParameters(
                  KeyParameter(key), 128, bytes.sublist(65, 81), Uint8List(0)));
        final plain = cipher.process(Uint8List.fromList(
            [...bytes.sublist(97), ...bytes.sublist(81, 97)]));
        password = object(jsonDecode(utf8.decode(plain)))['pass'] as String;
      }
      if (password != 'fixture-password') {
        return response({'error': 'invalid'}, code: 401);
      }
      return response({
        'access_token': 'fixture-access',
        'refresh_token': 'fixture-refresh',
        'ut_expire_at': DateTime.now().millisecondsSinceEpoch ~/ 1000 + 3600
      });
    }
    if (uri.path == '/auth/refresh-user-token') {
      refreshCount++;
      return response({
        'access_token': 'fixture-access',
        'refresh_token': 'fixture-next-refresh',
        'ut_expire_at': DateTime.now().millisecondsSinceEpoch ~/ 1000 + 3600
      });
    }
    if (uri.path.startsWith('/user-app/profile')) {
      return response({
        'data': {
          'basic': {'user_id': account},
          'passport': {'email': 'fixture@example.test'}
        }
      });
    }
    if (uri.path == '/device-app/device/list') {
      return response({
        'data_devices': [
          {
            'sn': peerFixture['serial'],
            'name': '合成验收设备',
            'model': 'Plaud Note',
            'prot_version': 20,
            'version_number': 'fixture'
          }
        ]
      });
    }
    if (uri.path == '/device-app/device/sn-sign') {
      return response({
        'data': {
          'signature': {peerFixture['serial']: fixtureRsa().snSignature}
        }
      });
    }
    if (uri.path.startsWith('/team-app/workspaces/list')) {
      return response({
        'data': [
          {'workspace_type': 'PERSONAL', 'workspace_id': 'fixture-workspace'}
        ]
      });
    }
    if (uri.path.startsWith('/user-app/auth/workspace/token/')) {
      return response({
        'data': {
          'workspace_token': 'fixture-workspace-token',
          'refresh_token': 'fixture-workspace-refresh'
        }
      });
    }
    if (uri.path == '/device-app/e2ee/gen_key') {
      return response({
        'data': {
          'public_key': peerFixture['publicKey'],
          'private_key': peerFixture['privateKey']
        }
      });
    }
    throw StateError('Unexpected test request: ${uri.path}');
  }
}

class PeerDevice implements DeviceLink {
  PeerDevice(
      {this.port = 20,
      this.wrongSerial = false,
      this.chunkDelay = Duration.zero});
  final int port;
  final bool wrongSerial;
  final Duration chunkDelay;
  final _incoming = StreamController<Uint8List>.broadcast(sync: true);
  final _closed = Completer<void>();
  final raw = base64Decode(peerFixture['encrypted'] as String);
  EncryptedCodec? _codec;
  final material = unhex(peerFixture['material'] as String);
  final writes = <Uint8List>[];
  final commands = <int>[];
  int downloadRequests = 0, receivedStart = 0, _transfer = 0;
  bool _second = false;
  @override
  Stream<Uint8List> get packets => _incoming.stream;
  @override
  Future<void> get closed => _closed.future;

  void _push(Uint8List packet, {bool encrypt = true}) {
    if (!_closed.isCompleted) {
      _incoming
          .add(encrypt && _codec != null ? _codec!.encode(packet) : packet);
    }
  }

  void emitRecording(Uint8List packet) => _push(packet);
  @override
  Future<void> write(Uint8List rawPacket) async {
    writes.add(Uint8List.fromList(rawPacket));
    if (_codec == null && port == 20) {
      final fe = rawPacket.length >= 2
          ? fields(rawPacket).getUint16(0, Endian.little)
          : -1;
      if (fe == 0xfe10 && rawPacket[3] == rawPacket[2] - 1) {
        _push(unhex('11fe00'), encrypt: false);
      }
      if (fe == 0xfe12 && rawPacket[3] == rawPacket[2] - 1) {
        final marker = chachaAead(
            material, Uint8List.fromList(utf8.encode('PLAUD.AI')),
            encrypt: true);
        final rsa = PKCS1Encoding(RSAEngine())
          ..init(
              true,
              PublicKeyParameter<RSAPublicKey>(
                  rsaPublic(peerFixture['publicKey'] as String)));
        final cipher =
            rsa.process(Uint8List.fromList([...material, ...marker]));
        for (final part in authFragments(0xfe12, cipher)) {
          _push(part, encrypt: false);
        }
        _codec = EncryptedCodec(material);
      }
      return;
    }
    final packet = _codec?.decode(rawPacket) ?? rawPacket,
        command = commandOf(_codec == null ? rawPacket : packet);
    if (command != null) commands.add(command);
    if (command == 1) {
      if (!_second) {
        _second = true;
        _push(Uint8List.fromList([
          1,
          2,
          0,
          ...utf8.encode(wrongSerial
              ? 'different-device'
              : peerFixture['serial'] as String),
          0
        ]));
      } else {
        _push(Uint8List.fromList([1, 1, 0, 0, port, 0, 0, 0, 1, 0, 0, 1]));
      }
    } else if (command == 3) {
      _push(unhex('010300000000000000000000000000'));
    } else if (command == 9) {
      _push(unhex('0109000042'));
    } else if (command == 6) {
      _push(unhex('01060000000040000000000000008000000000'));
    } else if (command == 26) {
      _push(Uint8List.fromList([
        1,
        26,
        0,
        ...packet.sublist(3, 7),
        1,
        0,
        0,
        0,
        ...le32(peerFixture['sessionId'] as int),
        ...le32(raw.length),
        0,
        0
      ]));
    } else if (command == 28) {
      downloadRequests++;
      receivedStart = fields(packet).getUint32(7, Endian.little);
      final generation = ++_transfer;
      _push(Uint8List.fromList(
          [1, 28, 0, ...le32(peerFixture['sessionId'] as int), 0]));
      unawaited(_sendAudio(generation, receivedStart));
    } else if (command == 29) {
      ++_transfer;
      _push(unhex('011e00'));
    }
  }

  Future<void> _sendAudio(int generation, int start) async {
    for (var offset = start; offset < raw.length; offset += 160) {
      await Future<void>.delayed(chunkDelay);
      if (_closed.isCompleted || generation != _transfer) return;
      final data = raw.sublist(offset, (offset + 160).clamp(0, raw.length));
      _push(Uint8List.fromList([
        2,
        ...le32(peerFixture['sessionId'] as int),
        ...le32(offset),
        data.length,
        ...data
      ]));
    }
    if (generation == _transfer && !_closed.isCompleted) {
      _push(Uint8List.fromList(
          [1, 29, 0, ...le32(peerFixture['sessionId'] as int), 0, 0]));
    }
  }

  @override
  Future<void> close() async {
    ++_transfer;
    if (!_closed.isCompleted) _closed.complete();
    await _incoming.close();
    _codec?.dispose();
  }
}
