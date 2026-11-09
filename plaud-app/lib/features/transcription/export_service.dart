import 'dart:convert';
import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'models.dart';
import 'transcript_export.dart';

class TranscriptExportService {
  Future<bool> save(TranscriptExport output) async =>
      await FilePicker.platform.saveFile(
          dialogTitle: '导出转写全文',
          fileName: 'transcript.${output.extension}',
          type: FileType.custom,
          allowedExtensions: [output.extension],
          bytes: Uint8List.fromList(utf8.encode(output.content))) !=
      null;
  Future<void> share(TranscriptExport output) async {
    final directory = Directory(
        p.join((await getTemporaryDirectory()).path, 'transcript-exports'));
    await directory.create(recursive: true);
    final file = File(p.join(directory.path,
        'transcript-${newId('export').split('_').last}.${output.extension}'));
    await file.writeAsString(output.content, flush: true);
    await const MethodChannel('ai.audiobridge.recdock/platform')
        .invokeMethod<void>(
            'shareTranscript', {'path': file.path, 'mime': output.mime});
  }
}
