import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:plaud_app/app.dart';
import 'package:plaud_app/features/auth/auth_controller.dart';
import 'package:plaud_app/features/auth/cloud_client.dart';
import 'package:plaud_app/features/auth/secret_store.dart';
import 'package:plaud_app/features/library/recording_store.dart';
import 'package:plaud_app/features/transcription/assembly_client.dart';
import 'package:plaud_app/features/transcription/settings.dart';
import 'package:plaud_app/features/transcription/transcription_store.dart';
import 'package:plaud_app/features/transcription/transcript_export.dart';
import 'package:plaud_app/features/transcription/export_service.dart';
import '../test/fixtures/peer_material.dart';
import '../test/helpers/peer.dart';
import '../test/helpers/assembly_peer.dart';

class Phase2Secrets implements SecretStore {
  final platform = PlatformSecretStore();
  final used = <String>{};
  @override
  Future<String?> read(String key) => platform.read('phase2_$key');
  @override
  Future<void> write(String key, String value) async {
    used.add(key);
    await platform.write('phase2_$key', value);
  }

  @override
  Future<void> delete(String key) => platform.delete('phase2_$key');
  Future<void> clear() async {
    for (final key in used) {
      await delete(key);
    }
  }
}

Future<void> eventually(WidgetTester tester, bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 45));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw StateError('Native phase2 condition timed out');
    }
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pump();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('第二阶段原生验收：Key设置、主动转写、重建恢复、回听、校对、全文与原生分享', (tester) async {
    final root = Directory(p.join(
        (await getApplicationSupportDirectory()).path, 'phase2-native-smoke'));
    if (await root.exists()) await root.delete(recursive: true);
    final secrets = Phase2Secrets();
    await secrets.delete('session_v1');
    final settings = AssemblySettings(secrets: secrets);
    await settings.activate(null);
    await settings.save(null);
    settings.dispose();
    final library = RecordingStore(Directory(p.join(root.path, 'library')));
    final source =
        await File(p.join(root.path, 'fixture.ogg')).create(recursive: true);
    await source.writeAsBytes(base64Decode(peerFixture['ogg'] as String));
    final recording = await library.importFile(source, title: '第二阶段合成录音');
    final peer = SyntheticAssembly()..autoComplete = false;
    AuthController auth() => AuthController(
        client: PlaudCloudClient(transport: FixtureCloud()), secrets: secrets);
    Widget app() => RecDockApp(
        store: library,
        auth: auth(),
        assemblyClient: AssemblyClient(transport: peer));
    try {
      await tester.pumpWidget(app());
      await eventually(
          tester, () => find.text('第二阶段合成录音').evaluate().isNotEmpty);
      await tester.tap(find.text('设置'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('AssemblyAI 转写设置'));
      await tester.pumpAndSettle();
      await tester.enterText(
          find.widgetWithText(TextField, 'API Key'), syntheticAssemblyKey);
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      await tester.tap(find.text('美国 US'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('欧盟 EU').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('自动识别'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('中文').last);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('保存设置'));
      await tester.tap(find.text('保存设置'));
      await tester.pumpAndSettle();
      final nativeSettings = AssemblySettings(secrets: secrets);
      await nativeSettings.activate(null);
      expect(nativeSettings.config!.apiKey, syntheticAssemblyKey);
      expect(nativeSettings.config!.region, 'eu');
      nativeSettings.dispose();
      await tester.tap(find.text('录音'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('第二阶段合成录音'));
      await tester.pumpAndSettle();
      await eventually(
          tester, () => find.byIcon(Icons.play_arrow).evaluate().isNotEmpty);
      await tester.tap(find.text('转写此录音'));
      await tester.pumpAndSettle();
      expect(peer.uploads, 0);
      await tester.tap(find.widgetWithText(FilledButton, '上传并开始转写'));
      await eventually(tester, () => peer.submissions == 1);
      await tester.pumpAndSettle();
      final jobs = TranscriptionStore(library);
      expect((await jobs.load(recording)).latest!.remoteId, syntheticRemoteId);
      // Destroy and rebuild the real App, retaining disk and native secure storage.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      peer.autoComplete = true;
      await tester.pumpWidget(app());
      await eventually(
          tester, () => find.text('第二阶段合成录音').evaluate().isNotEmpty);
      await tester.tap(find.text('第二阶段合成录音'));
      await tester.pumpAndSettle();
      await eventually(tester, () => find.text('转写已完成').evaluate().isNotEmpty);
      expect(peer.uploads, 1);
      expect(peer.submissions, 1);
      final machine = (await jobs.readRevision(recording))!;
      expect(machine.segments, hasLength(2));
      final scroll = find
          .descendant(
              of: find.byKey(const Key('transcription-scroll')),
              matching: find.byType(Scrollable))
          .first;
      await tester.scrollUntilVisible(find.text('00:00:01'), 180,
          scrollable: scroll);
      await tester.pumpAndSettle();
      await tester.tap(find.text('00:00:01'));
      await tester.scrollUntilVisible(find.byType(Slider), -180,
          scrollable: scroll);
      await tester.pumpAndSettle();
      await eventually(tester,
          () => tester.widget<Slider>(find.byType(Slider)).value >= 1000);
      await tester.scrollUntilVisible(find.byTooltip('校对此段').first, 180,
          scrollable: scroll);
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('校对此段').first);
      await tester.pumpAndSettle();
      await tester.enterText(
          find.widgetWithText(TextField, '文字'), '已校对的第一段内容。');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      await tester.tap(find.text('已听原音并核对此段'));
      await tester.tap(find.text('保存新版本'));
      await tester.pumpAndSettle();
      final edited = (await jobs.readRevision(recording))!;
      expect(edited.id, isNot(machine.id));
      expect(edited.reviewedIds, contains('seg_0'));
      expect(edited.segments.first['words'], isEmpty);
      // Export saved full revision independent of the current screen filter.
      await tester.scrollUntilVisible(
          find.widgetWithText(TextField, '搜索转写内容'), -180,
          scrollable: scroll);
      await tester.pumpAndSettle();
      await tester.enterText(
          find.widgetWithText(TextField, '搜索转写内容'), '只匹配不到的搜索');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      final output = exportTranscript(
          recording.title, (await jobs.readRevision(recording))!, 'md');
      expect(output.content, contains('已校对的第一段内容。'));
      expect(output.content, contains('第二位讲话人的完整内容。'));
      expect(
          (await jobs.readRevision(recording, machine.id))!
              .segments
              .first['text'],
          '第一位讲话人的测试内容。');
      expect(tester.takeException(), isNull);
      // Open the real OS chooser; do not select a recipient or transmit the fixture.
      await TranscriptExportService().share(output);
      await tester.pump(const Duration(milliseconds: 300));
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await secrets.clear();
      if (await root.exists()) await root.delete(recursive: true);
    }
  });
}
