import 'dart:convert';
import 'dart:math';
import 'package:crypto/crypto.dart';
import '../../core/failure.dart';

typedef Json = Map<String, dynamic>;
Json mapOf(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};
Json cloneJson(Json value) => mapOf(jsonDecode(jsonEncode(value)));
String newId(String prefix) =>
    '${prefix}_${DateTime.now().microsecondsSinceEpoch.toRadixString(16)}${List.generate(8, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
String digestText(String text) => sha256.convert(utf8.encode(text)).toString();
String ownerScope(String? account) =>
    account == null ? 'personal' : 'account:$account';
bool validRemoteId(String value) =>
    RegExp(r'^[a-zA-Z0-9_-]{1,160}$').hasMatch(value);

class AssemblyConfig {
  const AssemblyConfig(
      {required this.apiKey,
      this.region = 'us',
      this.language = 'auto',
      this.model = 'recommended'});
  final String apiKey, region, language, model;
  String get baseUrl => region == 'eu'
      ? 'https://api.eu.assemblyai.com'
      : 'https://api.assemblyai.com';
  String get fingerprint => digestText(apiKey);
  List<String> get speechModels => model == 'universal-2'
      ? ['universal-2']
      : ['universal-3-5-pro', 'universal-2'];
  void validate() {
    if (!RegExp(r'^[A-Za-z0-9_-]{16,256}$').hasMatch(apiKey) ||
        !['us', 'eu'].contains(region) ||
        !['auto', 'zh', 'en', 'ja', 'ko', 'es', 'fr', 'de']
            .contains(language) ||
        !['recommended', 'universal-2'].contains(model)) {
      throw const AppFailure(
          'AAI_CONFIG_INVALID', '请填写有效的 AssemblyAI API Key 并选择区域和语言');
    }
  }

  Json toJson() => {
        'apiKey': apiKey,
        'region': region,
        'language': language,
        'model': model
      };
  factory AssemblyConfig.fromJson(Json json) {
    final value = AssemblyConfig(
        apiKey: json['apiKey'] as String,
        region: json['region'] as String,
        language: json['language'] as String,
        model: json['model'] as String);
    value.validate();
    return value;
  }
}

class TranscriptionJob {
  TranscriptionJob(
      {required this.id,
      required this.recordingId,
      required this.sourceSha256,
      required this.audioSha256,
      required this.scope,
      required this.region,
      required this.keyFingerprint,
      required this.language,
      required this.models,
      required this.durationMs,
      required this.createdAt,
      String? credentialScope,
      this.baseRevisionId,
      this.nativeManaged = false,
      this.state = 'uploading',
      this.uploadUrl,
      this.remoteId,
      this.notice,
      this.retryAt = 0,
      this.failures = 0})
      : credentialScope = credentialScope ?? scope;
  final String id,
      recordingId,
      sourceSha256,
      audioSha256,
      scope,
      region,
      keyFingerprint,
      language;
  final String credentialScope;
  final String? baseRevisionId;
  bool nativeManaged;
  final List<String> models;
  final int durationMs, createdAt;
  String state;
  String? uploadUrl, remoteId, notice;
  int retryAt, failures;
  bool get polling => ['queued', 'processing'].contains(state);
  bool get preventsNew => [
        'waiting_upload',
        'syncing',
        'uploading',
        'uploaded',
        'submitting',
        'uncertain',
        'queued',
        'processing'
      ].contains(state);
  Json toJson() => {
        'id': id,
        'recordingId': recordingId,
        'sourceSha256': sourceSha256,
        'audioSha256': audioSha256,
        'scope': scope,
        'credentialScope': credentialScope,
        'baseRevisionId': baseRevisionId,
        'nativeManaged': nativeManaged,
        'region': region,
        'keyFingerprint': keyFingerprint,
        'language': language,
        'models': models,
        'durationMs': durationMs,
        'createdAt': createdAt,
        'state': state,
        'uploadUrl': uploadUrl,
        'remoteId': remoteId,
        'notice': notice,
        'retryAt': retryAt,
        'failures': failures
      };
  factory TranscriptionJob.fromJson(Json json) {
    final job = TranscriptionJob(
        id: json['id'] as String,
        recordingId: json['recordingId'] as String,
        sourceSha256: json['sourceSha256'] as String,
        audioSha256: json['audioSha256'] as String,
        scope: json['scope'] as String,
        credentialScope: json['credentialScope'] as String?,
        baseRevisionId: json['baseRevisionId'] as String?,
        nativeManaged: json['nativeManaged'] as bool? ?? false,
        region: json['region'] as String,
        keyFingerprint: json['keyFingerprint'] as String,
        language: json['language'] as String,
        models: List<String>.from(json['models'] as List),
        durationMs: json['durationMs'] as int,
        createdAt: json['createdAt'] as int,
        state: json['state'] as String,
        uploadUrl: json['uploadUrl'] as String?,
        remoteId: json['remoteId'] as String?,
        notice: json['notice'] as String?,
        retryAt: (json['retryAt'] as num?)?.toInt() ?? 0,
        failures: json['failures'] as int? ?? 0);
    if (!RegExp(r'^job_[a-f0-9]+$').hasMatch(job.id) ||
        !['us', 'eu'].contains(job.region) ||
        job.durationMs <= 0 ||
        ![
          'waiting_upload',
          'syncing',
          'cancelled',
          'uploading',
          'uploaded',
          'submitting',
          'uncertain',
          'queued',
          'processing',
          'completed',
          'error',
          'interrupted',
          'abandoned'
        ].contains(job.state) ||
        ![job.sourceSha256, job.audioSha256, job.keyFingerprint]
            .every((s) => RegExp(r'^[a-f0-9]{64}$').hasMatch(s)) ||
        (job.remoteId != null && !validRemoteId(job.remoteId!))) {
      throw const AppFailure('AAI_INDEX_INVALID', '转写任务索引无法读取，文件已保留');
    }
    return job;
  }
}

class TranscriptRevision {
  TranscriptRevision(
      {required this.transcript,
      required this.createdAt,
      this.parentId,
      this.kind = 'machine',
      Set<String>? reviewedIds,
      this.untimedText = '',
      this.providerText = ''})
      : reviewedIds = reviewedIds ?? <String>{};
  final Json transcript;
  final int createdAt;
  final String? parentId;
  final String kind, untimedText, providerText;
  final Set<String> reviewedIds;
  String get id => transcript['revisionId'] as String;
  List<Json> get segments =>
      (transcript['segments'] as List).map(mapOf).toList();
  List<Json> get speakers =>
      (transcript['speakers'] as List).map(mapOf).toList();
  String speakerName(Object? id) =>
      speakers
          .where((s) => s['id'] == id)
          .map((s) => s['displayName'] as String)
          .firstOrNull ??
      '讲话人待确认';
  Json toJson() => {
        'schemaVersion': 1,
        'transcript': transcript,
        'createdAt': createdAt,
        'parentId': parentId,
        'kind': kind,
        'reviewedIds': reviewedIds.toList(),
        'untimedText': untimedText,
        'providerText': providerText
      };
  factory TranscriptRevision.fromJson(Json json) {
    final t = mapOf(json['transcript']);
    if (json['schemaVersion'] != 1 ||
        t['schemaVersion'] != 1 ||
        t['segments'] is! List ||
        t['speakers'] is! List ||
        !RegExp(r'^rev_[a-f0-9]+$')
            .hasMatch(t['revisionId'] as String? ?? '')) {
      throw const AppFailure('TRANSCRIPT_INVALID', '转写版本无法读取，文件已保留');
    }
    return TranscriptRevision(
        transcript: t,
        createdAt: json['createdAt'] as int,
        parentId: json['parentId'] as String?,
        kind: json['kind'] as String,
        reviewedIds: Set<String>.from(json['reviewedIds'] as List),
        untimedText: json['untimedText'] as String? ?? '',
        providerText: json['providerText'] as String? ?? '');
  }
}

class TranscriptionSnapshot {
  TranscriptionSnapshot(
      {List<TranscriptionJob>? jobs, List<String>? revisions, this.current})
      : jobs = jobs ?? [],
        revisions = revisions ?? [];
  final List<TranscriptionJob> jobs;
  final List<String> revisions;
  final String? current;
  TranscriptionJob? get latest => jobs.lastOrNull;
}

String jobLabel(String state) =>
    const {
      'waiting_upload': '等待上传',
      'syncing': '转写完成，正在保存结果',
      'cancelled': '已取消本机任务',
      'uploading': '正在上传',
      'uploaded': '等待提交',
      'submitting': '正在提交',
      'uncertain': '提交结果待确认',
      'queued': '云端排队中',
      'processing': '云端转写中',
      'completed': '转写已完成',
      'error': '转写未完成',
      'interrupted': '上传已中断',
      'abandoned': '已结束本机跟踪'
    }[state] ??
    state;
