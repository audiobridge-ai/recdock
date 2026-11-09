import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:plaud_app/core/failure.dart';
import 'package:plaud_app/features/library/recording_store.dart';
import 'package:plaud_app/features/transcription/assembly_client.dart';
import 'package:plaud_app/features/transcription/models.dart';
import 'package:plaud_app/features/transcription/settings.dart';
import 'package:plaud_app/features/transcription/transcript_adapter.dart';
import 'package:plaud_app/features/transcription/transcript_export.dart';
import 'package:plaud_app/features/transcription/transcription_controller.dart';
import 'fixtures/peer_material.dart';
import 'helpers/assembly_peer.dart';
import 'helpers/peer.dart';

void main() {
  late Directory root;
  late RecordingStore library;
  late LocalRecording recording;
  late MemorySecrets secrets;
  late AssemblySettings settings;
  late SyntheticAssembly peer;
  late TranscriptionController controller;
  const config = AssemblyConfig(
      apiKey: syntheticAssemblyKey, language: 'zh', region: 'eu');
  Future<void> start() => controller.start(recording, durationMs: 2000);
  Future<void> finish() async {
    await start();
    await controller.refresh(recording);
    await controller.refresh(recording);
  }

  setUp(() async {
    root = await Directory.systemTemp.createTemp('recdock-phase2-');
    library = RecordingStore(Directory(p.join(root.path, 'library')));
    final source = await File(p.join(root.path, 'synthetic.ogg'))
        .writeAsBytes(base64Decode(peerFixture['ogg'] as String));
    recording = await library.importFile(source, title: '合成录音');
    secrets = MemorySecrets();
    settings = AssemblySettings(secrets: secrets);
    peer = SyntheticAssembly();
    controller = TranscriptionController(
        library: library,
        settings: settings,
        client: AssemblyClient(transport: peer),
        pollInterval: const Duration(days: 1));
    await controller.activate(null);
    await settings.save(config);
  });
  tearDown(() async {
    controller.dispose();
    settings.dispose();
    await root.delete(recursive: true);
  });
  test('未配置不发请求；Key 按账号范围隔离且不落任务索引', () async {
    await settings.save(null);
    await expectLater(
        start(),
        throwsA(isA<AppFailure>()
            .having((e) => e.code, 'code', 'AAI_KEY_REQUIRED')));
    expect(peer.requests, isEmpty);
    await settings.save(config);
    await settings.activate('account-B');
    expect(settings.config, isNull);
    await settings.activate(null);
    expect(settings.config!.apiKey, syntheticAssemblyKey);
    await start();
    final index = await File(p.join(library.originalFile(recording).parent.path,
            'transcription', 'index.json'))
        .readAsString();
    expect(index, isNot(contains(syntheticAssemblyKey)));
    expect(index, contains(config.fingerprint));
  });
  test('真实文件流上传、EU 路由、参数与重复点击只创建一次任务', () async {
    await Future.wait([start(), start()]);
    expect(peer.uploads, 1);
    expect(peer.submissions, 1);
    final upload = peer.requests.first;
    expect(upload.uri.host, 'api.eu.assemblyai.com');
    expect(upload.key, syntheticAssemblyKey);
    expect(upload.contentType, 'application/octet-stream');
    expect(upload.length, upload.body.length);
    expect(upload.body, await library.audioFile(recording).readAsBytes());
    final params = mapOf(jsonDecode(utf8.decode(peer.requests[1].body)));
    expect(params['speaker_labels'], true);
    expect(params['language_code'], 'zh');
    expect(params['speech_models'], ['universal-3-5-pro', 'universal-2']);
    expect(params.containsKey('language_detection'), false);
    expect(controller.snapshots[recording.id]!.latest!.state, 'queued');
  });
  test('queued→processing→completed 保存全文、毫秒与讲话人，重复查询不增加版本', () async {
    await finish();
    final revision = (await controller.store.readRevision(recording))!;
    expect(revision.segments.last['startMs'], 1000);
    expect(revision.speakers.map((s) => s['displayName']), ['说话人 1', '说话人 2']);
    expect(revision.segments.first['words'][0]['startMs'], 0);
    expect(mapOf(mapOf(revision.transcript['provenance'])['asr'])['model'],
        'universal-2');
    await controller.refresh(recording);
    expect((await controller.store.load(recording)).revisions, hasLength(1));
    expect(peer.submissions, 1);
  });
  test('重建后仅查询已有任务，不重传、不重新提交', () async {
    peer.autoComplete = false;
    await start();
    controller.dispose();
    settings.dispose();
    settings = AssemblySettings(secrets: secrets);
    controller = TranscriptionController(
        library: library,
        settings: settings,
        client: AssemblyClient(transport: peer),
        pollInterval: const Duration(days: 1));
    await controller.activate(null);
    while (controller.busy.isNotEmpty) {
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    expect(peer.uploads, 1);
    expect(peer.submissions, 1);
    expect(peer.gets, greaterThanOrEqualTo(1));
    expect(controller.snapshots[recording.id]!.latest!.remoteId,
        syntheticRemoteId);
  });
  for (final failure in ['unknown', 'malformed', '500']) {
    test('提交 $failure 后保留 uncertain；重启和再次点击不重发，正确关联才恢复', () async {
      peer.submitFailure = failure;
      await expectLater(
          start(),
          throwsA(isA<AppFailure>()
              .having((e) => e.code, 'code', 'AAI_SUBMIT_UNKNOWN')));
      expect(
          (await controller.store.load(recording)).latest!.state, 'uncertain');
      await controller.reload(recover: true);
      await controller.poll();
      await start();
      expect(peer.submissions, 1);
      expect(peer.uploads, 1);
      peer.getReply = AssemblyReply(
          200,
          jsonEncode(assemblyResult(
              uploadUrl: 'https://cdn.assemblyai.com/upload/different')));
      await expectLater(controller.attach(recording, syntheticRemoteId),
          throwsA(isA<AppFailure>()));
      expect((await controller.store.load(recording)).latest!.remoteId, isNull);
      peer.getReply = AssemblyReply(200, jsonEncode(assemblyResult()));
      await controller.attach(recording, syntheticRemoteId);
      expect(
          (await controller.store.load(recording)).latest!.state, 'completed');
      expect(peer.submissions, 1);
    });
  }
  test('明确 401 拒绝不误记结果未知，不自动重试收费请求', () async {
    peer.submitFailure = '401';
    await expectLater(start(), throwsA(isA<AppFailure>()));
    expect((await controller.store.load(recording)).latest!.state, 'error');
    await controller.poll();
    expect(peer.submissions, 1);
  });
  test('上传中暂停会关闭请求且不提交；本机原件保留', () async {
    peer.uploadGate = Completer<void>();
    final operation = start();
    while (peer.uploads == 0) {
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    controller.pause(recording.id);
    await expectLater(operation, throwsA(isA<AppFailure>()));
    expect(
        (await controller.store.load(recording)).latest!.state, 'interrupted');
    expect(peer.submissions, 0);
    expect(await library.originalFile(recording).exists(), true);
  });
  test('提交前断点上传不自动变成收费任务，需要显式继续提交', () async {
    await start();
    final job = (await controller.store.load(recording)).latest!;
    job.state = 'uploaded';
    job.remoteId = null;
    await controller.store.saveJob(recording, job);
    await controller.reload(recover: true);
    await controller.poll();
    expect(peer.submissions, 1);
    await controller.continueSubmission(recording);
    expect(peer.submissions, 2);
  });
  test('GET 429 按 Retry-After 退避，既有任务与 ID 不丢失', () async {
    await start();
    peer.getReply = const AssemblyReply(429, '{}', {'retry-after': '120'});
    await expectLater(
        controller.refresh(recording), throwsA(isA<AssemblyFailure>()));
    final job = (await controller.store.load(recording)).latest!;
    expect(
        job.retryAt,
        greaterThan(DateTime.now()
            .add(const Duration(seconds: 100))
            .millisecondsSinceEpoch));
    expect(job.state, 'queued');
    expect(job.remoteId, syntheticRemoteId);
    await expectLater(
        controller.refresh(recording), throwsA(isA<AppFailure>()));
    expect(peer.gets, 1);
    expect(peer.submissions, 1);
  });
  test('POST 429 的限流时限持久保存，重新点击也不会立刻再次上传或收费提交', () async {
    peer.submitReply = const AssemblyReply(429, '{}', {'retry-after': '120'});
    await expectLater(start(), throwsA(isA<AssemblyFailure>()));
    expect((await controller.store.load(recording)).latest!.state, 'error');
    await expectLater(
        start(),
        throwsA(
            isA<AppFailure>().having((e) => e.code, 'code', 'AAI_BACKOFF')));
    expect(peer.uploads, 1);
    expect(peer.submissions, 1);
  });
  test('上传中切换账号会中止请求，新账号不会继续使用旧 Key 或任务', () async {
    peer.uploadGate = Completer<void>();
    final operation = start();
    final assertion = expectLater(operation, throwsA(isA<AppFailure>()));
    while (peer.uploads == 0) {
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    library.activeAccountId = 'account-B';
    await controller.activate('account-B');
    await assertion;
    expect(settings.config, isNull);
    expect(peer.submissions, 0);
    library.activeAccountId = null;
    await controller.activate(null);
    expect(
        (await controller.store.load(recording)).latest!.state, 'interrupted');
    expect(peer.uploads, 1);
    expect(peer.submissions, 0);
  });
  test('更换 Key 不会把旧上传地址或任务交给另一个项目', () async {
    await start();
    await settings.save(const AssemblyConfig(
        apiKey: 'another-synthetic-key-of-another-project', region: 'eu'));
    await expectLater(
        controller.refresh(recording),
        throwsA(isA<AppFailure>()
            .having((e) => e.code, 'code', 'AAI_KEY_CHANGED')));
    expect(peer.gets, 0);
    await controller.poll();
    expect(peer.gets, 0);
  });
  test('删除或跨账号访问阻止查询和转写版本读取', () async {
    await finish();
    await library.setDeleted(recording.id, true);
    await expectLater(
        controller.store.readRevision(recording), throwsA(isA<AppFailure>()));
    await controller.reload();
    expect(controller.snapshots, isEmpty);
    await library.setDeleted(recording.id, false);
    final source = library.originalFile(recording);
    library.activeAccountId = 'A';
    final private = await library.saveDevice(
        owner: 'A',
        serial: '888test',
        session: 1700000000,
        original: source,
        playable: source);
    library.activeAccountId = 'B';
    await expectLater(
        controller.store.load(private), throwsA(isA<AppFailure>()));
  });
  test('校对保存新版本、清除旧词时间，历史不变且旧基线并发保存被拒绝', () async {
    await finish();
    final original = (await controller.store.readRevision(recording))!;
    final edited = await controller.store.edit(recording, original.id,
        segmentId: 'seg_0', text: '人工校对后的文字', reviewed: true);
    expect(edited.id, isNot(original.id));
    expect(edited.segments.first['words'], isEmpty);
    expect(edited.segments.first['timingSource'], 'user_pending');
    expect(edited.reviewedIds, contains('seg_0'));
    expect(
        (await controller.store.readRevision(recording, original.id))!
            .segments
            .first['text'],
        '第一位讲话人的测试内容。');
    await expectLater(
        controller.store
            .edit(recording, original.id, segmentId: 'seg_1', text: 'stale'),
        throwsA(isA<AppFailure>()
            .having((e) => e.code, 'code', 'REVISION_CONFLICT')));
    final named = await controller.store.edit(recording, edited.id,
        renameSpeakerId: 'SPEAKER_00', speakerName: '张同学');
    expect(named.speakerName('SPEAKER_00'), '张同学');
    final restored = await controller.store
        .edit(recording, named.id, restoreId: original.id);
    expect(restored.id, isNot(original.id));
    expect(restored.segments.first['text'], original.segments.first['text']);
    expect((await controller.store.load(recording)).revisions, hasLength(4));
  });
  test('长全文与各导出格式不截断；缺失时间只保留全文，不伪造段落', () async {
    await start();
    final job = (await controller.store.load(recording)).latest!;
    final raw = assemblyResult()
      ..['utterances'] = null
      ..['words'] = null
      ..['text'] = '无时间的完整文字' * 2000;
    final untimed = assemblyTranscript(raw, job);
    expect(untimed.segments, isEmpty);
    expect(exportTranscript('标题', untimed, 'txt').content,
        contains(raw['text'] as String));
    expect(() => exportTranscript('标题', untimed, 'srt'),
        throwsA(isA<AppFailure>()));
    final timed = assemblyTranscript(assemblyResult(), job);
    for (final format in ['md', 'txt', 'json', 'srt', 'vtt']) {
      final content = exportTranscript('标题', timed, format).content;
      expect(content, contains('第一位讲话人'));
      expect(content, contains('第二位讲话人'));
    }
    expect(
        exportTranscript('标题', timed, 'srt').content, contains('00:00:01,000'));
    expect(exportTranscript('标题', timed, 'vtt').content, startsWith('WEBVTT'));
  });
  test('重新转写期间的新校对不被迟到的机器结果切换或覆盖', () async {
    await finish();
    final original = (await controller.store.readRevision(recording))!;
    await start();
    final edited = await controller.store
        .edit(recording, original.id, segmentId: 'seg_0', text: '转写期间人工校对');
    peer.getReply = AssemblyReply(200, jsonEncode(assemblyResult()));
    await controller.refresh(recording);
    final current = (await controller.store.readRevision(recording))!;
    expect(current.id, edited.id);
    expect(current.segments.first['text'], '转写期间人工校对');
    final snapshot = await controller.store.load(recording);
    expect(snapshot.latest!.state, 'completed');
    expect(snapshot.revisions, hasLength(3));
    expect(snapshot.latest!.notice, contains('历史版本'));
  });
  test('HTTP 传输实际发送二进制与 Key，拒绝跟随跳转', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final done = Completer<void>();
    server.listen((request) async {
      expect(request.headers.value('authorization'), syntheticAssemblyKey);
      expect(
          await request.fold<List<int>>([], (a, b) => a..addAll(b)), [1, 2, 3]);
      request.response.statusCode = 307;
      request.response.headers.set('location', 'https://untrusted.test');
      request.response.write('{}');
      await request.response.close();
      done.complete();
    });
    final response = await HttpAssemblyTransport().send(
        Uri.parse('http://127.0.0.1:${server.port}/upload'),
        method: 'POST',
        apiKey: syntheticAssemblyKey,
        body: Stream.value([1, 2, 3]),
        contentLength: 3,
        contentType: 'application/octet-stream',
        cancellation: RequestCancellation());
    expect(response.status, 307);
    await done.future;
  });
}
