import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:plaud_app/features/library/recording_store.dart';
import 'package:plaud_app/features/transcription/background/native_queue.dart';
import 'package:plaud_app/features/transcription/models.dart';
import 'package:plaud_app/features/transcription/settings.dart';
import 'package:plaud_app/features/transcription/transcription_controller.dart';
import 'fixtures/peer_material.dart';
import 'helpers/assembly_peer.dart';
import 'helpers/peer.dart';

class JournalQueue implements BackgroundTranscriptionQueue {
  String scope = '';
  bool visible = true, failAck = false;
  int enqueues = 0;
  final jobs = <String, Json>{};
  @override
  Future<void> activate(String namespace) async {
    scope = namespace;
  }

  @override
  Future<void> enqueue(TranscriptionJob job, AssemblyConfig config, File audio,
      String namespace) async {
    expect(namespace, scope);
    expect(await audio.exists(), true);
    enqueues++;
    jobs.putIfAbsent(job.id, () => {...job.toJson(), 'namespace': namespace});
  }

  @override
  Future<List<Json>> snapshot() async =>
      jobs.values.where((j) => j['namespace'] == scope).map(cloneJson).toList();
  @override
  Future<void> acknowledge(String id) async {
    if (failAck) throw StateError('crash window');
    jobs.remove(id);
  }

  @override
  Future<void> cancel(String id) async {
    jobs[id]!['state'] = 'cancelled';
  }

  @override
  Future<void> foreground(bool value) async {
    visible = value;
  }

  @override
  Future<bool> notifications() async => false;
}

void main() {
  late Directory root;
  late RecordingStore library;
  late LocalRecording recording;
  late AssemblySettings settings;
  late TranscriptionController controller;
  late JournalQueue queue;
  const config = AssemblyConfig(apiKey: syntheticAssemblyKey);
  setUp(() async {
    root = await Directory.systemTemp.createTemp('recdock-phase3-');
    library = RecordingStore(Directory('${root.path}/library'));
    final source = await File('${root.path}/fixture.ogg')
        .writeAsBytes(base64Decode(peerFixture['ogg'] as String));
    recording = await library.importFile(source);
    queue = JournalQueue();
    settings = AssemblySettings(secrets: MemorySecrets());
    controller = TranscriptionController(
        library: library,
        settings: settings,
        nativeQueue: queue,
        pollInterval: const Duration(days: 1));
    await controller.activate(null);
    await settings.save(config);
  });
  tearDown(() async {
    controller.dispose();
    settings.dispose();
    await root.delete(recursive: true);
  });
  Future<void> start() => controller.start(recording, durationMs: 2000);
  void ready() {
    final j = queue.jobs.values.single;
    j.addAll({
      'state': 'syncing',
      'uploadUrl': syntheticUpload,
      'remoteId': syntheticRemoteId,
      'result': assemblyResult()
    });
  }

  test('用户批准后立即持久入队，同录音不重复；后台不取消原生任务', () async {
    await start();
    await start();
    expect(queue.enqueues, 1);
    expect(controller.activeTaskCount, 1);
    controller.setForeground(false);
    await Future<void>.delayed(Duration.zero);
    expect(queue.visible, false);
    expect(queue.jobs, hasLength(1));
    expect((await controller.store.load(recording)).latest!.state,
        'waiting_upload');
    expect(jsonEncode(queue.jobs), isNot(contains(syntheticAssemblyKey)));
  });
  test('入队标记已落盘而原生入队尚未完成，恢复后按原 ID 补齐', () async {
    await start();
    final id = queue.jobs.keys.single;
    queue.jobs.clear();
    controller.dispose();
    controller = TranscriptionController(
        library: library,
        settings: settings,
        nativeQueue: queue,
        pollInterval: const Duration(days: 1));
    await controller.activate(null);
    expect(queue.jobs.keys.single, id);
    expect(queue.enqueues, 2);
  });
  test('后台结果保存与原生确认之间失败，重试不重复创建版本', () async {
    await start();
    ready();
    queue.failAck = true;
    await controller.poll();
    expect((await controller.store.load(recording)).revisions, hasLength(1));
    queue.failAck = false;
    await controller.poll();
    await controller.poll();
    expect((await controller.store.load(recording)).revisions, hasLength(1));
    expect(queue.jobs, isEmpty);
  });
  test('后台结果来源不符保留日志，不生成错误转写版本', () async {
    await start();
    ready();
    mapOf(queue.jobs.values.single['result']);
    (queue.jobs.values.single['result'] as Json)['audio_url'] =
        'https://cdn.assemblyai.com/upload/wrong';
    await controller.poll();
    expect((await controller.store.load(recording)).revisions, isEmpty);
    expect(queue.jobs, hasLength(1));
  });
  test('提交状态不明不重新入队，可保留任务供用户核对', () async {
    await start();
    queue.jobs.values.single['state'] = 'uncertain';
    await controller.poll();
    await start();
    await controller.poll();
    expect(queue.enqueues, 1);
    expect(controller.snapshots[recording.id]!.latest!.state, 'uncertain');
  });
  test('更换 Key 隐藏旧原生范围，恢复原 Key 后仍可同步', () async {
    await start();
    final original = queue.scope;
    ready();
    await settings
        .save(const AssemblyConfig(apiKey: 'another-synthetic-valid-key'));
    await controller.poll();
    expect(queue.scope, isNot(original));
    expect((await controller.store.load(recording)).revisions, isEmpty);
    await settings.save(config);
    await controller.poll();
    expect(queue.scope, original);
    expect((await controller.store.load(recording)).revisions, hasLength(1));
  });
  test('排队取消可落盘，之后重新转写必须创建新的用户批准任务', () async {
    await start();
    await controller.cancelPending(recording);
    expect(controller.snapshots[recording.id]!.latest!.state, 'cancelled');
    await start();
    expect(queue.jobs, hasLength(2));
    expect(controller.activeTaskCount, 1);
  });
}
