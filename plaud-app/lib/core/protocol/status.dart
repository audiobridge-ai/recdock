import 'dart:typed_data';

import 'bytes.dart';

typedef DeviceState = ({
  int stateCode,
  bool privacy,
  int? keyStateCode,
  bool? usb,
  int? scene,
  int? sessionId
});
DeviceState decodeDeviceState(Uint8List frame) {
  checkControl(frame, 3, minimum: 8);
  return (
    stateCode: fields(frame).getUint32(3, Endian.little),
    privacy: frame[7] == 1,
    keyStateCode: frame.length >= 9 ? frame[8] : null,
    usb: frame.length >= 10 ? frame[9] == 1 : null,
    scene: frame.length >= 15 ? frame[10] : null,
    sessionId:
        frame.length >= 15 ? fields(frame).getUint32(11, Endian.little) : null
  );
}

({int level, bool charging}) decodeBattery(Uint8List frame) {
  checkControl(frame, 9, minimum: 5);
  if (frame[4] > 100) throw const FormatException('设备电量超出 0–100%');
  return (level: frame[4], charging: frame[3] == 1);
}

BigInt _u64(Uint8List frame, int at) {
  final data = fields(frame);
  return BigInt.from(data.getUint32(at, Endian.little)) |
      (BigInt.from(data.getUint32(at + 4, Endian.little)) << 32);
}

({BigInt free, BigInt total, BigInt? duration}) decodeStorage(Uint8List frame) {
  checkControl(frame, 6, minimum: 19);
  final free = _u64(frame, 3), total = _u64(frame, 11);
  if (free > total) throw const FormatException('可用容量大于总容量');
  return (
    free: free,
    total: total,
    duration: frame.length >= 27 ? _u64(frame, 19) : null
  );
}

({int status, int? portVersion}) decodeHandshake(Uint8List frame) {
  checkControl(frame, 1, minimum: 4);
  return (
    status: frame[3],
    portVersion:
        frame.length >= 6 ? fields(frame).getUint16(4, Endian.little) : null
  );
}
