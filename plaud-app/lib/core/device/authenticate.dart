import 'dart:convert';
import 'dart:typed_data';

import '../../features/auth/models.dart';
import '../crypto/protocol_crypto.dart';
import '../failure.dart';
import '../protocol/bytes.dart';
import '../protocol/status.dart';
import 'packet_io.dart';

abstract interface class SessionCodec {
  Uint8List encode(Uint8List bytes);
  Uint8List decode(Uint8List bytes);
  void dispose();
}

class PlainCodec implements SessionCodec {
  @override
  Uint8List encode(Uint8List bytes) => bytes;
  @override
  Uint8List decode(Uint8List bytes) => bytes;
  @override
  void dispose() {}
}

class ReplayFailure implements Exception {}

class EncryptedCodec implements SessionCodec {
  EncryptedCodec(Uint8List material)
      : _material = Uint8List.fromList(material) {
    if (material.length != 56) {
      throw const AppFailure('SESSION_INVALID', '设备会话材料无效');
    }
  }
  final Uint8List _material;
  var _tx = 1, _rx = -1;
  bool _disposed = false;
  @override
  Uint8List encode(Uint8List bytes) {
    if (_disposed || _tx >= 2147483647) {
      throw const AppFailure('SESSION_CLOSED', '请重新连接设备');
    }
    final sequence = ByteData(4)..setInt32(0, ++_tx, Endian.little);
    return chachaAead(_material,
        Uint8List.fromList([...sequence.buffer.asUint8List(), ...bytes]),
        encrypt: true);
  }

  @override
  Uint8List decode(Uint8List bytes) {
    if (_disposed) throw const AppFailure('SESSION_CLOSED', '请重新连接设备');
    final plain = chachaAead(_material, bytes, encrypt: false);
    if (plain.length < 4) throw const AppFailure('SESSION_INVALID', '设备响应缺少序号');
    final sequence = fields(plain).getInt32(0, Endian.little);
    if (sequence <= _rx) throw ReplayFailure();
    _rx = sequence;
    return plain.sublist(4);
  }

  @override
  void dispose() {
    _disposed = true;
    _material.fillRange(0, _material.length, 0);
  }
}

Uint8List legacyHandshake(String token, int port,
    {bool second = false, String extra8 = '', String extraText = ''}) {
  final size = port >= 9 ? 32 : 16;
  final tail = utf8.encode(token.padRight(size, '0').substring(0, size));
  final bytes = <int>[1, 1, 0, 2, 0, if (port >= 3) second ? 1 : 0, ...tail];
  if (second && (extra8.isNotEmpty || extraText.isNotEmpty)) {
    final fixed = Uint8List(8), additional = utf8.encode(extraText);
    final encoded = utf8.encode(extra8);
    fixed.setRange(0, encoded.length.clamp(0, 8), encoded);
    if (additional.length > 255) {
      throw const AppFailure('HANDSHAKE_INVALID', '设备握手扩展字段过长');
    }
    bytes.addAll([...fixed, additional.length, ...additional]);
  }
  return Uint8List.fromList(bytes);
}

List<Uint8List> authFragments(int command, Uint8List material) {
  final total = (material.length / 100).ceil();
  if (total == 0 || total > 255) {
    throw const AppFailure('HANDSHAKE_INVALID', '设备握手材料长度无效');
  }
  return List.generate(
      total,
      (i) => Uint8List.fromList([
            command & 255,
            command >> 8,
            total,
            i,
            ...material.sublist(
                i * 100, ((i + 1) * 100).clamp(0, material.length))
          ]));
}

int? _fe(Uint8List bytes) =>
    bytes.length >= 2 ? fields(bytes).getUint16(0, Endian.little) : null;

class AuthIo {
  const AuthIo(
      {required this.send,
      required this.receive,
      required this.stage,
      required this.handshake});
  final Future<void> Function(Uint8List) send;
  final Future<Uint8List> Function(PacketPredicate, Duration) receive;
  final void Function(String) stage;
  final void Function(Uint8List) handshake;
}

Future<SessionCodec> authenticateDevice(
    AuthIo io, DeviceCredentials credentials) async {
  final c = credentials;
  if (!validPortNumber(c.portVersion) ||
      c.token.isEmpty ||
      !RegExp(r'^[\x20-\x7e]+$').hasMatch(c.token) ||
      RegExp(r'^(?:Bearer\s|eyJ[^.]*\.)').hasMatch(c.token)) {
    throw const AppFailure('CREDENTIALS_INVALID', '账号与设备认证材料不完整');
  }
  if (c.portVersion == 30) {
    throw const AppFailure('UNSUPPORTED_AUTO_ECC', '此版本尚未支持 ECC 设备认证');
  }
  SessionCodec? codec;
  try {
    if (c.portVersion == 20) {
      final rsa = c.rsa;
      if (rsa == null || c.serialNumber.isEmpty) {
        throw const AppFailure('CREDENTIALS_INVALID', '缺少账号 RSA 认证材料');
      }
      io.stage('正在验证设备签名');
      for (final part in authFragments(0xfe10, base64Decode(rsa.snSignature))) {
        await io.send(part);
      }
      var first = await io.receive(
          (b) => [0xfe11, 0xfe12, 0xfe30].contains(_fe(b)),
          const Duration(seconds: 15));
      if (_fe(first) == 0xfe30) {
        throw const AppFailure('PROTOCOL_MISMATCH', '设备协议与认证材料不一致');
      }
      if (_fe(first) == 0xfe11) {
        for (final part in authFragments(
            0xfe12, Uint8List.fromList(utf8.encode(rsa.publicKeyPem)))) {
          await io.send(part);
        }
        first = Uint8List(0);
      }
      final parts = <int, Uint8List>{};
      var total = 0;
      final deadline = DateTime.now().add(const Duration(seconds: 20));
      do {
        final remaining = deadline.difference(DateTime.now());
        if (remaining.isNegative) {
          throw const AppFailure('DEVICE_TIMEOUT', '设备认证响应超时');
        }
        final part = first.isEmpty
            ? await io.receive((b) => _fe(b) == 0xfe12, remaining)
            : first;
        first = Uint8List(0);
        if (part.length < 5 ||
            part[2] == 0 ||
            part[3] >= part[2] ||
            (total != 0 && total != part[2])) {
          throw const AppFailure('HANDSHAKE_INVALID', '设备认证分片无效');
        }
        total = part[2];
        final value = part.sublist(4), prior = parts[part[3]];
        if (prior != null && !equalBytes(prior, value)) {
          throw const AppFailure('HANDSHAKE_INVALID', '设备认证分片冲突');
        }
        parts[part[3]] = value;
      } while (parts.length != total);
      final material = rsaDecrypt(rsa.privateKeyPem,
          Uint8List.fromList([for (var i = 0; i < total; i++) ...parts[i]!]));
      try {
        if (material.length < 80) {
          throw const AppFailure('HANDSHAKE_INVALID', '设备认证会话材料无效');
        }
        final marker = chachaAead(material.sublist(0, 56), material.sublist(56),
            encrypt: false);
        if (utf8.decode(marker) != 'PLAUD.AI') {
          throw const AppFailure('HANDSHAKE_INVALID', '设备认证标记不匹配');
        }
        codec = EncryptedCodec(material.sublist(0, 56));
      } finally {
        material.fillRange(0, material.length, 0);
      }
    } else {
      codec = PlainCodec();
    }
    io.stage('正在确认账号与设备');
    await io.send(codec.encode(legacyHandshake(c.token, c.portVersion)));
    final deadline = DateTime.now().add(const Duration(seconds: 15));
    var secondSent = false;
    while (DateTime.now().isBefore(deadline)) {
      final raw =
          await io.receive((_) => true, deadline.difference(DateTime.now()));
      Uint8List packet;
      try {
        packet = codec.decode(raw);
      } on ReplayFailure {
        continue;
      }
      if (commandOf(packet) == 2 && !secondSent) {
        if (packet.length < 4) {
          throw const AppFailure('HANDSHAKE_INVALID', '设备身份响应过短');
        }
        final serial = utf8
            .decode(packet.sublist(3, packet.length.clamp(0, 59)),
                allowMalformed: true)
            .split('\u0000')
            .first;
        if (serial.isNotEmpty && serial != c.serialNumber) {
          throw const AppFailure('DEVICE_IDENTITY_MISMATCH', '设备身份与账号绑定信息不一致');
        }
        secondSent = true;
        await io.send(codec.encode(legacyHandshake(c.token, c.portVersion,
            second: true,
            extra8: c.secondExtra8,
            extraText: c.secondExtraText)));
      } else if (commandOf(packet) == 1) {
        final ack = decodeHandshake(packet);
        if (ack.status != 0) {
          throw const AppFailure('AUTH_REJECTED', '设备拒绝认证，请确认账号与设备');
        }
        if (ack.portVersion != null && ack.portVersion != c.portVersion) {
          throw const AppFailure('PROTOCOL_MISMATCH', '设备协议版本发生变化，请重新扫描连接');
        }
        io.handshake(packet);
        return codec;
      }
    }
    throw const AppFailure('DEVICE_TIMEOUT', '设备认证响应超时');
  } catch (_) {
    codec?.dispose();
    rethrow;
  }
}

bool validPortNumber(int port) => port >= 1 && port <= 65535;
