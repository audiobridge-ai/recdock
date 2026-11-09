import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../failure.dart';

Future<Uint8List> _read(RandomAccessFile reader, int length) async {
  final bytes = Uint8List(length);
  var offset = 0;
  while (offset < length) {
    final count = await reader.readInto(bytes, offset);
    if (count == 0) throw const AppFailure('AUDIO_INCOMPLETE', '音频文件不完整');
    offset += count;
  }
  return bytes;
}

Stream<Uint8List> _packets(
    File file, void Function(Uint8List header) onPage) async* {
  final reader = await file.open();
  var packet = BytesBuilder(copy: false);
  try {
    final size = await reader.length();
    while (await reader.position() < size) {
      final header = await _read(reader, 27);
      onPage(header);
      final segments = await _read(reader, header[26]);
      final payload =
          await _read(reader, segments.fold<int>(0, (a, b) => a + b));
      var at = 0;
      for (final length in segments) {
        packet.add(Uint8List.sublistView(payload, at, at + length));
        at += length;
        if (packet.length > 1024 * 1024) {
          throw const AppFailure('AUDIO_UNSUPPORTED', '音频数据包超过支持范围');
        }
        if (length < 255) {
          yield packet.takeBytes();
          packet = BytesBuilder(copy: false);
        }
      }
    }
    if (packet.isNotEmpty) {
      throw const AppFailure('AUDIO_INCOMPLETE', '音频尾部不完整');
    }
  } finally {
    await reader.close();
  }
}

Uint8List _chunk(String type, int size) {
  final header = ByteData(12)..setInt64(4, size);
  header.buffer.asUint8List().setAll(0, ascii.encode(type));
  return header.buffer.asUint8List();
}

List<int> _varint(int value) {
  final parts = <int>[value & 127];
  while ((value >>= 7) != 0) {
    parts.insert(0, (value & 127) | 128);
  }
  return parts;
}

/// CAF uses big-endian chunk fields and variable packet-size table entries.
/// Audio packets stream to disk; packet metadata goes to a small temporary index.
Future<void> oggToCafStreaming(
    File input, File output, int? Function(Uint8List) duration) async {
  final writer = await output.open(mode: FileMode.write);
  final indexFile = File('${output.path}.index'),
      index = await File('${output.path}.index').open(mode: FileMode.write);
  int? stream, channels, skip, frameSize;
  var finalGranule = -1,
      packetNumber = 0,
      count = 0,
      samples = 0,
      audioBytes = 0;
  var variableFrames = false;
  try {
    final fileHeader = ByteData(8)..setUint16(4, 1);
    fileHeader.buffer.asUint8List().setAll(0, ascii.encode('caff'));
    await writer.writeFrom(fileHeader.buffer.asUint8List());
    await writer.writeFrom(_chunk('desc', 32));
    await writer.writeFrom(Uint8List(32));
    await writer.writeFrom(_chunk('chan', 12));
    await writer.writeFrom(Uint8List(12));
    final dataAt = await writer.position();
    await writer.writeFrom(_chunk('data', -1));
    await writer.writeFrom(Uint8List(4));
    await for (final packet in _packets(input, (header) {
      final data = ByteData.sublistView(header),
          serial = ByteData.sublistView(header).getUint32(14, Endian.little);
      if (stream != null && stream != serial) {
        throw const AppFailure('AUDIO_UNSUPPORTED', '多音轨 Ogg 暂不支持此播放方式');
      }
      stream = serial;
      if ((header[5] & 4) != 0) finalGranule = data.getInt64(6, Endian.little);
    })) {
      if (packetNumber++ == 0) {
        if (packet.length < 19 ||
            ascii.decode(packet.sublist(0, 8), allowInvalid: true) !=
                'OpusHead' ||
            packet[8] != 1 ||
            ![1, 2].contains(packet[9]) ||
            packet[18] != 0 ||
            ByteData.sublistView(packet).getInt16(16, Endian.little) != 0) {
          throw const AppFailure('AUDIO_UNSUPPORTED', '此 Opus 音轨布局暂不支持');
        }
        channels = packet[9];
        skip = ByteData.sublistView(packet).getUint16(10, Endian.little);
        continue;
      }
      if (packetNumber == 2) {
        if (packet.length < 8 ||
            ascii.decode(packet.sublist(0, 8), allowInvalid: true) !=
                'OpusTags') {
          throw const AppFailure('AUDIO_INVALID', 'Opus 标签头缺失');
        }
        continue;
      }
      final frames = duration(packet);
      if (frames == null || packet.length > 65535) {
        throw const AppFailure('AUDIO_UNSUPPORTED', 'Opus 数据包格式无法确认');
      }
      frameSize ??= frames;
      if (frames != frameSize) variableFrames = true;
      final entry = ByteData(6)
        ..setUint32(0, packet.length)
        ..setUint16(4, frames);
      await index.writeFrom(entry.buffer.asUint8List());
      await writer.writeFrom(packet);
      count++;
      samples += frames;
      audioBytes += packet.length;
    }
    if (count == 0 ||
        channels == null ||
        skip == null ||
        finalGranule < skip ||
        finalGranule > samples) {
      throw const AppFailure('AUDIO_INVALID', 'Opus 时间范围无效');
    }
    await index.flush();
    await index.close();
    final paktAt = await writer.position();
    await writer.writeFrom(_chunk('pakt', -1));
    final tableHeader = ByteData(24)
      ..setInt64(0, count)
      ..setInt64(8, finalGranule - skip)
      ..setInt32(16, skip)
      ..setInt32(20, samples - finalGranule);
    await writer.writeFrom(tableHeader.buffer.asUint8List());
    final indexReader = await indexFile.open();
    try {
      for (var i = 0; i < count; i++) {
        final entry = ByteData.sublistView(await _read(indexReader, 6));
        await writer.writeFrom(Uint8List.fromList([
          ..._varint(entry.getUint32(0)),
          if (variableFrames) ..._varint(entry.getUint16(4))
        ]));
      }
    } finally {
      await indexReader.close();
    }
    final end = await writer.position(), tableSize = end - paktAt - 12;
    final description = ByteData(32)
      ..setFloat64(0, 48000)
      ..setUint32(20, variableFrames ? 0 : frameSize!)
      ..setUint32(24, channels);
    description.buffer.asUint8List().setAll(8, ascii.encode('opus'));
    await writer.setPosition(20);
    await writer.writeFrom(description.buffer.asUint8List());
    final channel = ByteData(12)
      ..setUint32(0, channels == 2 ? 6619138 : 6553601);
    await writer.setPosition(64);
    await writer.writeFrom(channel.buffer.asUint8List());
    await writer.setPosition(dataAt);
    await writer.writeFrom(_chunk('data', audioBytes + 4));
    await writer.setPosition(paktAt);
    await writer.writeFrom(_chunk('pakt', tableSize));
    await writer.flush();
  } finally {
    try {
      await index.close();
    } catch (_) {}
    await writer.close();
    if (await indexFile.exists()) await indexFile.delete();
  }
}
