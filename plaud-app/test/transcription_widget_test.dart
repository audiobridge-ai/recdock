import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:plaud_app/features/library/recording_store.dart';
import 'package:plaud_app/features/transcription/assembly_client.dart';
import 'package:plaud_app/features/transcription/export_service.dart';
import 'package:plaud_app/features/transcription/models.dart';
import 'package:plaud_app/features/transcription/settings.dart';
import 'package:plaud_app/features/transcription/transcript_export.dart';
import 'package:plaud_app/features/transcription/transcription_controller.dart';
import 'package:plaud_app/features/transcription/transcription_panel.dart';
import 'package:plaud_app/features/transcription/transcription_store.dart';
import 'fixtures/peer_material.dart';
import 'helpers/assembly_peer.dart';
import 'helpers/peer.dart';

class CapturingExport extends TranscriptExportService {
  TranscriptExport? output;
  @override
  Future<bool> save(TranscriptExport value) async {
    output = value;
    return true;
  }
}

class FrozenLibrary extends RecordingStore {
  FrozenLibrary(super.root, this.recording);
  final LocalRecording recording;
  @override
  Future<LocalRecording> current(String id) async => recording;
  @override
  Future<LibrarySnapshot> load() async => LibrarySnapshot([recording], 0);
}

class FrozenTranscriptStore extends TranscriptionStore {
  FrozenTranscriptStore(super.library, this.snapshot, this.revision);
  final TranscriptionSnapshot snapshot;
  final TranscriptRevision revision;
  @override
  Future<TranscriptionSnapshot> load(LocalRecording r) async => snapshot;
  @override
  Future<TranscriptRevision?> readRevision(LocalRecording r,
          [String? id]) async =>
      revision;
}

void main() {
  testWidgets('长转写按需构建；搜索只显示匹配段落但导出仍包含首尾全文', (tester) async {
    late Directory root;
    late RecordingStore library;
    late LocalRecording recording;
    late AssemblySettings settings;
    late TranscriptionController controller;
    final exporter = CapturingExport();
    await tester.runAsync(() async {
      root =
          await Directory.systemTemp.createTemp('recdock-transcript-widget-');
      library = RecordingStore(Directory(p.join(root.path, 'library')));
      final audio = await File(p.join(root.path, 'audio.ogg'))
          .writeAsBytes(base64Decode(peerFixture['ogg'] as String));
      recording = await library.importFile(audio);
      settings = AssemblySettings(secrets: MemorySecrets());
      final peer = SyntheticAssembly();
      controller = TranscriptionController(
          library: library,
          settings: settings,
          client: AssemblyClient(transport: peer),
          pollInterval: const Duration(days: 1));
      await controller.activate(null);
      await settings.save(const AssemblyConfig(apiKey: syntheticAssemblyKey));
      await controller.start(recording, durationMs: 1000000);
      peer.getReply = AssemblyReply(
          200,
          jsonEncode(assemblyResult()
            ..['utterances'] = [
              for (var i = 0; i < 1000; i++)
                {
                  'start': i * 1000,
                  'end': i * 1000 + 500,
                  'text': '来源段落-$i',
                  'speaker': 'A'
                }
            ]
            ..['text'] =
                [for (var i = 0; i < 1000; i++) '来源段落-$i'].join('\n')));
      await controller.refresh(recording);
      final snapshot = await controller.store.load(recording),
          revision = (await controller.store.readRevision(recording))!;
      controller.dispose();
      final frozenLibrary = FrozenLibrary(library.root, recording);
      controller = TranscriptionController(
          library: frozenLibrary,
          settings: settings,
          store: FrozenTranscriptStore(frozenLibrary, snapshot, revision),
          pollInterval: const Duration(days: 1));
      await controller.activate(null);
    });
    try {
      await tester.pumpWidget(MaterialApp(
          home: Scaffold(
              body: TranscriptionPanel(
                  recording: recording,
                  controller: controller,
                  durationMs: 1000000,
                  canPlay: true,
                  onSeek: (_) async {},
                  exportService: exporter))));
      await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pumpAndSettle();
      expect(find.byTooltip('校对此段').evaluate().length, lessThan(20));
      expect(find.text('来源段落-999'), findsNothing);
      final search = find.widgetWithText(TextField, '搜索转写内容');
      await tester.ensureVisible(search);
      await tester.pumpAndSettle();
      await tester.enterText(search, '来源段落-999');
      await tester.pumpAndSettle();
      expect(find.text('来源段落-0'), findsNothing);
      final export = find.text('导出全文');
      await tester.ensureVisible(export);
      await tester.pumpAndSettle();
      await tester.tap(export);
      await tester.pumpAndSettle();
      await tester.tap(find.text('导出 MD 全文'));
      await tester.pumpAndSettle();
      await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pumpAndSettle();
      expect(exporter.output!.content, contains('来源段落-0'));
      expect(exporter.output!.content, contains('来源段落-999'));
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      settings.dispose();
      await tester.runAsync(() => root.delete(recursive: true));
    }
  });
}
