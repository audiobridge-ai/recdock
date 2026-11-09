import 'dart:async';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import '../../core/audio/device_audio.dart';
import '../../core/failure.dart';
import '../library/recording_store.dart';
import 'assembly_client.dart';
import 'background/native_queue.dart';
import 'models.dart';
import 'settings.dart';
import 'transcript_adapter.dart';
import 'transcription_store.dart';

class TranscriptionController extends ChangeNotifier {
  TranscriptionController(
      {required this.library,
      required this.settings,
      AssemblyClient? client,
      TranscriptionStore? store,
      this.nativeQueue,
      Duration pollInterval = const Duration(seconds: 5)})
      : client = client ?? AssemblyClient(),
        store = store ?? TranscriptionStore(library) {
    settings.addListener(_settingsChanged);
    _timer = Timer.periodic(pollInterval, (_) => unawaited(poll()));
  }
  final RecordingStore library;
  final AssemblySettings settings;
  final AssemblyClient client;
  final TranscriptionStore store;
  final BackgroundTranscriptionQueue? nativeQueue;
  Future<void> _nativeScope = Future.value();
  bool _syncingNative = false;
  String get _namespace => settings.config == null || settings.loading
      ? ''
      : digestText(
          '$_scope:${settings.scope}:${settings.config!.fingerprint}:${settings.config!.region}');
  void _activateNative() {
    final queue = nativeQueue;
    if (queue == null) return;
    final namespace = _namespace;
    _nativeScope = _nativeScope
        .catchError((Object _) {})
        .then((_) => queue.activate(namespace));
    unawaited(_nativeScope.catchError((Object _) {}));
  }

  int get activeTaskCount =>
      snapshots.values.where((s) => s.latest?.preventsNew == true).length;
  final snapshots = <String, TranscriptionSnapshot>{};
  final errors = <String, String>{};
  final progress = <String, double>{};
  final busy = <String>{};
  final _requests = <String, RequestCancellation>{};
  Timer? _timer;
  int _epoch = 0;
  bool _disposed = false, _foreground = true;
  String _scope = '';
  String? _settingsIdentity;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _settingsChanged() {
    final identity =
        '${settings.scope}:${settings.config?.fingerprint}:${settings.config?.region}';
    if (identity != _settingsIdentity) {
      _settingsIdentity = identity;
      _activateNative();
      for (final request in _requests.values) {
        request.cancel();
      }
    }
    _notify();
  }

  void _check(int epoch, [RequestCancellation? token]) {
    if (_disposed ||
        epoch != _epoch ||
        _scope != ownerScope(library.activeAccountId)) {
      throw const AppFailure('SCOPE_DENIED', '账号已改变，转写操作已暂停');
    }
    token?.check();
  }

  bool _same(AssemblyConfig config, TranscriptionJob job) =>
      job.keyFingerprint == config.fingerprint &&
      job.region == config.region &&
      job.credentialScope == settings.scope;
  AssemblyConfig _config([TranscriptionJob? job]) {
    final config = settings.config;
    if (config == null || settings.loading) {
      throw const AppFailure('AAI_KEY_REQUIRED', '请先在设置中配置 AssemblyAI API Key');
    }
    config.validate();
    if (job != null && !_same(config, job)) {
      throw const AppFailure(
          'AAI_KEY_CHANGED', '请恢复此任务原账号范围、区域与 Key 后继续查询；不会使用其他账号的 Key');
    }
    return config;
  }

  Future<void> activate(String? account) async {
    ++_epoch;
    for (final request in _requests.values) {
      request.cancel();
    }
    snapshots.clear();
    errors.clear();
    progress.clear();
    _scope = ownerScope(account);
    final epoch = _epoch;
    _notify();
    _activateNative();
    await settings.activate(account);
    _activateNative();
    await _nativeScope;
    _check(epoch);
    await reload(recover: true);
    _check(epoch);
    await poll();
  }

  Future<void> reload({bool recover = false}) async {
    final epoch = _epoch;
    final rows =
        (await library.load()).recordings.where((r) => !r.deleted).toList();
    _check(epoch);
    final ids = rows.map((r) => r.id).toSet();
    for (final id in _requests.keys.toList()) {
      if (!ids.contains(id)) _requests[id]!.cancel();
    }
    snapshots.removeWhere((id, _) => !ids.contains(id));
    for (final r in rows) {
      try {
        final snapshot = await store.load(r);
        _check(epoch);
        if (recover && !busy.contains(r.id)) {
          for (final job in snapshot.jobs) {
            if (!job.nativeManaged && job.state == 'uploading') {
              job.state = 'interrupted';
              job.notice = '上传已中断，重新开始需要再次确认';
              await store.saveJob(r, job);
            }
            if (!job.nativeManaged && job.state == 'submitting') {
              job.state = job.remoteId == null ? 'uncertain' : 'queued';
              job.notice =
                  job.remoteId == null ? '提交可能已被云端接收，请关联已有任务 ID，避免重复计费' : null;
              await store.saveJob(r, job);
            }
          }
        }
        _check(epoch);
        snapshots[r.id] = snapshot;
      } on AppFailure catch (e) {
        _check(epoch);
        errors[r.id] = e.message;
      } catch (_) {
        _check(epoch);
        errors[r.id] = '转写数据暂时无法读取，文件已保留';
      }
    }
    _notify();
  }

  Future<void> _refresh(LocalRecording r, int epoch) async {
    final snapshot = await store.load(r);
    _check(epoch);
    snapshots[r.id] = snapshot;
    _notify();
  }

  Future<void> _run(LocalRecording r,
      Future<void> Function(int, RequestCancellation) action) async {
    if (busy.contains(r.id)) return;
    if (!_foreground) {
      throw const AppFailure('AAI_FOREGROUND_REQUIRED', '请回到前台后继续');
    }
    final epoch = _epoch, token = RequestCancellation();
    _check(epoch);
    busy.add(r.id);
    _requests[r.id] = token;
    errors.remove(r.id);
    _notify();
    try {
      await action(epoch, token);
    } on AppFailure catch (e) {
      if (epoch == _epoch && !_disposed) {
        errors[r.id] = e.message;
      }
      rethrow;
    } catch (_) {
      if (epoch == _epoch && !_disposed) errors[r.id] = '转写操作未完成，任务信息与原文件已保留';
      throw const AppFailure('AAI_LOCAL_ERROR', '转写操作未完成，任务信息与原文件已保留');
    } finally {
      if (identical(_requests[r.id], token)) {
        _requests.remove(r.id);
        busy.remove(r.id);
        progress.remove(r.id);
      }
      _notify();
    }
  }

  Future<void> start(LocalRecording recording, {required int durationMs}) =>
      _run(recording, (epoch, token) async {
        final config = _config();
        final r = await library.current(recording.id);
        _check(epoch, token);
        if (r.deleted || !r.playable || durationMs <= 0) {
          throw const AppFailure('AAI_AUDIO_INVALID', '请先确认完整音频可以播放');
        }
        final existing = await store.load(r);
        _check(epoch, token);
        if (existing.latest?.preventsNew == true) {
          snapshots[r.id] = existing;
          return;
        }
        if ((existing.latest?.retryAt ?? 0) >
            DateTime.now().millisecondsSinceEpoch) {
          throw const AppFailure('AAI_BACKOFF', '服务正在限流，请等待后再发起新任务');
        }
        final audio = library.audioFile(r);
        if (audio.path.toLowerCase().endsWith('.ogg') ||
            audio.path.toLowerCase().endsWith('.opus')) {
          await validateOggFile(audio);
        }
        final hash = (await sha256.bind(audio.openRead()).first).toString();
        _check(epoch, token);
        final job = TranscriptionJob(
            id: newId('job'),
            recordingId: r.id,
            sourceSha256: r.sourceSha256,
            audioSha256: hash,
            scope: ownerScope(r.accountId),
            credentialScope: settings.scope,
            baseRevisionId: existing.current,
            region: config.region,
            keyFingerprint: config.fingerprint,
            language: config.language,
            models: config.speechModels,
            durationMs: durationMs,
            nativeManaged: nativeQueue != null,
            state: nativeQueue != null ? 'waiting_upload' : 'uploading',
            createdAt: DateTime.now().millisecondsSinceEpoch);
        await store.saveJob(r, job);
        await _refresh(r, epoch);
        if (nativeQueue != null) {
          await _nativeScope;
          _check(epoch, token);
          await nativeQueue!.enqueue(job, config, audio, _namespace);
          unawaited(
              nativeQueue!.notifications().catchError((Object _) => false));
          return;
        }
        try {
          var lastUpdate = 0;
          job.uploadUrl =
              await client.upload(config, audio, token, (sent, total) {
            final now = DateTime.now().millisecondsSinceEpoch;
            if (epoch == _epoch &&
                !_disposed &&
                (sent == total || now - lastUpdate >= 100)) {
              progress[r.id] = sent / total;
              lastUpdate = now;
              _notify();
            }
          });
          _check(epoch, token);
          job.state = 'uploaded';
          await store.saveJob(r, job);
          await _refresh(r, epoch);
          await _submit(r, job, config, epoch, token);
        } on AppFailure catch (e) {
          if (epoch == _epoch && !_disposed) {
            if (job.state == 'uploading') {
              job.state = 'interrupted';
              job.notice = e.message;
              await store.saveJob(r, job);
            }
            await _refresh(r, epoch);
          }
          rethrow;
        }
      });
  Future<void> _submit(LocalRecording r, TranscriptionJob job,
      AssemblyConfig config, int epoch, RequestCancellation token) async {
    _check(epoch, token);
    job.state = 'submitting';
    job.notice = null;
    // Durable marker BEFORE the non-idempotent request. A crash is never auto-replayed.
    await store.saveJob(r, job);
    await _refresh(r, epoch);
    try {
      final response = await client.submit(config, job, token);
      _check(epoch, token);
      job.remoteId = response['id'] as String;
      job.state = 'queued';
      await store.saveJob(r, job);
      await _refresh(r, epoch);
      await _result(r, job, response, epoch);
    } on AppFailure catch (e) {
      if (epoch == _epoch && !_disposed && job.remoteId == null) {
        job.state = e.code == 'AAI_SUBMIT_UNKNOWN' || e.code == 'AAI_CANCELLED'
            ? 'uncertain'
            : 'error';
        job.notice = e.message;
        if (e is AssemblyFailure && e.retryAfter != null) {
          job.retryAt =
              DateTime.now().add(e.retryAfter!).millisecondsSinceEpoch;
        }
        await store.saveJob(r, job);
        await _refresh(r, epoch);
      }
      rethrow;
    }
  }

  Future<void> continueSubmission(LocalRecording r) =>
      _run(r, (epoch, token) async {
        final snapshot = await store.load(r), job = snapshot.latest;
        _check(epoch, token);
        if (job == null || job.state != 'uploaded') {
          throw const AppFailure('AAI_NOT_READY', '任务尚不能继续提交');
        }
        if (job.nativeManaged && nativeQueue != null) return;
        await _submit(r, job, _config(job), epoch, token);
      });
  Future<void> _result(
      LocalRecording r, TranscriptionJob job, Json response, int epoch) async {
    _check(epoch);
    if (response['id'] != job.remoteId ||
        (response['audio_url'] != null &&
            response['audio_url'] != job.uploadUrl)) {
      throw const AppFailure('AAI_RESULT_MISMATCH', '远端任务与此录音上传地址不匹配');
    }
    if (response['status'] == 'completed') {
      await store.complete(r, job, assemblyTranscript(response, job));
    } else {
      job.state = response['status'] as String;
      job.notice = job.state == 'error'
          ? 'AssemblyAI 未能完成此录音。请在控制台检查任务详情后决定是否重新转写'
          : null;
      job.failures = 0;
      job.retryAt = 0;
      await store.saveJob(r, job);
    }
    await _refresh(r, epoch);
  }

  Future<void> refresh(LocalRecording r) => _run(r, (epoch, token) async {
        final snapshot = await store.load(r), job = snapshot.latest;
        _check(epoch, token);
        if (job == null || !job.polling || job.remoteId == null) return;
        final config = _config(job);
        if (DateTime.now().millisecondsSinceEpoch < job.retryAt) {
          throw const AppFailure('AAI_BACKOFF', '正在等待限流或网络退避，请稍后继续');
        }
        try {
          final result = await client.fetch(config, job.remoteId!, token);
          _check(epoch, token);
          await _result(r, job, result, epoch);
        } on AppFailure catch (e) {
          if (epoch == _epoch && !_disposed) {
            job.notice = e.message;
            job.failures++;
            final seconds =
                (5 * (1 << job.failures.clamp(0, 6))).clamp(10, 300);
            job.retryAt = DateTime.now()
                .add(e is AssemblyFailure && e.retryAfter != null
                    ? e.retryAfter!
                    : Duration(seconds: seconds))
                .millisecondsSinceEpoch;
            await store.saveJob(r, job);
            await _refresh(r, epoch);
          }
          rethrow;
        }
      });
  Future<void> attach(LocalRecording r, String remoteId) =>
      _run(r, (epoch, token) async {
        final snapshot = await store.load(r), job = snapshot.latest;
        _check(epoch, token);
        if (job == null || job.state != 'uncertain') {
          throw const AppFailure('AAI_NOT_UNCERTAIN', '当前任务无需关联');
        }
        final result = await client.fetch(_config(job), remoteId.trim(), token);
        _check(epoch, token);
        if (result['audio_url'] != job.uploadUrl) {
          throw const AppFailure('AAI_RESULT_MISMATCH', '该任务不是此录音的上传文件，未关联');
        }
        if (job.nativeManaged && nativeQueue != null) {
          await nativeQueue!.acknowledge(job.id);
        }
        job.nativeManaged = false;
        job.remoteId = remoteId.trim();
        job.state = 'queued';
        job.notice = null;
        await store.saveJob(r, job);
        await _result(r, job, result, epoch);
      });
  Future<void> abandon(LocalRecording r) => _run(r, (epoch, token) async {
        final snapshot = await store.load(r), job = snapshot.latest;
        _check(epoch, token);
        if (job == null || !['uncertain', 'uploaded'].contains(job.state)) {
          throw const AppFailure('AAI_STATE_INVALID', '此任务不能结束跟踪');
        }
        if (job.nativeManaged && nativeQueue != null) {
          await nativeQueue!.acknowledge(job.id);
        }
        job.state = 'abandoned';
        job.notice = '仅结束本机跟踪，云端任务未删除或取消';
        await store.saveJob(r, job);
        await _refresh(r, epoch);
      });
  Future<void> poll() async {
    if (_disposed ||
        !_foreground ||
        settings.loading ||
        settings.config == null) {
      return;
    }
    final epoch = _epoch;
    if (nativeQueue != null) {
      try {
        await _syncNative(epoch);
        errors.remove('background');
      } catch (_) {
        if (epoch == _epoch && !_disposed) {
          errors['background'] = '后台任务暂时无法同步，日志和原文件已保留，请稍后刷新';
          _notify();
        }
      }
    }
    for (final entry in snapshots.entries.toList()) {
      if (epoch != _epoch || _disposed || !_foreground) return;
      final config = settings.config;
      if (config == null) return;
      final job = entry.value.latest;
      if (job == null ||
          !job.polling ||
          (job.nativeManaged && nativeQueue != null) ||
          !_same(config, job) ||
          busy.contains(entry.key) ||
          DateTime.now().millisecondsSinceEpoch < job.retryAt) {
        continue;
      }
      try {
        final r = await library.current(entry.key);
        if (!r.deleted) await refresh(r);
      } catch (_) {/* Safe GET retry is scheduled by persisted backoff. */}
    }
  }

  Future<void> cancelPending(LocalRecording r) async {
    final job = snapshots[r.id]?.latest;
    if (job == null ||
        !['waiting_upload', 'uploading', 'uploaded'].contains(job.state)) {
      return;
    }
    if (job.nativeManaged && nativeQueue != null) {
      await _nativeScope;
      await nativeQueue!.cancel(job.id);
      await _syncNative(_epoch);
    } else {
      _requests[r.id]?.cancel();
    }
  }

  void pause(String recordingId) {
    if (nativeQueue == null) {
      _requests[recordingId]?.cancel();
      return;
    }
    unawaited(library
        .current(recordingId)
        .then(cancelPending)
        .catchError((Object _) {}));
  }

  Future<void> _syncNative(int epoch) async {
    if (_syncingNative || nativeQueue == null) return;
    _syncingNative = true;
    try {
      await _nativeScope;
      _check(epoch);
      final entries = await nativeQueue!.snapshot();
      _check(epoch);
      final ids = entries.map((j) => j['id']).toSet();
      for (final snapshot in snapshots.values.toList()) {
        final job = snapshot.latest;
        if (job == null ||
            !job.nativeManaged ||
            job.state != 'waiting_upload' ||
            ids.contains(job.id) ||
            !_same(_config(), job)) {
          continue;
        }
        final r = await library.current(job.recordingId);
        _check(epoch);
        if (!r.deleted) {
          await nativeQueue!
              .enqueue(job, _config(job), library.audioFile(r), _namespace);
        }
      }
      for (final entry in entries) {
        _check(epoch);
        final recordingId = entry['recordingId'] as String;
        try {
          final existing = snapshots[recordingId]
              ?.jobs
              .where((j) => j.id == entry['id'])
              .firstOrNull;
          if (existing == null) {
            if (['waiting_upload', 'uploading', 'uploaded']
                .contains(entry['state'])) {
              await nativeQueue!.cancel(entry['id'] as String);
            }
            continue;
          }
          if (!_same(_config(), existing) ||
              entry['namespace'] != _namespace ||
              entry['sourceSha256'] != existing.sourceSha256 ||
              entry['audioSha256'] != existing.audioSha256) {
            continue;
          }
          final r = await library.current(recordingId);
          _check(epoch);
          if (r.deleted) continue;
          if (existing.state == 'completed') {
            await nativeQueue!.acknowledge(existing.id);
            continue;
          }
          final next = TranscriptionJob.fromJson(entry);
          if (next.state == 'syncing') {
            final result = mapOf(entry['result']);
            if (result['id'] != next.remoteId ||
                result['audio_url'] != next.uploadUrl ||
                result['status'] != 'completed') {
              throw const AppFailure('AAI_RESULT_MISMATCH', '后台结果与原录音不匹配');
            }
            await store.complete(r, next, assemblyTranscript(result, next));
            await _refresh(r, epoch);
            _check(epoch);
            await nativeQueue!.acknowledge(next.id);
          } else {
            await store.saveJob(r, next);
          }
          _check(epoch);
          if (entry['progress'] is num && next.state == 'uploading') {
            progress[r.id] = (entry['progress'] as num).toDouble().clamp(0, 1);
          } else {
            progress.remove(r.id);
          }
          await _refresh(r, epoch);
          errors.remove(recordingId);
        } catch (e) {
          _check(epoch);
          errors[recordingId] =
              e is AppFailure ? e.message : '任务暂时无法同步，原文件和后台日志已保留';
          _notify();
        }
      }
    } finally {
      _syncingNative = false;
    }
  }

  void setForeground(bool value) {
    _foreground = value;
    if (nativeQueue != null) {
      unawaited(nativeQueue!.foreground(value).catchError((Object _) {}));
    }
    if (!value && nativeQueue == null) {
      for (final request in _requests.values) {
        request.cancel();
      }
    } else {
      unawaited(poll());
    }
  }

  @override
  void dispose() {
    _disposed = true;
    ++_epoch;
    _timer?.cancel();
    settings.removeListener(_settingsChanged);
    for (final request in _requests.values) {
      request.cancel();
    }
    super.dispose();
  }
}
