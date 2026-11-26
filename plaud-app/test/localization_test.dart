import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:plaud_app/app.dart';
import 'package:plaud_app/features/auth/auth_controller.dart';
import 'package:plaud_app/features/library/recording_store.dart';
import 'package:plaud_app/features/transcription/models.dart';
import 'package:plaud_app/features/transcription/transcript_export.dart';
import 'package:plaud_app/l10n/language_controller.dart';
import 'package:plaud_app/l10n/message_catalog.dart';
import 'package:plaud_app/l10n/messages_en.dart';
import 'package:plaud_app/features/auth/login_page.dart';
import 'helpers/peer.dart';

class MemoryLanguagePreferences implements LanguagePreferences {
  String? value;
  bool fail = false;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String language) async {
    if (fail) throw StateError('Storage unavailable');
    value = language;
  }
}

class LanguageTestLibrary extends RecordingStore {
  LanguageTestLibrary() : super(Directory.systemTemp);
  static final recording = LocalRecording(
      id: 'rec_1234',
      title: '会议 {1} — 中文 original',
      filename: 'audio.wav',
      sourceSha256: '0' * 64,
      bytes: 12,
      createdAt: DateTime.utc(2026));
  @override
  Future<LibrarySnapshot> load() async => LibrarySnapshot([recording], 0);
}

void main() {
  test('English fallback, persisted selection, and failed writes', () async {
    final preferences = MemoryLanguagePreferences();
    final controller = LanguageController(preferences: preferences);
    await controller.restore();
    expect(controller.language, 'en');
    await controller.select('zh-CN');
    final restarted = LanguageController(preferences: preferences);
    await restarted.restore();
    expect(restarted.locale, const Locale('zh', 'CN'));
    preferences.fail = true;
    await expectLater(controller.select('en'), throwsStateError);
    expect(controller.language, 'zh-CN');
    preferences.value = 'fr';
    await restarted.restore();
    expect(restarted.language, 'en');
    controller.dispose();
    restarted.dispose();
  });

  test(
      'English translations preserve every placeholder and contain no Chinese copy',
      () {
    Set<String> parameters(String text) =>
        RegExp(r'\{\d+\}').allMatches(text).map((m) => m[0]!).toSet();
    for (final entry in englishMessages.entries) {
      expect(parameters(entry.value), parameters(entry.key), reason: entry.key);
      expect(RegExp(r'[\u3400-\u9fff]').hasMatch(entry.value), isFalse,
          reason: entry.key);
    }
  });

  test('Owned UI message keys are covered by the English catalog', () {
    final pattern = RegExp(r"(?:context|labels)\.tr\(\s*'((?:[^'\\]|\\.)*)'");
    for (final file in Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart') && !f.path.contains('/l10n/'))) {
      for (final match in pattern.allMatches(file.readAsStringSync())) {
        final key = match[1]!
            .replaceAll(r'\n', '\n')
            .replaceAll(r"\'", "'")
            .replaceAll(r'\$', r'$');
        if (RegExp(r'[\u3400-\u9fff]').hasMatch(key)) {
          expect(englishMessages.containsKey(key), isTrue,
              reason: '${file.path}: $key');
        }
      }
    }
  });

  test(
      'Legacy notices and default speaker labels translate without altering custom names',
      () {
    const english = MessageCatalog(), chinese = MessageCatalog('zh-CN');
    expect(english.message('设备已连接'), 'Device connected');
    expect(english.message('正在从已接收位置恢复（1/2）'),
        'Resuming from the received position (1/2)');
    expect(chinese.message('设备已连接'), '设备已连接');
    expect(english.speaker({'displayName': '说话人 1', 'nameSource': 'default'}),
        'Speaker 1');
    expect(english.speaker({'displayName': '说话人 1', 'nameSource': 'user'}),
        '说话人 1');
    expect(english.tr('版本 {0}{1}', ['中文 {1}', ' · Current']),
        'Version 中文 {1} · Current');
  });

  test(
      'Exports localize metadata while preserving full content, custom names, and JSON',
      () {
    final transcript = <String, dynamic>{
      'revisionId': 'rev_abcd',
      'recordingId': 'rec_1234',
      'sourceSha256': '0' * 64,
      'durationMs': 1000,
      'language': 'zh',
      'speakers': [
        {'id': 'A', 'displayName': '说话人 1', 'nameSource': 'user'}
      ],
      'segments': [
        {
          'id': 'seg_a',
          'startMs': 0,
          'endMs': 1000,
          'speakerId': 'A',
          'text': '原文 {1} — original transcript'
        }
      ]
    };
    final revision = TranscriptRevision(
        transcript: transcript,
        createdAt: 0,
        kind: 'machine',
        reviewedIds: {},
        untimedText: '',
        providerText: '原文');
    final before = jsonEncode(revision.toJson());
    final en = exportTranscript('会议 {1}', revision, 'txt').content;
    final zh = exportTranscript('会议 {1}', revision, 'txt',
            labels: const MessageCatalog('zh-CN'))
        .content;
    expect(en, contains('Recording ID: rec_1234'));
    expect(zh, contains('录音 ID：rec_1234'));
    for (final text in [
      en,
      zh,
      exportTranscript('会议', revision, 'srt').content
    ]) {
      expect(text, contains('原文 {1} — original transcript'));
      expect(text, contains('说话人 1'));
    }
    expect(
        exportTranscript('会议', revision, 'json').content,
        exportTranscript('会议', revision, 'json',
                labels: const MessageCatalog('zh-CN'))
            .content);
    expect(jsonEncode(revision.toJson()), before);
  });

  for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
    testWidgets(
        '$platform defaults to English on a Chinese system and preserves content while switching',
        (tester) async {
      debugDefaultTargetPlatformOverride = platform;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      tester.platformDispatcher.localeTestValue = const Locale('zh', 'CN');
      addTearDown(tester.platformDispatcher.clearLocaleTestValue);
      final preferences = MemoryLanguagePreferences();
      final language = LanguageController(preferences: preferences);
      final auth = AuthController(secrets: MemorySecrets());
      await auth.restore();
      await tester.pumpWidget(RecDockApp(
          store: LanguageTestLibrary(), auth: auth, language: language));
      await tester.pumpAndSettle();
      expect(find.text(LanguageTestLibrary.recording.title), findsOneWidget);
      expect(find.text('Import audio'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '中文');
      await tester.tap(find.text('Settings').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('interface-language')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('中文').last);
      await tester.pumpAndSettle();
      expect(find.text('界面语言'), findsOneWidget);
      expect(preferences.value, 'zh-CN');
      await tester.tap(find.text('录音').last);
      await tester.pumpAndSettle();
      expect(find.text(LanguageTestLibrary.recording.title), findsOneWidget);
      expect(tester.widget<TextField>(find.byType(TextField)).controller!.text,
          '中文');
      await tester.tap(find.text('设备').last);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('登录 PLAUD'));
      await tester.tap(find.text('登录 PLAUD'));
      await tester.pumpAndSettle();
      expect(find.byType(LoginPage), findsOneWidget);
      final email = find.byKey(const Key('login-email'));
      await tester.scrollUntilVisible(email, 150,
          scrollable: find.byType(Scrollable).last);
      await tester.enterText(email, 'person@example.test');
      await language.select('en');
      await tester.pumpAndSettle();
      expect(find.text('Sign in to PLAUD'), findsOneWidget);
      expect(find.text('person@example.test'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Sign in'), 150,
          scrollable: find.byType(Scrollable).last);
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();
      expect(find.text('Enter your email and password.'), findsOneWidget);
      expect(
          MaterialLocalizations.of(tester.element(find.byType(Scaffold).last))
              .backButtonTooltip,
          'Back');
      await tester.pumpWidget(const SizedBox.shrink());
      language.dispose();
      expect(tester.takeException(), isNull);
    });
  }
}
