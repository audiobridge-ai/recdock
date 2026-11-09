// Synthetic AssemblyAI wire peer. This file is never imported by lib/.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:plaud_app/core/failure.dart';
import 'package:plaud_app/features/transcription/assembly_client.dart';
import 'package:plaud_app/features/transcription/models.dart';

const syntheticAssemblyKey = 'synthetic-assembly-key-not-a-real-key';
const syntheticUpload = 'https://cdn.assemblyai.com/upload/synthetic-audio';
const syntheticRemoteId = 'synthetic-assembly-job-1';

Json assemblyResult(
        {String status = 'completed',
        String uploadUrl = syntheticUpload,
        String id = syntheticRemoteId}) =>
    {
      'id': id,
      'status': status,
      'audio_url': uploadUrl,
      'language_code': 'zh',
      'speech_model_used': 'universal-2',
      if (status == 'completed') ...{
        'audio_duration': 2,
        'text': '第一位讲话人的测试内容。第二位讲话人的完整内容。',
        'utterances': [
          {
            'speaker': 'A',
            'start': 0,
            'end': 800,
            'text': '第一位讲话人的测试内容。',
            'confidence': 0.96,
            'words': [
              {'text': '第一位讲话人', 'start': 0, 'end': 300, 'confidence': 0.98},
              {'text': '的测试内容。', 'start': 350, 'end': 800, 'confidence': 0.95}
            ]
          },
          {
            'speaker': 'B',
            'start': 1000,
            'end': 1800,
            'text': '第二位讲话人的完整内容。',
            'confidence': 0.91,
            'words': [
              {'text': '第二位讲话人', 'start': 1000, 'end': 1300, 'confidence': 0.9},
              {'text': '的完整内容。', 'start': 1400, 'end': 1800, 'confidence': 0.92}
            ]
          }
        ]
      }
    };

class SyntheticAssembly implements AssemblyTransport {
  final requests = <({
    Uri uri,
    String method,
    String key,
    int length,
    String contentType,
    List<int> body
  })>[];
  int uploads = 0, submissions = 0, gets = 0;
  String? submitFailure;
  AssemblyReply? getReply;
  AssemblyReply? submitReply;
  bool autoComplete = true;
  Completer<void>? uploadGate;
  @override
  Future<AssemblyReply> send(Uri uri,
      {required String method,
      required String apiKey,
      required Stream<List<int>> body,
      required int contentLength,
      required String contentType,
      required RequestCancellation cancellation}) async {
    final data =
        await body.fold<BytesBuilder>(BytesBuilder(), (b, p) => b..add(p));
    requests.add((
      uri: uri,
      method: method,
      key: apiKey,
      length: contentLength,
      contentType: contentType,
      body: data.takeBytes()
    ));
    cancellation.check();
    if (uri.path == '/v2/upload') {
      uploads++;
      if (uploadGate != null) {
        cancellation.abort = () {
          if (!uploadGate!.isCompleted) uploadGate!.complete();
        };
        await uploadGate!.future;
        cancellation.abort = null;
        cancellation.check();
      }
      return AssemblyReply(200, jsonEncode({'upload_url': syntheticUpload}));
    }
    if (uri.path == '/v2/transcript' && method == 'POST') {
      submissions++;
      if (submitReply != null) return submitReply!;
      if (submitFailure == 'unknown') {
        throw const AppFailure('AAI_NETWORK', 'Synthetic lost response');
      }
      if (submitFailure == 'malformed') {
        return const AssemblyReply(200, '{"id": 3}');
      }
      if (submitFailure == '500') return const AssemblyReply(500, '{}');
      if (submitFailure == '401') return const AssemblyReply(401, '{}');
      return AssemblyReply(200, jsonEncode(assemblyResult(status: 'queued')));
    }
    gets++;
    if (getReply != null) return getReply!;
    return AssemblyReply(
        200,
        jsonEncode(assemblyResult(
            status: autoComplete && gets >= 2 ? 'completed' : 'processing',
            id: uri.path.split('/').last)));
  }
}
