import 'dart:convert';
import 'dart:io';
import 'package:plaud_app/features/transcription/models.dart';
import 'package:plaud_app/features/transcription/transcript_adapter.dart';
import '../test/helpers/assembly_peer.dart';

void main() {
  final job = TranscriptionJob(
      id: newId('job'),
      recordingId: 'rec_synthetic',
      sourceSha256: 'a' * 64,
      audioSha256: 'b' * 64,
      scope: 'personal',
      region: 'us',
      keyFingerprint: 'c' * 64,
      language: 'zh',
      models: ['universal-2'],
      durationMs: 2000,
      createdAt: 1,
      remoteId: syntheticRemoteId,
      uploadUrl: syntheticUpload);
  final cases = <Json>[
    assemblyResult(),
    assemblyResult()
      ..['utterances'] = null
      ..['words'] = null,
    assemblyResult()..['speech_model_used'] = null,
    assemblyResult()
      ..['utterances'] = [
        {'start': 1000, 'end': 1000, 'text': '缺少可靠时间'}
      ],
    assemblyResult()
      ..['utterances'] = [
        {'start': 0, 'end': 1000, 'text': 'A', 'speaker': 'A'},
        {'start': 500, 'end': 1800, 'text': 'B', 'speaker': 'B'}
      ],
    assemblyResult()
      ..['utterances'] = null
      ..['words'] = [
        {'start': 100, 'end': 200, 'text': 'word'}
      ]
  ];
  stdout.writeln(jsonEncode(
      [for (final value in cases) assemblyTranscript(value, job).transcript]));
}
