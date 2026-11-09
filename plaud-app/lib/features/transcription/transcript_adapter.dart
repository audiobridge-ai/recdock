import 'dart:math';
import '../../core/failure.dart';
import 'models.dart';

TranscriptRevision assemblyTranscript(Json result, TranscriptionJob job) {
  if (result['id'] != job.remoteId || result['status'] != 'completed') {
    throw const AppFailure('AAI_RESULT_INVALID', '转写结果不属于当前任务');
  }
  final full = result['text'] as String? ?? '';
  final utterances = result['utterances'], rawWords = result['words'];
  var rows = utterances is List ? utterances.map(mapOf).toList() : <Json>[];
  bool timed(Json row) =>
      row['start'] is int &&
      row['end'] is int &&
      row['start'] >= 0 &&
      row['end'] > row['start'];
  if (rows.isEmpty &&
      rawWords is List &&
      rawWords.isNotEmpty &&
      rawWords.map(mapOf).every(timed)) {
    final words = rawWords.map(mapOf).toList();
    rows = [
      for (var i = 0; i < words.length; i += 40)
        {
          'start': words[i]['start'],
          'end': words[min(i + 39, words.length - 1)]['end'],
          'speaker': null,
          'text': words
              .sublist(i, min(i + 40, words.length))
              .map((w) => w['text'])
              .join(' '),
          'words': words.sublist(i, min(i + 40, words.length))
        }
    ];
  }
  final usable =
      rows.isNotEmpty && rows.every((r) => timed(r) && r['text'] is String);
  final speakers = <String, Json>{};
  final segments = <Json>[];
  Json? score(Object? confidence) => confidence is num &&
          confidence.isFinite &&
          confidence >= 0 &&
          confidence <= 1
      ? {'engine': 'assemblyai', 'kind': 'confidence', 'value': confidence}
      : null;
  if (usable) {
    for (var i = 0; i < rows.length; i++) {
      final row = rows[i], label = row['speaker']?.toString();
      String? speakerId;
      if (label != null && label.isNotEmpty) {
        speakerId = 'SPEAKER_${speakers.length.toString().padLeft(2, '0')}';
        final entry = speakers.putIfAbsent(
            label,
            () => {
                  'id': speakerId,
                  'displayName': '说话人 ${speakers.length + 1}',
                  'nameSource': 'default'
                });
        speakerId = entry['id'] as String;
      }
      final words = <Json>[];
      var previousWordStart = -1;
      if (row['words'] is List) {
        for (final word in (row['words'] as List).map(mapOf)) {
          final hasTime = timed(word) &&
              word['start'] >= previousWordStart &&
              word['start'] >= row['start'] &&
              word['end'] <= row['end'];
          if (hasTime) previousWordStart = word['start'] as int;
          words.add({
            'text': word['text'] as String? ?? '',
            'startMs': hasTime ? word['start'] : null,
            'endMs': hasTime ? word['end'] : null,
            'timingSource': hasTime ? 'segment' : 'unavailable',
            'scores': score(word['confidence']) == null
                ? null
                : [score(word['confidence'])]
          });
        }
      }
      segments.add({
        'id': 'seg_$i',
        'startMs': row['start'],
        'endMs': row['end'],
        'speakerId': speakerId,
        'text': row['text'],
        'timingSource': 'asr_segment',
        'overlap': false,
        'flags': [if (speakerId == null) 'speaker_uncertain'],
        'sourceChunkIds': ['chunk_full'],
        'words': words,
        'scores':
            score(row['confidence']) == null ? null : [score(row['confidence'])]
      });
    }
    // Providers may return real overlapping utterance intervals. Preserve them.
    final ordered = segments.toList()
      ..sort((a, b) => (a['startMs'] as int).compareTo(b['startMs'] as int));
    Json? longest;
    for (final row in ordered) {
      if (longest != null && row['startMs'] < longest['endMs']) {
        for (final s in [row, longest]) {
          s['overlap'] = true;
          (s['flags'] as List).add('overlap');
        }
      }
      if (longest == null || row['endMs'] > longest['endMs']) longest = row;
    }
  }
  var duration = job.durationMs;
  segments.sort((a, b) => (a['startMs'] as int).compareTo(b['startMs'] as int));
  if (result['audio_duration'] is num &&
      (result['audio_duration'] as num).isFinite) {
    duration =
        max(duration, ((result['audio_duration'] as num) * 1000).round());
  }
  for (final row in segments) {
    duration = max(duration, row['endMs'] as int);
    row['flags'] = (row['flags'] as List).toSet().toList();
  }
  Json model(String engine) => {
        'engine': engine,
        'model': result['speech_model_used'] as String? ?? 'undisclosed',
        'revision': 'api-v2',
        'quantization': null
      };
  return TranscriptRevision(
      createdAt: DateTime.now().millisecondsSinceEpoch,
      providerText: full,
      untimedText: usable
          ? ''
          : (full.isNotEmpty
              ? full
              : rows.map((r) => r['text'] ?? '').join('\n')),
      transcript: {
        'schemaVersion': 1,
        'recordingId': job.recordingId,
        'sourceSha256': job.sourceSha256,
        'durationMs': duration,
        'revisionId': newId('rev'),
        'language': result['language_code'] as String? ??
            (job.language == 'auto' ? 'und' : job.language),
        'provenance': {
          'pipelineVersion': 'assemblyai-app-v1',
          'asr': model('assemblyai'),
          'aligner': null,
          'diarizer': speakers.isEmpty
              ? null
              : {...model('assemblyai'), 'model': 'undisclosed'}
        },
        'speakers': speakers.values.toList(),
        'segments': segments,
        'chunks': [
          {
            'id': 'chunk_full',
            'startMs': 0,
            'endMs': duration,
            'paddingLeftMs': 0,
            'paddingRightMs': 0,
            'status': 'ready',
            'errorCode': null
          }
        ],
        'speakerTurns': [
          for (final s in segments)
            if (s['speakerId'] != null)
              {
                'id': 'turn_${s['id']}',
                'startMs': s['startMs'],
                'endMs': s['endMs'],
                'speakerId': s['speakerId'],
                'overlap': s['overlap']
              }
        ]
      });
}
