import 'package:flutter/services.dart';

abstract interface class SecretStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// Implemented by Keychain / Keystore-backed storage in the two host projects.
class PlatformSecretStore implements SecretStore {
  static const _channel = MethodChannel('ai.audiobridge.recdock/secrets');
  @override
  Future<String?> read(String key) =>
      _channel.invokeMethod<String>('read', {'key': key});
  @override
  Future<void> write(String key, String value) =>
      _channel.invokeMethod<void>('write', {'key': key, 'value': value});
  @override
  Future<void> delete(String key) =>
      _channel.invokeMethod<void>('delete', {'key': key});
}
