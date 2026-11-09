import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:plaud_app/features/library/recording_store.dart';
import 'package:plaud_app/features/transcription/background/native_queue.dart';
import 'package:plaud_app/features/transcription/models.dart';
import 'package:plaud_app/features/transcription/settings.dart';
import 'package:plaud_app/features/transcription/transcription_controller.dart';
import '../test/helpers/peer.dart';
import '../test/helpers/assembly_peer.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('原生持久队列：串行上传、双云端、后台提交、取消与返回同步', (tester) async {
    await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: Text('第三阶段原生队列验收'))));
    final root = Directory(
        '${(await getApplicationSupportDirectory()).path}/phase3-native-${DateTime.now().microsecondsSinceEpoch}');
    await root.create(recursive: true);
    final library = RecordingStore(Directory('${root.path}/library'));
    final settings = AssemblySettings(secrets: MemorySecrets());
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final queue =
        NativeTranscriptionQueue(testBase: 'http://localhost:${server.port}');
    var uploads = 0,
        submissions = 0,
        reads = 0,
        simultaneousUploads = 0,
        maxUploads = 0;
    var complete = false, unknown = false;
    final remoteAudio = <String, String>{};
    final fixtures = <Uint8List>[];
    Uint8List wav(int i) {
      final bytes = Uint8List(32044), d = ByteData(32044);
      bytes.setRange(0, 4, ascii.encode('RIFF'));
      bytes.setRange(8, 16, ascii.encode('WAVEfmt '));
      d.setUint32(4, 32036, Endian.little);
      d.setUint32(16, 16, Endian.little);
      d.setUint16(20, 1, Endian.little);
      d.setUint16(22, 1, Endian.little);
      d.setUint32(24, 8000, Endian.little);
      d.setUint32(28, 16000, Endian.little);
      d.setUint16(32, 2, Endian.little);
      d.setUint16(34, 16, Endian.little);
      bytes.setRange(36, 40, ascii.encode('data'));
      d.setUint32(40, 32000, Endian.little);
      for (var n = 4; n < 36; n++) {
        if (d.getUint8(n) != 0) bytes[n] = d.getUint8(n);
      }
      bytes.setRange(40, 44, d.buffer.asUint8List(40, 4));
      bytes[44] = i + 1;
      return bytes;
    }

    final requests = <Future<void>>[];
    server.listen((request) {
      requests.add(() async {
        expectSync(
            request.headers.value('authorization'), syntheticAssemblyKey);
        request.response.headers.contentType = ContentType.json;
        if (request.uri.path == '/v2/upload') {
          simultaneousUploads++;
          if (simultaneousUploads > maxUploads) {
            maxUploads = simultaneousUploads;
          }
          final bytes =
              await request.fold<List<int>>([], (a, b) => a..addAll(b));
          expectSync(fixtures.any((f) => listEquals(f, bytes)), true);
          await Future<void>.delayed(const Duration(milliseconds: 250));
          uploads++;
          simultaneousUploads--;
          request.response.write(jsonEncode({
            'upload_url': 'https://cdn.assemblyai.com/upload/phase3-$uploads'
          }));
        } else if (request.method == 'POST') {
          final body =
              mapOf(jsonDecode(await utf8.decoder.bind(request).join()));
          expectSync(body['speaker_labels'], true);
          expectSync(
              body['speech_models'], ['universal-3-5-pro', 'universal-2']);
          submissions++;
          final id = 'phase3-$submissions';
          remoteAudio[id] = body['audio_url'] as String;
          if (unknown) {
            request.response.statusCode = 500;
            request.response.write('{}');
          } else {
            request.response.write(jsonEncode({
              'id': id,
              'status': 'queued',
              'audio_url': body['audio_url']
            }));
          }
        } else {
          reads++;
          final id = request.uri.pathSegments.last;
          request.response.write(jsonEncode({
            'id': id,
            'audio_url': remoteAudio[id],
            'status': complete ? 'completed' : 'processing',
            'text': '原生后台队列测试',
            'utterances': [
              {
                'start': 0,
                'end': 1000,
                'speaker': 'A',
                'text': '原生后台队列测试',
                'words': []
              }
            ]
          }));
        }
        await request.response.close();
      }());
    });
    final controller = TranscriptionController(
        library: library,
        settings: settings,
        nativeQueue: queue,
        pollInterval: const Duration(hours: 1));
    Future<void> until(bool Function() condition, {int seconds = 75}) async {
      final deadline = DateTime.now().add(Duration(seconds: seconds));
      while (!condition()) {
        if (DateTime.now().isAfter(deadline)) {
          fail(
              'Native queue timeout: uploads=$uploads submissions=$submissions reads=$reads');
        }
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    final rows = <LocalRecording>[];
    final testNamespace =
        digestText('personal:personal:${digestText(syntheticAssemblyKey)}:us');
    Future<void> cleanNative() async {
      await queue.activate(testNamespace);
      for (final e in await queue.snapshot()) {
        if (e['keyFingerprint'] != digestText(syntheticAssemblyKey) ||
            e['testBase'] == null) {
          continue;
        }
        try {
          await queue.cancel(e['id'] as String);
        } catch (_) {}
        try {
          await queue.acknowledge(e['id'] as String);
        } catch (_) {}
      }
    }

    try {
      await cleanNative();
      await controller.activate(null);
      await settings.save(const AssemblyConfig(apiKey: syntheticAssemblyKey));
      for (var i = 0; i < 5; i++) {
        final audio = wav(i);
        fixtures.add(audio);
        final f = File('${root.path}/audio-$i.wav');
        await f.writeAsBytes(audio);
        final r = await library.importFile(f, title: '队列测试 $i');
        rows.add(r);
      }
      for (final r in rows.take(4)) {
        await controller.start(r, durationMs: 2000);
      }
      // Execution does not await notification authorization.
      await until(() => submissions == 2);
      await controller.poll();
      expect(maxUploads, 1);
      expect(uploads, 2);
      expect(controller.snapshots[rows[2].id]!.latest!.state, 'waiting_upload');
      await controller.cancelPending(rows[3]);
      expect(controller.snapshots[rows[3].id]!.latest!.state, 'cancelled');
      controller.setForeground(false);
      complete = true;
      if (Platform.isAndroid) {
        await until(() => submissions == 3);
        await until(() => reads >= 3);
      } else {
        // iOS permits transfer completion but does not promise a refresh while suspended.
        expect(submissions, 2);
      }
      controller.setForeground(true);
      var synced = false;
      final deadline = DateTime.now().add(const Duration(seconds: 100));
      while (!synced && DateTime.now().isBefore(deadline)) {
        await controller.poll();
        synced = rows.take(3).every(
            (r) => controller.snapshots[r.id]?.latest?.state == 'completed');
        await tester.pump(const Duration(milliseconds: 300));
      }
      expect(synced, true);
      expect(submissions, 3);
      expect(uploads, 3);
      expect(maxUploads, 1);
      final before = (await controller.store.load(rows.first)).revisions.length;
      await controller.poll();
      expect(
          (await controller.store.load(rows.first)).revisions.length, before);
      unknown = true;
      await controller.start(rows[4], durationMs: 2000);
      await until(() => submissions == 4);
      var uncertain = false;
      while (!uncertain && DateTime.now().isBefore(deadline)) {
        await controller.poll();
        uncertain =
            controller.snapshots[rows[4].id]?.latest?.state == 'uncertain';
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(uncertain, true);
      await controller.poll();
      expect(submissions, 4);
      final raw = await queue.snapshot();
      expect(jsonEncode(raw), isNot(contains(syntheticAssemblyKey)));
      final namespaceCount = raw.length;
      expect(namespaceCount, greaterThan(0));
      await queue.activate('');
      expect(await queue.snapshot(), isEmpty);
      expect(tester.takeException(), isNull);
    } finally {
      // Only synthetic-key jobs with a debug loopback endpoint are touched.
      await cleanNative();
      await queue.activate('');
      controller.dispose();
      settings.dispose();
      await server.close(force: true);
      await Future.wait(requests);
      if (await root.exists()) await root.delete(recursive: true);
    }
  });
}
