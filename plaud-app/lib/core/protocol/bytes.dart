import 'dart:typed_data';

Uint8List unhex(String source) {
  final clean = source.replaceAll(RegExp(r'\s'), '');
  if (clean.isEmpty || !RegExp(r'^(?:[0-9a-fA-F]{2})+$').hasMatch(clean)) {
    throw const FormatException('十六进制格式无效');
  }
  return Uint8List.fromList([
    for (var i = 0; i < clean.length; i += 2)
      int.parse(clean.substring(i, i + 2), radix: 16),
  ]);
}

String hex(List<int> bytes) =>
    bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();

ByteData fields(Uint8List bytes) => ByteData.sublistView(bytes);

int uint32(int value) {
  if (value < 0 || value > 0xffffffff) {
    throw const FormatException('协议字段应为无符号 32 位整数');
  }
  return value;
}

Uint8List le32(int value) =>
    (ByteData(4)..setUint32(0, uint32(value), Endian.little))
        .buffer
        .asUint8List();

Uint8List request(int command) {
  if (command < 0 || command > 0xffff) {
    throw const FormatException('命令编号无效');
  }
  return Uint8List.fromList([1, command & 255, command >> 8]);
}

int? commandOf(Uint8List bytes) => bytes.length >= 3 && bytes[0] == 1
    ? fields(bytes).getUint16(1, Endian.little)
    : null;

void checkControl(Uint8List frame, int command,
    {int? length, int minimum = 3}) {
  if (commandOf(frame) != command ||
      frame.length < minimum ||
      (length != null && frame.length != length)) {
    throw const FormatException('设备响应类型或长度无效');
  }
}
