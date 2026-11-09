import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

import '../../core/crypto/protocol_crypto.dart';
import '../../core/failure.dart';
import 'cloud_client.dart';
import 'models.dart';
import 'secret_store.dart';

class AuthController extends ChangeNotifier {
  AuthController({PlaudCloudClient? client, SecretStore? secrets})
      : client = client ?? PlaudCloudClient(),
        secrets = secrets ?? PlatformSecretStore() {
    this.client.onTokensChanged = (candidate) => _persist(candidate, _epoch);
  }
  final PlaudCloudClient client;
  final SecretStore secrets;
  CloudSession? session;
  CloudSession? _candidate;
  bool busy = false;
  bool restored = false;
  bool offline = false;
  String? error;
  int _epoch = 0;
  bool _disposed = false;
  Future<void> _writes = Future.value();

  String _keyName(String account) =>
      'rsa_${sha256.convert(utf8.encode(account))}';
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _check(int epoch) {
    if (_disposed || epoch != _epoch) {
      throw const AppFailure('SESSION_CHANGED', '账号操作已取消');
    }
  }

  Future<void> _persist(CloudSession current, int epoch) {
    final operation = _writes.then((_) async {
      _check(epoch);
      if (!identical(current, session) && !identical(current, _candidate)) {
        return;
      }
      if (current.rsa != null) {
        await secrets.write(
            _keyName(current.accountId), jsonEncode(current.rsa!.toJson()));
      }
      _check(epoch);
      await secrets.write('session_v1', jsonEncode(current.toJson()));
    });
    _writes = operation.catchError((Object _) {});
    return operation;
  }

  Future<void> _loadKeys(CloudSession current) async {
    final data = await secrets.read(_keyName(current.accountId));
    if (data != null) {
      final rsa = RsaMaterial.fromJson(object(jsonDecode(data)));
      validateRsaPair(rsa.publicKeyPem, rsa.privateKeyPem);
      current.rsa = rsa;
    }
  }

  Future<void> restore() async {
    if (busy || restored || _disposed) return;
    final epoch = ++_epoch;
    busy = true;
    error = null;
    offline = false;
    _notify();
    CloudSession? candidate;
    try {
      final encoded = await secrets.read('session_v1');
      _check(epoch);
      if (encoded == null) return;
      final current = CloudSession.fromJson(object(jsonDecode(encoded)));
      candidate = current;
      _candidate = current;
      await _loadKeys(current);
      _check(epoch);
      await client.restore(current);
      _check(epoch);
      current.verifiedAt = DateTime.now().millisecondsSinceEpoch;
      await _persist(current, epoch);
      _check(epoch);
      session = current;
    } catch (e) {
      if (epoch == _epoch && !_disposed) {
        session = null;
        final age = candidate?.verifiedAt == null
            ? null
            : DateTime.now().millisecondsSinceEpoch - candidate!.verifiedAt!;
        if (candidate != null &&
            age != null &&
            age >= 0 &&
            age <= const Duration(days: 7).inMilliseconds &&
            e is AppFailure &&
            ['CLOUD_NETWORK_ERROR', 'CLOUD_TIMEOUT'].contains(e.code) &&
            validToken(candidate.userToken) &&
            candidate.accountId.isNotEmpty) {
          session = candidate;
          offline = true;
          error = '当前为离线模式，可查看已保存的本机录音';
        } else {
          error = e is AppFailure ? e.message : '登录恢复失败，请重新登录';
        }
      }
    } finally {
      if (epoch == _epoch && !_disposed) {
        _candidate = null;
        busy = false;
        restored = true;
        _notify();
      }
    }
  }

  Future<void> login(String email, String password) async {
    if (busy || _disposed) return;
    final epoch = ++_epoch;
    busy = true;
    error = null;
    session = null;
    offline = false;
    _notify();
    try {
      final current = await client.login(email, password);
      _check(epoch);
      _candidate = current;
      await _loadKeys(current);
      _check(epoch);
      current.verifiedAt = DateTime.now().millisecondsSinceEpoch;
      await _persist(current, epoch);
      _check(epoch);
      session = current;
    } catch (e) {
      if (epoch == _epoch && !_disposed) {
        error = e is AppFailure ? e.message : '登录未完成，请检查网络后重试';
      }
      if (epoch == _epoch && !_disposed) rethrow;
    } finally {
      if (epoch == _epoch && !_disposed) {
        _candidate = null;
        busy = false;
        restored = true;
        _notify();
      }
    }
  }

  Future<void> refreshDevices() async {
    final current = session;
    if (current == null || busy) return;
    final epoch = _epoch;
    busy = true;
    error = null;
    _notify();
    try {
      await client.restore(current);
      _check(epoch);
      offline = false;
      current.verifiedAt = DateTime.now().millisecondsSinceEpoch;
      await _persist(current, epoch);
    } on AppFailure catch (e) {
      if (epoch == _epoch) {
        error = e.message;
        if (e.code == 'SESSION_EXPIRED') session = null;
      }
      rethrow;
    } finally {
      if (epoch == _epoch && !_disposed) {
        busy = false;
        _notify();
      }
    }
  }

  Future<DeviceCredentials> prepare(String serial, int port) async {
    final current = session;
    if (current == null) {
      throw const AppFailure('LOGIN_REQUIRED', '请先登录 PLAUD 账号');
    }
    if (offline) {
      throw const AppFailure('OFFLINE_LOCAL_ONLY', '当前离线模式仅可读取本机录音，请联网后刷新账号');
    }
    if (busy) throw const AppFailure('ACCOUNT_BUSY', '账号操作进行中，请稍候');
    final epoch = _epoch;
    busy = true;
    error = null;
    _notify();
    try {
      final credentials = await client.prepare(current, serial, port);
      _check(epoch);
      await _persist(current, epoch);
      _check(epoch);
      return credentials;
    } on AppFailure catch (e) {
      if (epoch == _epoch) {
        error = e.message;
        if (e.code == 'SESSION_EXPIRED') session = null;
      }
      rethrow;
    } finally {
      if (epoch == _epoch && !_disposed) {
        busy = false;
        _notify();
      }
    }
  }

  Future<void> logout() async {
    ++_epoch;
    session = null;
    _candidate = null;
    busy = false;
    error = null;
    restored = true;
    offline = false;
    _notify();
    final operation = _writes.then((_) => secrets.delete('session_v1'));
    _writes = operation.catchError((Object _) {});
    await operation;
  }

  @override
  void dispose() {
    _disposed = true;
    ++_epoch;
    super.dispose();
  }
}
