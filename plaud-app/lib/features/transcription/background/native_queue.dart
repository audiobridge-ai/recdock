import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart';
import '../../../core/failure.dart';
import '../models.dart';

abstract interface class BackgroundTranscriptionQueue {
  Future<void> activate(String namespace);
  Future<void> enqueue(TranscriptionJob job, AssemblyConfig config, File audio,
      String namespace);
  Future<List<Json>> snapshot();
  Future<void> cancel(String id);
  Future<void> acknowledge(String id);
  Future<void> foreground(bool value);
  Future<bool> notifications();
}

/// Native code owns the durable execution journal; Flutter owns transcript versions.
class NativeTranscriptionQueue implements BackgroundTranscriptionQueue {
  const NativeTranscriptionQueue({this.testBase});
  final String? testBase;
  static const channel = MethodChannel('ai.audiobridge.recdock/background');
  Future<T?> _call<T>(String method, [Json? args]) async {
    try {
      return await channel.invokeMethod<T>(method, args);
    } on PlatformException {
      throw const AppFailure('BACKGROUND_TASK_FAILED', '后台任务暂不可用，任务和原文件已保留');
    }
  }

  @override
  Future<void> activate(String namespace) =>
      _call('activate', {'namespace': namespace});
  @override
  Future<void> enqueue(TranscriptionJob job, AssemblyConfig config, File audio,
          String namespace) =>
      _call('enqueue', {
        'json': jsonEncode({
          ...job.toJson(),
          'apiKey': config.apiKey,
          'audioPath': audio.path,
          'namespace': namespace,
          if (testBase != null) 'testBase': testBase,
        })
      });
  @override
  Future<List<Json>> snapshot() async =>
      (jsonDecode(await _call<String>('snapshot') ?? '[]') as List)
          .map(mapOf)
          .toList();
  @override
  Future<void> cancel(String id) => _call('cancel', {'id': id});
  @override
  Future<void> acknowledge(String id) => _call('ack', {'id': id});
  @override
  Future<void> foreground(bool value) => _call('foreground', {'value': value});
  @override
  Future<bool> notifications() async =>
      await _call<bool>('notifications') ?? false;
}
