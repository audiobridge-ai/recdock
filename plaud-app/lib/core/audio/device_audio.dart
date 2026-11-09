import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

import '../../features/auth/models.dart';
import '../crypto/protocol_crypto.dart';
import '../failure.dart';
import '../protocol/bytes.dart';
import 'caf.dart';

final _crcTable = List<int>.generate(256, (value) {
  var crc = value << 24;
  for (var bit = 0; bit < 8; bit++) {
    crc =
        ((crc << 1) ^ ((crc & 0x80000000) != 0 ? 0x04c11db7 : 0)) & 0xffffffff;
  }
  return crc;
});
int oggCrc(Uint8List page) {
  var crc = 0;
  for (var i = 0; i < page.length; i++) {
    final byte = i >= 22 && i < 26 ? 0 : page[i];
    crc = ((crc << 8) ^ _crcTable[((crc >> 24) ^ byte) & 255]) & 0xffffffff;
  }
  return crc;
}

Future<Uint8List> _readExact(RandomAccessFile file, int length) async {
  final bytes = Uint8List(length);
  var offset = 0;
  while (offset < length) {
    final count = await file.readInto(bytes, offset);
    if (count == 0) throw const AppFailure('AUDIO_INCOMPLETE', '音频文件不完整，原件已保留');
    offset += count;
  }
  return bytes;
}

bool _magic(List<int> bytes, String value) =>
    bytes.length >= value.length &&
    List.generate(value.length, (i) => bytes[i] == value.codeUnitAt(i))
        .every((v) => v);

Future<void> validateOggFile(File input) async {
  final file = await input.open();
  final streams = <int, ({int sequence, bool continued, bool ended})>{};
  try {
    final length = await file.length();
    while (await file.position() < length) {
      final header = await _readExact(file, 27);
      if (!_magic(header, 'OggS') || header[4] != 0 || (header[5] & ~7) != 0) {
        throw const AppFailure('AUDIO_INVALID', 'Ogg 容器头无效');
      }
      final segments = await _readExact(file, header[26]);
      final payload =
          await _readExact(file, segments.fold<int>(0, (a, b) => a + b));
      final page = Uint8List.fromList([...header, ...segments, ...payload]),
          data = fields(header);
      if (oggCrc(page) != data.getUint32(22, Endian.little)) {
        throw const AppFailure('AUDIO_CRC_INVALID', 'Ogg 校验失败，原件已保留');
      }
      final serial = data.getUint32(14, Endian.little),
          sequence = data.getUint32(18, Endian.little),
          flags = header[5],
          prior = streams[data.getUint32(14, Endian.little)];
      if (prior == null) {
        if ((flags & 2) == 0 || (flags & 1) != 0 || sequence != 0) {
          throw const AppFailure('AUDIO_INVALID', 'Ogg 首页面无效');
        }
      } else if (prior.ended ||
          (flags & 2) != 0 ||
          sequence != prior.sequence ||
          ((flags & 1) != 0) != prior.continued) {
        throw const AppFailure('AUDIO_INVALID', 'Ogg 页面不连续');
      }
      final continued = segments.isNotEmpty
          ? segments.last == 255
          : prior?.continued ?? false;
      if ((flags & 4) != 0 && continued) {
        throw const AppFailure('AUDIO_INCOMPLETE', 'Ogg 最后一包不完整');
      }
      streams[serial] = (
        sequence: (sequence + 1) & 0xffffffff,
        continued: continued,
        ended: (flags & 4) != 0
      );
    }
    if (streams.isEmpty || streams.values.any((s) => !s.ended || s.continued)) {
      throw const AppFailure('AUDIO_INCOMPLETE', 'Ogg 文件尚未完整结束');
    }
  } finally {
    await file.close();
  }
}

int? opusPacketDuration(Uint8List packet, {bool monoOnly = true}) {
  if (packet.isEmpty || (monoOnly && (packet[0] & 4) != 0)) return null;
  final config = packet[0] >> 3, code = packet[0] & 3;
  final samples = config >= 16
      ? 120 << (config & 3)
      : config >= 12
          ? 480 << (config & 1)
          : [480, 960, 1920, 2880][config & 3];
  var count = code == 0 ? 1 : 2, cursor = 1, end = packet.length;
  int? frameLength() {
    if (cursor >= end) return null;
    final first = packet[cursor++];
    return first < 252
        ? first
        : cursor < end
            ? first + 4 * packet[cursor++]
            : null;
  }

  if (code == 0) {
    if (end - cursor > 1275) return null;
  } else if (code == 1) {
    if ((end - cursor).isOdd || (end - cursor) ~/ 2 > 1275) return null;
  } else if (code == 2) {
    final first = frameLength();
    if (first == null ||
        first > 1275 ||
        first > end - cursor ||
        end - cursor - first > 1275) {
      return null;
    }
  } else {
    if (packet.length < 2) return null;
    final descriptor = packet[cursor++];
    count = descriptor & 63;
    if (count == 0 || count > 48) return null;
    if ((descriptor & 64) != 0) {
      var padding = 0, byte = 0;
      do {
        if (cursor >= end) return null;
        byte = packet[cursor++];
        padding += byte == 255 ? 254 : byte;
        if (padding > end - cursor) return null;
      } while (byte == 255);
      end -= padding;
    }
    if ((descriptor & 128) != 0) {
      var declared = 0;
      for (var i = 0; i < count - 1; i++) {
        final length = frameLength();
        if (length == null || length > 1275) return null;
        declared += length;
      }
      if (declared > end - cursor || end - cursor - declared > 1275) {
        return null;
      }
    } else if (cursor > end ||
        (end - cursor) % count != 0 ||
        (end - cursor) ~/ count > 1275) {
      return null;
    }
  }
  final duration = samples * count;
  return duration <= 5760 ? duration : null;
}

Uint8List _page(
    List<Uint8List> packets, int serial, int sequence, int granule, int flags) {
  final lacing = <int>[];
  for (final packet in packets) {
    var length = packet.length;
    while (length >= 255) {
      lacing.add(255);
      length -= 255;
    }
    lacing.add(length);
  }
  final header = Uint8List(27 + lacing.length), data = fields(header);
  header.setAll(0, ascii.encode('OggS'));
  header[5] = flags;
  data.setUint64(6, granule, Endian.little);
  data.setUint32(14, serial, Endian.little);
  data.setUint32(18, sequence, Endian.little);
  header[26] = lacing.length;
  header.setAll(27, lacing);
  final page =
      Uint8List.fromList([...header, for (final packet in packets) ...packet]);
  fields(page).setUint32(22, oggCrc(page), Endian.little);
  return page;
}

Future<void> wrapMonoOpusFile(File input, File output, {int? serial}) async {
  final length = await input.length();
  if (length == 0 || length % 80 != 0 || input.path == output.path) {
    throw const AppFailure('AUDIO_UNSUPPORTED', '原始音频不是完整的单声道 Opus 帧');
  }
  final reader = await input.open(),
      writer = await output.open(mode: FileMode.write);
  serial ??= fields(randomBytes(4)).getUint32(0, Endian.little);
  try {
    final identification = Uint8List(19)..setAll(0, ascii.encode('OpusHead'));
    identification[8] = 1;
    identification[9] = 1;
    fields(identification).setUint32(12, 16000, Endian.little);
    final vendor = utf8.encode('PLAUD BLE Console'),
        tags = Uint8List(16 + utf8.encode('PLAUD BLE Console').length)
          ..setAll(0, ascii.encode('OpusTags'));
    fields(tags).setUint32(8, vendor.length, Endian.little);
    tags.setAll(12, vendor);
    await writer.writeFrom(_page([identification], serial, 0, 0, 2));
    await writer.writeFrom(_page([tags], serial, 1, 0, 0));
    var completed = 0, sequence = 2;
    while (completed * 80 < length) {
      final packets = <Uint8List>[];
      for (var i = 0; i < 50 && completed * 80 < length; i++, completed++) {
        final packet = await _readExact(reader, 80);
        if (opusPacketDuration(packet) != 960) {
          throw const AppFailure('AUDIO_UNSUPPORTED', '设备音频帧格式或时长无法确认');
        }
        packets.add(packet);
      }
      await writer.writeFrom(_page(packets, serial, sequence++, completed * 960,
          completed * 80 == length ? 4 : 0));
    }
    await writer.flush();
  } finally {
    await reader.close();
    await writer.close();
  }
}

class AudioRecovery {
  const AudioRecovery({this.playable, this.notice});
  final File? playable;
  final String? notice;
}

Future<AudioRecovery> recoverDeviceAudio(File original,
    {required File output,
    RsaMaterial? rsa,
    int? channels,
    bool? isOggAudio}) async {
  File source = original;
  File? decoded;
  String? notice;
  try {
    final reader = await original.open();
    Uint8List prefix;
    try {
      prefix = await reader.read(512);
    } finally {
      await reader.close();
    }
    if (_magic(prefix, 'PLAUD.AI')) {
      if (prefix.length < 512 || await original.length() <= 512) {
        throw const AppFailure('AUDIO_INCOMPLETE', '设备录音原件不完整');
      }
      final header = fields(prefix);
      if (header.getUint16(8, Endian.little) != 1 ||
          header.getUint16(10, Endian.little) != 512 ||
          header.getUint16(52, Endian.little) != 1) {
        throw const AppFailure('AUDIO_UNSUPPORTED', '设备录音版本或加密方式暂不支持');
      }
      channels = header.getUint16(50, Endian.little);
      isOggAudio = header.getUint16(48, Endian.little) == 1;
      if (channels == 0) throw const AppFailure('AUDIO_INVALID', '录音声道信息无效');
      final keyCipher = prefix.sublist(256, 512),
          nonce = prefix.sublist(132, 144),
          segmentSize = header.getUint32(144, Endian.little);
      Uint8List? key;
      if (rsa != null) {
        for (final pem in [rsa.privateKeyPem, ...rsa.history]) {
          try {
            final candidate = rsaDecrypt(pem, keyCipher);
            if (candidate.length == 32) {
              key = candidate;
              break;
            }
            candidate.fillRange(0, candidate.length, 0);
          } on AppFailure {
            /* Try a previously retained key belonging to this account. */
          }
        }
      }
      if (key == null &&
          keyCipher[0] == 0 &&
          keyCipher[1] == 2 &&
          keyCipher[223] == 0) {
        key = keyCipher.sublist(224);
        notice = '已按设备固件兼容格式恢复音频';
      }
      if (key == null) {
        throw const AppFailure('RECORDING_KEY_MISSING', '缺少此录音对应的账号密钥，原件已保留');
      }
      decoded = File('${output.path}.decrypted');
      final input = await original.open(),
          sink = await decoded.open(mode: FileMode.write);
      try {
        await input.setPosition(512);
        var within = 0;
        var cipher = ChaCha7539Engine()
          ..init(false, ParametersWithIV(KeyParameter(key), nonce));
        while (true) {
          final limit =
              segmentSize == 0 ? 65536 : (segmentSize - within).clamp(1, 65536);
          final part = await input.read(limit);
          if (part.isEmpty) break;
          await sink.writeFrom(cipher.process(part));
          if (segmentSize > 0) {
            within += part.length;
            if (within == segmentSize) {
              within = 0;
              cipher = ChaCha7539Engine()
                ..init(false, ParametersWithIV(KeyParameter(key), nonce));
            }
          }
        }
        await sink.flush();
      } finally {
        key.fillRange(0, key.length, 0);
        await input.close();
        await sink.close();
      }
      source = decoded;
    }
    final file = await source.open();
    Uint8List magic;
    try {
      magic = await file.read(4);
    } finally {
      await file.close();
    }
    if (_magic(magic, 'OggS')) {
      await validateOggFile(source);
      await source.copy(output.path);
    } else {
      if (isOggAudio != false || channels != 1) {
        throw const AppFailure('AUDIO_UNSUPPORTED', '尚未确认支持的音频格式，原件已保留');
      }
      await wrapMonoOpusFile(source, output);
      await validateOggFile(output);
    }
    return AudioRecovery(playable: output, notice: notice);
  } on AppFailure catch (e) {
    if (await output.exists()) await output.delete();
    return AudioRecovery(notice: e.message);
  } catch (_) {
    if (await output.exists()) await output.delete();
    return const AudioRecovery(notice: '音频恢复未完成，原件已保留，可稍后重试');
  } finally {
    if (decoded != null && await decoded.exists()) await decoded.delete();
  }
}

/// Only repackages Opus into Apple's CAF container. No resampling or re-encoding.
Future<File> iosPlayableFile(File ogg, {bool? ios}) async {
  if (!(ios ?? Platform.isIOS) || !ogg.path.toLowerCase().endsWith('.ogg')) {
    return ogg;
  }
  final caf = File('${ogg.path}.caf');
  if (await caf.exists() && await caf.length() > 0) return caf;
  await validateOggFile(ogg);
  final temporary = File('${caf.path}.pending');
  try {
    await oggToCafStreaming(ogg, temporary,
        (packet) => opusPacketDuration(packet, monoOnly: false));
    if (await temporary.length() == 0) {
      throw const AppFailure('AUDIO_CONVERSION_FAILED', '音频播放副本生成失败');
    }
    return await temporary.rename(caf.path);
  } finally {
    if (await temporary.exists()) await temporary.delete();
  }
}
