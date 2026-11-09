import 'dart:typed_data';

import 'bytes.dart';

class RecordingFile {
  const RecordingFile(this.sessionId, this.size, {this.scene, this.attribute});
  final int sessionId;
  final int size;
  final int? scene;
  final int? attribute;
}

class RecordingPage {
  const RecordingPage(this.requestId, this.total, this.index, this.files);
  final int requestId;
  final int total;
  final int index;
  final List<RecordingFile> files;
}

void _port(int port) {
  if (port < 1 || port > 65535) throw const FormatException('设备协议版本无效');
}

Uint8List listRecordingsRequest(int requestId, {int sessionId = 0}) =>
    Uint8List.fromList(
        [...request(0x1a), ...le32(requestId), ...le32(sessionId), 0]);

RecordingPage decodeRecordingPage(Uint8List frame, int port) {
  checkControl(frame, 0x1a, minimum: 11);
  _port(port);
  final data = fields(frame);
  final total = data.getUint16(7, Endian.little);
  final index = data.getUint16(9, Endian.little);
  final itemSize = port == 1
      ? 8
      : port <= 6
          ? 9
          : 10;
  final payloadSize = frame.length - 11;
  if (payloadSize % itemSize != 0) throw const FormatException('目录条目长度无效');
  final count = payloadSize ~/ itemSize;
  if (index > total ||
      count > total - index ||
      (total == 0 && (index != 0 || count != 0)) ||
      (total > 0 && count == 0)) {
    throw const FormatException('目录条目数量或索引无效');
  }
  return RecordingPage(data.getUint32(3, Endian.little), total, index, [
    for (var at = 11; at < frame.length; at += itemSize)
      RecordingFile(data.getUint32(at, Endian.little),
          data.getUint32(at + 4, Endian.little),
          scene: itemSize == 10 ? frame[at + 8] : null,
          attribute: itemSize == 8 ? null : frame[at + itemSize - 1]),
  ]);
}

Uint8List syncRecordingRequest(int sessionId, int start, {int end = 0}) {
  uint32(start);
  uint32(end);
  if (end != 0 && end < start) throw const FormatException('文件下载范围无效');
  return Uint8List.fromList(
      [...request(0x1c), ...le32(sessionId), ...le32(start), ...le32(end)]);
}

Uint8List stopRecordingSyncRequest() => request(0x1d);

({int sessionId, int status}) decodeFileHead(Uint8List frame) {
  checkControl(frame, 0x1c, length: 8);
  return (
    sessionId: fields(frame).getUint32(3, Endian.little),
    status: frame[7]
  );
}

class FileData {
  const FileData(
      {this.sessionId,
      required this.offset,
      required this.data,
      this.endReason});
  final int? sessionId;
  final int offset;
  final Uint8List data;
  final int? endReason;
}

FileData decodeFileData(Uint8List frame, int port) {
  _port(port);
  final hasSession = port >= 7, offsetAt = hasSession ? 5 : 1;
  final payloadAt = offsetAt + 5;
  if (frame.length < payloadAt || frame[0] != 2) {
    throw const FormatException('录音数据响应类型或长度无效');
  }
  final data = fields(frame), offset = data.getUint32(offsetAt, Endian.little);
  final session = hasSession ? data.getUint32(1, Endian.little) : null;
  if (offset == 0xffffffff) {
    if (frame.length <= payloadAt) throw const FormatException('录音结束数据缺少原因码');
    return FileData(
        sessionId: session,
        offset: offset,
        data: Uint8List(0),
        endReason: frame[payloadAt]);
  }
  final length = frame[offsetAt + 4];
  if (length == 0 ||
      frame.length != payloadAt + length ||
      offset + length > 0xffffffff) {
    throw const FormatException('录音数据载荷长度或偏移无效');
  }
  return FileData(
      sessionId: session,
      offset: offset,
      data: Uint8List.fromList(frame.sublist(payloadAt)));
}

({int sessionId, int crc}) decodeFileTail(Uint8List frame) {
  checkControl(frame, 0x1d, length: 9);
  return (
    sessionId: fields(frame).getUint32(3, Endian.little),
    crc: fields(frame).getUint16(7, Endian.little)
  );
}

void decodeFileStop(Uint8List frame) => checkControl(frame, 0x1e, length: 3);
