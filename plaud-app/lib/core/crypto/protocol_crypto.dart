import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as hashes;
import 'package:pointycastle/asn1.dart';
import 'package:pointycastle/export.dart';

import '../failure.dart';

Uint8List randomBytes(int length) {
  final random = Random.secure();
  return Uint8List.fromList(List.generate(length, (_) => random.nextInt(256)));
}

bool equalBytes(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var difference = 0;
  for (var i = 0; i < a.length; i++) {
    difference |= a[i] ^ b[i];
  }
  return difference == 0;
}

Uint8List hkdf(Uint8List input, int length) {
  final generator = HKDFKeyDerivator(SHA256Digest())
    ..init(HkdfParameters(input, length, Uint8List(0), Uint8List(0)));
  return generator.process(Uint8List(0));
}

Uint8List chachaAead(Uint8List material, Uint8List input,
    {required bool encrypt}) {
  if (material.length != 56) {
    throw const AppFailure('SESSION_INVALID', '设备会话材料无效');
  }
  final cipher = ChaCha20Poly1305(ChaCha7539Engine(), Poly1305())
    ..init(
        encrypt,
        AEADParameters(KeyParameter(material.sublist(0, 32)), 128,
            material.sublist(32, 44), material.sublist(44, 56)));
  try {
    final output = Uint8List(cipher.getOutputSize(input.length));
    final processed = cipher.processBytes(input, 0, input.length, output, 0);
    final finalLength = cipher.doFinal(output, processed);
    return output.sublist(0, processed + finalLength);
  } catch (_) {
    throw const AppFailure('SESSION_DECRYPT_FAILED', '设备会话校验失败，请重新连接');
  }
}

Uint8List _pemBytes(String pem) {
  final body = pem
      .split('\n')
      .where((line) => !line.startsWith('-----'))
      .join()
      .replaceAll(RegExp(r'\s'), '');
  if (body.isEmpty || body.length > 32768) {
    throw const FormatException('Invalid PEM');
  }
  return base64Decode(body);
}

RSAPrivateKey rsaPrivate(String pem) {
  try {
    var sequence = ASN1Parser(_pemBytes(pem)).nextObject() as ASN1Sequence;
    if (sequence.elements!.length == 3 &&
        sequence.elements![2] is ASN1OctetString) {
      sequence = ASN1Parser((sequence.elements![2] as ASN1OctetString).octets)
          .nextObject() as ASN1Sequence;
    }
    final items = sequence.elements!;
    if (items.length != 9) throw const FormatException('Invalid RSA');
    BigInt n(int i) => (items[i] as ASN1Integer).integer!;
    final key = RSAPrivateKey(n(1), n(3), n(4), n(5));
    final p1 = n(4) - BigInt.one, q1 = n(5) - BigInt.one;
    if ((n(3) * n(2)) % (p1 ~/ p1.gcd(q1) * q1) != BigInt.one) {
      throw const FormatException('Invalid RSA exponent');
    }
    return key;
  } catch (_) {
    throw const AppFailure('RSA_KEYS_INVALID', '账号 RSA 私钥材料无效');
  }
}

RSAPublicKey rsaPublic(String pem) {
  try {
    var sequence = ASN1Parser(_pemBytes(pem)).nextObject() as ASN1Sequence;
    if (sequence.elements![0] is ASN1Sequence) {
      sequence = ASN1Parser(Uint8List.fromList(
              (sequence.elements![1] as ASN1BitString).stringValues!))
          .nextObject() as ASN1Sequence;
    }
    if (sequence.elements!.length != 2) {
      throw const FormatException('Invalid RSA');
    }
    return RSAPublicKey((sequence.elements![0] as ASN1Integer).integer!,
        (sequence.elements![1] as ASN1Integer).integer!);
  } catch (_) {
    throw const AppFailure('RSA_KEYS_INVALID', '账号 RSA 公钥材料无效');
  }
}

void validateRsaPair(String publicPem, String privatePem) {
  final public = rsaPublic(publicPem), private = rsaPrivate(privatePem);
  final p = private.p! - BigInt.one, q = private.q! - BigInt.one;
  if (public.modulus != private.modulus ||
      (public.publicExponent! * private.privateExponent!) %
              (p ~/ p.gcd(q) * q) !=
          BigInt.one) {
    throw const AppFailure('RSA_KEYS_INVALID', '账号公私钥不匹配');
  }
}

Uint8List rsaDecrypt(String pem, Uint8List input) {
  try {
    final cipher = PKCS1Encoding(RSAEngine())
      ..init(false, PrivateKeyParameter<RSAPrivateKey>(rsaPrivate(pem)));
    return cipher.process(input);
  } catch (_) {
    throw const AppFailure('RSA_DECRYPT_FAILED', '无法解开设备材料，请核对账号与密钥');
  }
}

String decryptCloudResponse(String body) {
  // Public interoperability material from the accepted Web implementation.
  final key = base64Url.decode('8rRmMCskL3NaUiGr-UsmEEeI8NKH-ZfeGbpRGqSLpuI=');
  try {
    if (!RegExp(r'^[\w=-]+$').hasMatch(body.trim())) {
      throw const FormatException();
    }
    final token = base64Url.decode(base64Url.normalize(body.trim()));
    if (token.length < 73 || token[0] != 0x80) throw const FormatException();
    final signatureAt = token.length - 32;
    final mac = hashes.Hmac(hashes.sha256, key.sublist(0, 16))
        .convert(token.sublist(0, signatureAt))
        .bytes;
    if (!equalBytes(mac, token.sublist(signatureAt))) {
      throw const FormatException();
    }
    final cipher =
        PaddedBlockCipherImpl(PKCS7Padding(), CBCBlockCipher(AESEngine()))
          ..init(
              false,
              PaddedBlockCipherParameters<ParametersWithIV<KeyParameter>, Null>(
                  ParametersWithIV(
                      KeyParameter(Uint8List.fromList(key.sublist(16))),
                      Uint8List.fromList(token.sublist(9, 25))),
                  null));
    return utf8.decode(
        cipher.process(Uint8List.fromList(token.sublist(25, signatureAt))));
  } catch (_) {
    throw const AppFailure('ENCRYPTED_RESPONSE_INVALID', '云端加密响应校验失败');
  }
}

/// secp256k1 login envelope; this curve is unrelated to BLE's optional P-256.
String encryptLoginPassword(String password, Uint8List publicKey,
    {Uint8List? privateKey, Uint8List? iv, int? unixSeconds}) {
  final curve = ECDomainParameters('secp256k1');
  final secret = privateKey ?? randomBytes(32);
  Uint8List? key;
  try {
    var scalar = BigInt.parse(
        secret.map((v) => v.toRadixString(16).padLeft(2, '0')).join(),
        radix: 16);
    if (privateKey == null) {
      scalar = scalar % (curve.n - BigInt.one) + BigInt.one;
    }
    if (scalar <= BigInt.zero || scalar >= curve.n) {
      throw const FormatException();
    }
    final remote = curve.curve.decodePoint(publicKey);
    if (remote == null || remote.isInfinity) throw const FormatException();
    final ephemeral = (curve.G * scalar)!.getEncoded(false);
    final shared = (remote * scalar)!.getEncoded(false);
    key = hkdf(Uint8List.fromList([...ephemeral, ...shared]), 32);
    final nonce = iv ?? randomBytes(16);
    final cipher = GCMBlockCipher(AESEngine())
      ..init(true, AEADParameters(KeyParameter(key), 128, nonce, Uint8List(0)));
    final plain = utf8.encode(jsonEncode({
      'pass': password,
      'time': unixSeconds ?? DateTime.now().millisecondsSinceEpoch ~/ 1000
    }));
    final result = cipher.process(Uint8List.fromList(plain));
    return base64Encode([
      ...ephemeral,
      ...nonce,
      ...result.sublist(result.length - 16),
      ...result.sublist(0, result.length - 16)
    ]);
  } catch (_) {
    throw const AppFailure('PASSWORD_ENCRYPTION_FAILED', '无法完成登录密码封装');
  } finally {
    if (privateKey == null) secret.fillRange(0, secret.length, 0);
    key?.fillRange(0, key.length, 0);
  }
}
