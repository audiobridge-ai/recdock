import 'dart:convert';
import 'dart:io';
import 'package:path/path.dart' as p;
import '../../core/failure.dart';
import '../library/recording_store.dart';
import 'models.dart';

class TranscriptionStore {
  TranscriptionStore(this.library);
  final RecordingStore library;
  Future<void> _tail = Future.value();
  Future<T> _serial<T>(Future<T> Function() action) {
    final operation = _tail.then((_) => action());
    _tail = operation.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return operation;
  }

  Future<LocalRecording> _check(LocalRecording recording) async {
    final current = await library.current(recording.id);
    if (current.deleted ||
        current.sourceSha256 != recording.sourceSha256 ||
        current.accountId != recording.accountId) {
      throw const AppFailure('TRANSCRIPT_SCOPE_CHANGED', '录音已移入回收站或账号已改变');
    }
    return current;
  }

  Directory _dir(LocalRecording r) =>
      Directory(p.join(library.originalFile(r).parent.path, 'transcription'));
  Future<Json> _head(LocalRecording r) async {
    await _check(r);
    final file = File(p.join(_dir(r).path, 'index.json'));
    if (!await file.exists()) {
      return {
        'schemaVersion': 1,
        'recordingId': r.id,
        'sourceSha256': r.sourceSha256,
        'jobs': <Json>[],
        'revisions': <String>[],
        'current': null
      };
    }
    final json = mapOf(jsonDecode(await file.readAsString()));
    if (json['schemaVersion'] != 1 ||
        json['recordingId'] != r.id ||
        json['sourceSha256'] != r.sourceSha256 ||
        json['jobs'] is! List ||
        json['revisions'] is! List) {
      throw const AppFailure('AAI_INDEX_INVALID', '转写索引无法读取，文件已保留');
    }
    return json;
  }

  Future<void> _atomic(LocalRecording r, String name, Json json) async {
    await _check(r);
    final dir = _dir(r);
    await dir.create(recursive: true);
    final temporary = File(p.join(dir.path, '.$name.${newId('tmp')}'));
    try {
      await temporary.writeAsString(jsonEncode(json), flush: true);
      await _check(r);
      await temporary.rename(p.join(dir.path, name));
    } finally {
      if (await temporary.exists()) await temporary.delete();
    }
  }

  Future<TranscriptionSnapshot> load(LocalRecording r) => _serial(() async {
        final json = await _head(r);
        final jobs = (json['jobs'] as List)
            .map((j) => TranscriptionJob.fromJson(mapOf(j)))
            .toList();
        if (jobs.any((j) =>
            j.recordingId != r.id ||
            j.sourceSha256 != r.sourceSha256 ||
            j.scope != ownerScope(r.accountId))) {
          throw const AppFailure('AAI_INDEX_INVALID', '转写任务来源不匹配');
        }
        return TranscriptionSnapshot(
            jobs: jobs,
            revisions: List<String>.from(json['revisions'] as List),
            current: json['current'] as String?);
      });
  Future<void> saveJob(LocalRecording r, TranscriptionJob job) =>
      _serial(() async {
        if (job.recordingId != r.id ||
            job.sourceSha256 != r.sourceSha256 ||
            job.scope != ownerScope(r.accountId)) {
          throw const AppFailure('SCOPE_DENIED', '转写任务来源不匹配');
        }
        final json = await _head(r),
            jobs = (json['jobs'] as List).map(mapOf).toList();
        final index = jobs.indexWhere((j) => j['id'] == job.id);
        if (index < 0) {
          jobs.add(job.toJson());
        } else {
          jobs[index] = job.toJson();
        }
        json['jobs'] = jobs;
        await _atomic(r, 'index.json', json);
      });
  Future<TranscriptRevision> _revision(LocalRecording r, String id) async {
    await _check(r);
    if (!RegExp(r'^rev_[a-f0-9]+$').hasMatch(id)) {
      throw const AppFailure('TRANSCRIPT_ID_INVALID', '转写版本编号无效');
    }
    final revision = TranscriptRevision.fromJson(mapOf(jsonDecode(
        await File(p.join(_dir(r).path, '$id.json')).readAsString())));
    await _check(r);
    if (revision.id != id ||
        revision.transcript['recordingId'] != r.id ||
        revision.transcript['sourceSha256'] != r.sourceSha256) {
      throw const AppFailure('SCOPE_DENIED', '转写版本来源不匹配');
    }
    return revision;
  }

  Future<TranscriptRevision?> readRevision(LocalRecording r, [String? id]) =>
      _serial(() async {
        final head = await _head(r),
            selected = id ?? head['current'] as String?;
        if (selected == null) return null;
        if (!(head['revisions'] as List).contains(selected)) {
          throw const AppFailure('TRANSCRIPT_ID_INVALID', '未找到此转写版本');
        }
        return _revision(r, selected);
      });
  Future<void> complete(LocalRecording r, TranscriptionJob job,
          TranscriptRevision revision) =>
      _serial(() async {
        final head = await _head(r),
            jobs = (head['jobs'] as List).map(mapOf).toList();
        final i = jobs.indexWhere((j) => j['id'] == job.id);
        if (i < 0) throw const AppFailure('AAI_JOB_MISSING', '未找到本机转写任务');
        if (jobs[i]['state'] == 'completed') return;
        if (revision.transcript['recordingId'] != r.id ||
            revision.transcript['sourceSha256'] != r.sourceSha256) {
          throw const AppFailure('SCOPE_DENIED', '转写结果来源不匹配');
        }
        await _atomic(r, '${revision.id}.json', revision.toJson());
        job.state = 'completed';
        final keepCurrent =
            head['current'] != null && head['current'] != job.baseRevisionId;
        job.notice = keepCurrent ? '新转写已保存到历史版本，当前保留了转写期间的校对版本' : null;
        jobs[i] = job.toJson();
        head['jobs'] = jobs;
        (head['revisions'] as List).add(revision.id);
        if (!keepCurrent) head['current'] = revision.id;
        await _atomic(r, 'index.json', head);
      });
  Future<TranscriptRevision> edit(LocalRecording r, String base,
          {String? segmentId,
          String? text,
          String? speakerId,
          bool setSpeaker = false,
          bool? reviewed,
          String? renameSpeakerId,
          String? speakerName,
          String? untimedText,
          String? restoreId}) =>
      _serial(() async {
        final head = await _head(r);
        if (head['current'] != base) {
          throw const AppFailure('REVISION_CONFLICT', '已有更新版本，请重新打开后再保存');
        }
        final previous = await _revision(r, restoreId ?? base);
        final t = cloneJson(previous.transcript);
        t['revisionId'] = newId('rev');
        final checked = Set<String>.from(previous.reviewedIds);
        if (segmentId != null) {
          final rows = (t['segments'] as List).cast<Json>();
          final match = rows.where((s) => s['id'] == segmentId);
          if (match.length != 1) {
            throw const AppFailure('SEGMENT_MISSING', '未找到此段落');
          }
          final row = match.single;
          if (text != null && text != row['text']) {
            if (text.trim().isEmpty || text.length > 100000) {
              throw const AppFailure('TEXT_INVALID', '段落文字需要 1–100000 个字符');
            }
            row['text'] = text;
            row['words'] = <Json>[];
            row['timingSource'] = 'user_pending';
            row['flags'] = {
              ...(row['flags'] as List),
              'user_edited',
              'pending_alignment'
            }.toList();
            checked.remove(segmentId);
          }
          if (setSpeaker) {
            if (speakerId != null &&
                !(t['speakers'] as List).any((s) => s['id'] == speakerId)) {
              throw const AppFailure('SPEAKER_INVALID', '讲话人无效');
            }
            row['speakerId'] = speakerId;
            row['flags'] = {
              ...(row['flags'] as List).where((f) => f != 'speaker_uncertain'),
              'user_edited',
              if (speakerId == null) 'speaker_uncertain'
            }.toList();
            checked.remove(segmentId);
          }
          if (reviewed != null) {
            if (reviewed) {
              checked.add(segmentId);
            } else {
              checked.remove(segmentId);
            }
          }
        }
        if (renameSpeakerId != null) {
          final name = speakerName?.trim() ?? '';
          if (name.isEmpty || name.length > 100) {
            throw const AppFailure('SPEAKER_INVALID', '人物名称需要 1–100 个字符');
          }
          final speaker = (t['speakers'] as List)
              .where((s) => s['id'] == renameSpeakerId)
              .single;
          speaker['displayName'] = name;
          speaker['nameSource'] = 'user';
          for (final segment in (t['segments'] as List)) {
            if (segment['speakerId'] == renameSpeakerId) {
              checked.remove(segment['id']);
            }
          }
        }
        if (untimedText != null &&
            (untimedText.trim().isEmpty || untimedText.length > 2000000)) {
          throw const AppFailure('TEXT_INVALID', '全文长度无效');
        }
        final revision = TranscriptRevision(
            transcript: t,
            createdAt: DateTime.now().millisecondsSinceEpoch,
            parentId: base,
            kind: restoreId == null ? 'edit' : 'restore',
            reviewedIds: checked,
            untimedText: untimedText ?? previous.untimedText,
            providerText: previous.providerText);
        await _atomic(r, '${revision.id}.json', revision.toJson());
        (head['revisions'] as List).add(revision.id);
        head['current'] = revision.id;
        await _atomic(r, 'index.json', head);
        return revision;
      });
}
