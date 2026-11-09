import 'dart:convert';
import 'package:flutter/foundation.dart';
import '../auth/secret_store.dart';
import '../../core/failure.dart';
import 'models.dart';

class AssemblySettings extends ChangeNotifier {
  AssemblySettings({SecretStore? secrets})
      : secrets = secrets ?? PlatformSecretStore();
  final SecretStore secrets;
  AssemblyConfig? config;
  String? error;
  String scope = '';
  bool loading = false, _disposed = false;
  int _epoch = 0;
  Future<void> _writes = Future.value();
  String _key(String owner) => 'aai_${digestText(owner)}';
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> activate(String? account) async {
    final owner = ownerScope(account);
    if (owner == scope || _disposed) return;
    scope = owner;
    config = null;
    error = null;
    loading = true;
    final epoch = ++_epoch;
    _notify();
    try {
      await _writes;
      final raw = await secrets.read(_key(owner));
      if (epoch == _epoch && !_disposed) {
        config = raw == null
            ? null
            : AssemblyConfig.fromJson(mapOf(jsonDecode(raw)));
      }
    } catch (_) {
      if (epoch == _epoch && !_disposed) error = '转写设置暂时无法读取，请重新配置';
    } finally {
      if (epoch == _epoch && !_disposed) {
        loading = false;
        _notify();
      }
    }
  }

  Future<void> save(AssemblyConfig? value) async {
    value?.validate();
    final owner = scope, epoch = _epoch;
    final operation = _writes.then((_) async {
      if (_disposed || owner != scope || epoch != _epoch || loading) {
        throw const AppFailure('SCOPE_DENIED', '账号已改变，请重新打开转写设置');
      }
      if (value == null) {
        await secrets.delete(_key(owner));
      } else {
        await secrets.write(_key(owner), jsonEncode(value.toJson()));
      }
      if (!_disposed && owner == scope && epoch == _epoch) {
        config = value;
        error = null;
        _notify();
      }
    });
    _writes = operation.catchError((Object _) {});
    return operation;
  }

  @override
  void dispose() {
    _disposed = true;
    ++_epoch;
    config = null;
    super.dispose();
  }
}
