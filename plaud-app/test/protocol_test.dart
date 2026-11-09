import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:plaud_app/core/protocol/advertisement.dart';
import 'package:plaud_app/core/protocol/bytes.dart';
import 'package:plaud_app/core/protocol/files.dart';
import 'package:plaud_app/core/protocol/status.dart';

void main() {
  // Fixtures match plaud-web/tests/{discovery,files}.test.ts. No real account data.
  group('Web / App 广播契约', () {
    test('真实布局的脱敏广播识别 Note 和协议 20', () {
      final bytes =
          unhex('027803045608020209888001234567890000140000000000000101');
      final decoded = decodeAdvertisement(bytes)!;
      expect(decoded.model, 'Plaud Note');
      expect(decoded.serialNumber, '888001234567890000');
      expect(decoded.portVersion, 20);
      for (final company in [0x46, 0x59]) {
        expect(
            decodeMobileManufacturer(Uint8List.fromList([company, 0, ...bytes]))
                ?.portVersion,
            20);
      }
      expect(
          decodeMobileManufacturer(Uint8List.fromList([0x34, 0x12, ...bytes])),
          isNull);
    });
    test('六种型号和不同版本长度均按 SN 识别', () {
      for (final project in plaudModels.keys) {
        for (final versionLength in [1, 3, 4, 5]) {
          for (final serial in [
            unhex('${project}0012345678900'),
            utf8.encode('${project}0012345678900')
          ]) {
            final payload = Uint8List.fromList([
              versionLength,
              0x52,
              ...List.filled(versionLength - 1, 0),
              serial.length,
              ...serial,
              ...List.filled(8, 0)
            ]);
            expect(decodeAdvertisement(payload)?.project, project);
          }
        }
      }
    });
    test('头部布局号决定版本偏移；长 SN 和 860 不推定协议', () {
      final bytes = unhex('04560100000888800123456789000000000000000000');
      fields(bytes).setUint16(15, 9, Endian.little);
      fields(bytes).setUint16(18, 30, Endian.little);
      expect(decodeAdvertisement(bytes)?.portVersion, 9);
      final serial = utf8.encode('8880012345678900');
      expect(
          decodeAdvertisement(Uint8List.fromList([
            ...unhex('0278030456010000'),
            serial.length,
            ...serial,
            1,
            1
          ]))?.portVersion,
          isNull);
      final one = Uint8List.fromList(
          [1, 0x56, 8, ...unhex('8600012345678900'), ...List.filled(12, 0)]);
      expect(decodeAdvertisement(one)?.portVersion, isNull);
    });
    test('未知和截断广播不会误报设备', () {
      final frame =
          unhex('027803045608020209888001234567890000140000000000000101');
      for (var length = 0; length < 18; length++) {
        expect(decodeAdvertisement(Uint8List.sublistView(frame, 0, length)),
            isNull);
      }
      frame[9] = 0x12;
      expect(decodeAdvertisement(frame), isNull);
    });
  });
  group('Web / App 文件协议契约', () {
    test('请求字节与 Web 固定报文一致', () {
      expect(hex(listRecordingsRequest(0x12345678, sessionId: 0x90abcdef)),
          '011a0078563412efcdab9000');
      expect(hex(syncRecordingRequest(0x12345678, 0x90abcdef)),
          '011c0078563412efcdab9000000000');
      expect(hex(syncRecordingRequest(7, 80, end: 160)),
          '011c000700000050000000a0000000');
      expect(hex(stopRecordingSyncRequest()), '011d00');
      for (final bad in [-1, 0x100000000]) {
        expect(() => listRecordingsRequest(bad), throwsFormatException);
        expect(() => syncRecordingRequest(1, bad), throwsFormatException);
      }
      expect(
          () => syncRecordingRequest(1, 160, end: 80), throwsFormatException);
    });
    test('目录保留无符号数及 scene/attribute 字节顺序', () {
      final frame = unhex(
          '011a00785634120200000004030201080706050209ffffffff000000000104');
      final backing = Uint8List.fromList([9, 9, ...frame, 9]);
      final page = decodeRecordingPage(
          Uint8List.sublistView(backing, 2, backing.length - 1), 20);
      expect(page.requestId, 0x12345678);
      expect(page.total, 2);
      expect(page.index, 0);
      expect(page.files.first.sessionId, 0x01020304);
      expect(page.files.first.size, 0x05060708);
      expect(page.files.first.scene, 2);
      expect(page.files.first.attribute, 9);
      expect(page.files.last.sessionId, 0xffffffff);
    });
    test('旧目录布局不制造不存在的字段', () {
      final header = unhex('011a0001000000010000000403020108070605');
      expect(decodeRecordingPage(header, 1).files.single.attribute, isNull);
      final old = decodeRecordingPage(Uint8List.fromList([...header, 7]), 6)
          .files
          .single;
      expect(old.scene, isNull);
      expect(old.attribute, 7);
      expect(decodeRecordingPage(unhex('011a000100000000000000'), 20).files,
          isEmpty);
    });
    test('截断、计数冲突和无效端口严格拒绝', () {
      final frame = unhex('011a00785634120100000004030201080706050209');
      for (var length = 0; length < frame.length; length++) {
        expect(
            () => decodeRecordingPage(
                Uint8List.sublistView(frame, 0, length), 20),
            throwsFormatException);
      }
      for (final port in [0, -1, 65536]) {
        expect(() => decodeRecordingPage(frame, port), throwsFormatException);
      }
      fields(frame).setUint16(9, 1, Endian.little);
      expect(() => decodeRecordingPage(frame, 20), throwsFormatException);
    });
    test('数据偏移按版本变化，数据副本不被输入修改', () {
      final bytes = unhex('02ffffffff7856341203616263');
      final decoded = decodeFileData(bytes, 20);
      expect(decoded.sessionId, 0xffffffff);
      expect(decoded.offset, 0x12345678);
      bytes[10] = 0;
      expect(decoded.data, [97, 98, 99]);
      final old = decodeFileData(unhex('027856341203616263'), 6);
      expect(old.sessionId, isNull);
      expect(old.offset, 0x12345678);
    });
    test('结束原因不与长度混用，CRC 原样保留', () {
      expect(decodeFileData(unhex('0207000000ffffffff0005'), 20).endReason, 5);
      expect(decodeFileHead(unhex('011c007856341200')),
          (sessionId: 0x12345678, status: 0));
      expect(decodeFileTail(unhex('011d0078563412b129')),
          (sessionId: 0x12345678, crc: 0x29b1));
      expect(() => decodeFileStop(unhex('011e00')), returnsNormally);
      for (final value in [
        '0207000000ffffffff01',
        '020700000000000000036162',
        '020700000000000000016162',
        '0207000000feffffff026162'
      ]) {
        expect(() => decodeFileData(unhex(value), 20), throwsFormatException);
      }
    });
  });
  group('状态与整数边界', () {
    test('电量零值有效，超范围拒绝', () {
      expect(decodeBattery(unhex('0109000100')), (level: 0, charging: true));
      expect(() => decodeBattery(unhex('0109000065')), throwsFormatException);
      expect(decodeHandshake(unhex('010100001400')).portVersion, 20);
    });
    test('存储保留全部 64 位无符号范围', () {
      final storage =
          decodeStorage(unhex('0106000100000000000000ffffffffffffffff'));
      expect(storage.free, BigInt.one);
      expect(storage.total, (BigInt.one << 64) - BigInt.one);
      expect(
          () => decodeStorage(unhex('01060002000000000000000100000000000000')),
          throwsFormatException);
    });
  });
}
