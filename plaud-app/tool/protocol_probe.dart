import 'dart:convert';
import 'dart:io';

import 'package:plaud_app/core/protocol/advertisement.dart';
import 'package:plaud_app/core/protocol/bytes.dart';
import 'package:plaud_app/core/protocol/files.dart';
import 'package:plaud_app/core/protocol/status.dart';

Object? evaluate(Map<String, dynamic> row) {
  final frame = unhex(row['hex'] as String);
  switch (row['op']) {
    case 'advertisement':
      final device = decodeAdvertisement(frame);
      return device == null
          ? null
          : {
              'serialNumber': device.serialNumber,
              'project': device.project,
              'model': device.model,
              if (device.portVersion != null) 'portVersion': device.portVersion,
            };
    case 'page':
      final page = decodeRecordingPage(frame, row['port'] as int);
      return {
        'requestId': page.requestId,
        'total': page.total,
        'index': page.index,
        'files': page.files
            .map((f) => {
                  'sessionId': f.sessionId,
                  'size': f.size,
                  if (f.scene != null) 'scene': f.scene,
                  if (f.attribute != null) 'attribute': f.attribute
                })
            .toList()
      };
    case 'data':
      final data = decodeFileData(frame, row['port'] as int);
      return {
        if (data.sessionId != null) 'sessionId': data.sessionId,
        'offset': data.offset,
        'data': hex(data.data),
        if (data.endReason != null) 'endReason': data.endReason
      };
    case 'battery':
      final battery = decodeBattery(frame);
      return {'level': battery.level, 'charging': battery.charging};
    case 'storage':
      final storage = decodeStorage(frame);
      return {
        'free': storage.free.toString(),
        'total': storage.total.toString(),
        if (storage.duration != null) 'duration': storage.duration.toString()
      };
    case 'handshake':
      final ack = decodeHandshake(frame);
      return {
        'status': ack.status,
        if (ack.portVersion != null) 'portVersion': ack.portVersion
      };
    default:
      throw const FormatException('Unknown operation');
  }
}

Future<void> main() async {
  final cases =
      jsonDecode(await stdin.transform(utf8.decoder).join()) as List<dynamic>;
  final results = cases.map((value) {
    try {
      return evaluate(value as Map<String, dynamic>);
    } catch (_) {
      return {'error': true};
    }
  }).toList();
  stdout.write(jsonEncode(results));
}
