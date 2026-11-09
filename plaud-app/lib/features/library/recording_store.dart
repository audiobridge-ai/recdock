import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import '../../core/failure.dart';

class LocalRecording {
  const LocalRecording(
      {required this.id,
      required this.title,
      required this.filename,
      required this.sourceSha256,
      required this.bytes,
      required this.createdAt,
      this.deleted = false,
      this.accountId,
      this.deviceSerial,
      this.sessionId,
      this.playableFilename,
      this.notice});
  final String id;
  final String title;
  final String filename;
  final String sourceSha256;
  final int bytes;
  final DateTime createdAt;
  final bool deleted;
  final String? accountId, deviceSerial, playableFilename, notice;
  final int? sessionId;
  bool get deviceRecording => deviceSerial != null;
  bool get playable => !deviceRecording || playableFilename != null;

  LocalRecording copy({String? title, bool? deleted}) => LocalRecording(
      id: id,
      title: title ?? this.title,
      filename: filename,
      sourceSha256: sourceSha256,
      bytes: bytes,
      createdAt: createdAt,
      deleted: deleted ?? this.deleted,
      accountId: accountId,
      deviceSerial: deviceSerial,
      sessionId: sessionId,
      playableFilename: playableFilename,
      notice: notice);

  Map<String, dynamic> toJson() => {
        'schemaVersion': 2,
        'id': id,
        'title': title,
        'filename': filename,
        'sourceSha256': sourceSha256,
        'bytes': bytes,
        'createdAt': createdAt.toUtc().toIso8601String(),
        'deleted': deleted,
        'accountId': accountId,
        'deviceSerial': deviceSerial,
        'sessionId': sessionId,
        'playableFilename': playableFilename,
        'notice': notice,
      };

  factory LocalRecording.fromJson(Map<String, dynamic> json) {
    final id = json['id'] as String, filename = json['filename'] as String;
    if (![1, 2].contains(json['schemaVersion']) ||
        !RegExp(r'^rec_[0-9a-f]+$').hasMatch(id) ||
        filename != p.basename(filename) ||
        filename == '.' ||
        filename == '..' ||
        !RegExp(r'^[0-9a-f]{64}$').hasMatch(json['sourceSha256'] as String) ||
        (json['bytes'] as int) <= 0) {
      throw const FormatException('录音索引无效');
    }
    final playable = json['playableFilename'] as String?;
    if ((playable != null &&
            (playable != p.basename(playable) ||
                playable == '.' ||
                playable == '..')) ||
        (json['deviceSerial'] != null &&
            (json['accountId'] is! String ||
                (json['accountId'] as String).isEmpty ||
                json['sessionId'] is! int))) {
      throw const FormatException('录音资产或账号范围无效');
    }
    return LocalRecording(
        id: id,
        title: json['title'] as String,
        filename: filename,
        sourceSha256: json['sourceSha256'] as String,
        bytes: json['bytes'] as int,
        createdAt: DateTime.parse(json['createdAt'] as String),
        deleted: json['deleted'] as bool,
        accountId: json['accountId'] as String?,
        deviceSerial: json['deviceSerial'] as String?,
        sessionId: json['sessionId'] as int?,
        playableFilename: playable,
        notice: json['notice'] as String?);
  }
}

class LibrarySnapshot {
  const LibrarySnapshot(this.recordings, this.unreadableCount);
  final List<LocalRecording> recordings;
  final int unreadableCount;
}

/// Files remain in the app sandbox. Importing never creates a transcription job.
/// Original bytes and metadata are published together by a directory rename.
class RecordingStore {
  RecordingStore(this.root, {this.maxBytes = 1024 * 1024 * 1024});
  final Directory root;
  final int maxBytes;
  String? activeAccountId;
  Future<void> _tail = Future.value();

  Future<T> _serial<T>(Future<T> Function() operation) {
    final result = _tail.then((_) => operation());
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return result;
  }

  Directory _directory(String id) {
    if (!RegExp(r'^rec_[0-9a-f]+$').hasMatch(id)) {
      throw const FormatException('录音编号无效');
    }
    return Directory(p.join(root.path, id));
  }

  bool _allowed(LocalRecording recording) =>
      recording.accountId == null || recording.accountId == activeAccountId;
  void _access(LocalRecording recording) {
    if (!_allowed(recording)) {
      throw const AppFailure('SCOPE_DENIED', '请登录此录音所属的账号');
    }
  }

  File originalFile(LocalRecording recording) {
    _access(recording);
    return File(p.join(_directory(recording.id).path, recording.filename));
  }

  File audioFile(LocalRecording recording) {
    _access(recording);
    if (!recording.playable) {
      throw const AppFailure('AUDIO_NOT_PLAYABLE', '原件已保存，音频暂未恢复为可播放格式');
    }
    return File(p.join(_directory(recording.id).path,
        recording.playableFilename ?? recording.filename));
  }

  Future<LibrarySnapshot> load() => _serial(_load);

  Future<LibrarySnapshot> _load() async {
    await root.create(recursive: true);
    final recordings = <LocalRecording>[];
    var unreadable = 0;
    await for (final entry in root.list(followLinks: false)) {
      if (entry is! Directory || !p.basename(entry.path).startsWith('rec_')) {
        continue;
      }
      try {
        final data = jsonDecode(
            await File(p.join(entry.path, 'recording.json')).readAsString());
        final recording = LocalRecording.fromJson(data as Map<String, dynamic>);
        if (!_allowed(recording)) continue;
        if (p.basename(entry.path) != recording.id ||
            await originalFile(recording).length() != recording.bytes) {
          throw const FormatException('原音频缺失或大小不符');
        }
        recordings.add(recording);
      } catch (_) {
        unreadable++;
      }
    }
    recordings.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return LibrarySnapshot(List.unmodifiable(recordings), unreadable);
  }

  Future<LocalRecording> importFile(File source, {String? title}) =>
      _serial(() async {
        final sourceSize = await source.length();
        if (sourceSize <= 0 || sourceSize > maxBytes) {
          throw const FormatException('请选择非空且不超过 1 GiB 的音频文件');
        }
        await root.create(recursive: true);
        final random = Random.secure();
        final id =
            'rec_${DateTime.now().microsecondsSinceEpoch.toRadixString(16)}'
            '${List.generate(8, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
        final pending = Directory(p.join(root.path, '.$id.pending'));
        await pending.create();
        try {
          final extension = p.extension(source.path).toLowerCase();
          if (![
            '.wav',
            '.mp3',
            '.m4a',
            '.aac',
            '.ogg',
            '.flac',
            '.opus',
            '.mp4'
          ].contains(extension)) {
            throw const FormatException(
                '请选择 WAV、MP3、M4A、AAC、Ogg、FLAC 或 Opus 音频');
          }
          final filename = 'source$extension';
          final copied = await source.copy(p.join(pending.path, filename));
          if (await copied.length() != sourceSize) {
            throw const FormatException('音频复制不完整，请重试');
          }
          final hash = (await sha256.bind(copied.openRead()).first).toString();
          final prior = (await _load()).recordings.where((r) =>
              r.accountId == null &&
              r.sourceSha256 == hash &&
              r.bytes == sourceSize);
          if (prior.isNotEmpty) {
            final existing = prior.first;
            return existing.deleted
                ? _save(existing.copy(deleted: false))
                : existing;
          }
          final recording = LocalRecording(
              id: id,
              title: _title(title ?? p.basenameWithoutExtension(source.path)),
              filename: filename,
              sourceSha256: hash,
              bytes: sourceSize,
              createdAt: DateTime.now().toUtc());
          await File(p.join(pending.path, 'recording.json'))
              .writeAsString(jsonEncode(recording.toJson()), flush: true);
          await pending.rename(_directory(id).path);
          return recording;
        } finally {
          if (await pending.exists()) await pending.delete(recursive: true);
        }
      });

  String _title(String title) {
    final value = title.trim();
    if (value.isEmpty || value.length > 200) {
      throw const FormatException('标题需要 1–200 个字符');
    }
    return value;
  }

  Future<LocalRecording> _current(String id) async {
    final recording = LocalRecording.fromJson(jsonDecode(
        await File(p.join(_directory(id).path, 'recording.json'))
            .readAsString()) as Map<String, dynamic>);
    _access(recording);
    return recording;
  }

  Future<LocalRecording> current(String id) => _serial(() => _current(id));

  Future<LocalRecording> rename(String id, String title) => _serial(
      () async => _save((await _current(id)).copy(title: _title(title))));

  Future<LocalRecording> setDeleted(String id, bool deleted) =>
      _serial(() async => _save((await _current(id)).copy(deleted: deleted)));

  Future<LocalRecording> _save(LocalRecording recording) async {
    _access(recording);
    final directory = _directory(recording.id);
    final temporary = File(p.join(directory.path, 'recording.json.tmp'));
    await temporary.writeAsString(jsonEncode(recording.toJson()), flush: true);
    _access(recording);
    await temporary.rename(p.join(directory.path, 'recording.json'));
    return recording;
  }

  File transferFile(String owner, String serial, int session, int size) {
    if (owner != activeAccountId) {
      throw const AppFailure('SCOPE_DENIED', '请先登录设备所属账号');
    }
    final identity =
        sha256.convert(utf8.encode('$owner:$serial:$session:$size')).toString();
    return File(p.join(root.path, '.transfers', '$identity.bin'));
  }

  Future<LocalRecording?> findDevice(
      String owner, String serial, int session, int bytes) async {
    if (owner != activeAccountId) {
      throw const AppFailure('SCOPE_DENIED', '设备账号已经改变');
    }
    final rows = (await load()).recordings.where((r) =>
        !r.deleted &&
        r.accountId == owner &&
        r.deviceSerial == serial &&
        r.sessionId == session &&
        r.bytes == bytes);
    return rows.isEmpty ? null : rows.first;
  }

  Future<LocalRecording> saveDevice(
          {required String owner,
          required String serial,
          required int session,
          required File original,
          File? playable,
          String? notice}) =>
      _serial(() async {
        void check() {
          if (activeAccountId != owner) {
            throw const AppFailure('SCOPE_DENIED', '设备账号已经改变，原件已保留');
          }
        }

        check();
        final size = await original.length();
        if (size <= 0 || size > 256 * 1024 * 1024) {
          throw const FormatException('设备文件大小无效');
        }
        final hash = (await sha256.bind(original.openRead()).first).toString();
        check();
        final previous = (await _load()).recordings.where((r) =>
            r.accountId == owner &&
            r.deviceSerial == serial &&
            r.sessionId == session &&
            r.sourceSha256 == hash);
        if (previous.isNotEmpty &&
            !previous.first.playable &&
            playable != null) {
          final prior = previous.first;
          final temporary = await playable
              .copy(p.join(_directory(prior.id).path, 'audio.ogg.pending'));
          check();
          await temporary
              .rename(p.join(_directory(prior.id).path, 'audio.ogg'));
          return _save(LocalRecording(
              id: prior.id,
              title: prior.title,
              filename: prior.filename,
              sourceSha256: prior.sourceSha256,
              bytes: prior.bytes,
              createdAt: prior.createdAt,
              accountId: owner,
              deviceSerial: serial,
              sessionId: session,
              playableFilename: 'audio.ogg',
              notice: notice));
        }
        if (previous.isNotEmpty &&
            (previous.first.playable || playable == null)) {
          final prior = previous.first;
          return prior.deleted ? _save(prior.copy(deleted: false)) : prior;
        }
        final id =
            'rec_${DateTime.now().microsecondsSinceEpoch.toRadixString(16)}${randomSuffix()}';
        final pending = Directory(p.join(root.path, '.$id.pending'));
        await pending.create(recursive: true);
        try {
          final copy = await original.copy(p.join(pending.path, 'source.bin'));
          if (await copy.length() != size ||
              (await sha256.bind(copy.openRead()).first).toString() != hash) {
            throw const FormatException('设备原件复制校验失败');
          }
          if (playable != null) {
            await playable.copy(p.join(pending.path, 'audio.ogg'));
          }
          check();
          final recording = LocalRecording(
              id: id,
              title: deviceTitle(session),
              filename: 'source.bin',
              sourceSha256: hash,
              bytes: size,
              createdAt: DateTime.now().toUtc(),
              accountId: owner,
              deviceSerial: serial,
              sessionId: session,
              playableFilename: playable == null ? null : 'audio.ogg',
              notice: notice);
          await File(p.join(pending.path, 'recording.json'))
              .writeAsString(jsonEncode(recording.toJson()), flush: true);
          check();
          await pending.rename(_directory(id).path);
          return recording;
        } finally {
          if (await pending.exists()) await pending.delete(recursive: true);
        }
      });
}

String randomSuffix() {
  final random = Random.secure();
  return List.generate(
      8, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}

String deviceTitle(int session) {
  if (session < 946684800 ||
      session >
          DateTime.now().add(const Duration(days: 2)).millisecondsSinceEpoch ~/
              1000) {
    return 'PLAUD 录音 $session';
  }
  final date = DateTime.fromMillisecondsSinceEpoch(session * 1000);
  String two(int value) => '$value'.padLeft(2, '0');
  return '${date.year}-${two(date.month)}-${two(date.day)} ${two(date.hour)}:${two(date.minute)}:${two(date.second)}';
}
