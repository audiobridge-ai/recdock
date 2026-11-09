import test from 'node:test';
import assert from 'node:assert/strict';
import { concat, hex, unhex, view } from '../src/protocol/bytes.ts';
import {
  listRecordingsRequest, decodeRecordingPage, syncRecordingRequest, stopRecordingSyncRequest,
  decodeFileHead, decodeFileData, decodeFileTail, decodeFileStop,
} from '../src/protocol/files.ts';

test('目录、同步和停止请求使用APK的精确LE命令与end=0约定', () => {
  assert.equal(hex(listRecordingsRequest(0x12345678, 0x90abcdef)), '011a0078563412efcdab9000');
  assert.equal(hex(listRecordingsRequest(1)), '011a00010000000000000000');
  assert.equal(hex(syncRecordingRequest(0x12345678, 0x90abcdef)), '011c0078563412efcdab9000000000');
  assert.equal(hex(syncRecordingRequest(7, 80, 160)), '011c000700000050000000a0000000');
  assert.equal(hex(stopRecordingSyncRequest()), '011d00');
  for (const bad of [-1, 1.5, 0x100000000, NaN, Infinity]) {
    assert.throws(() => listRecordingsRequest(bad));
    assert.throws(() => listRecordingsRequest(0, bad));
    assert.throws(() => syncRecordingRequest(1, bad));
    assert.throws(() => syncRecordingRequest(bad, 0));
    assert.throws(() => syncRecordingRequest(1, 0, bad));
  }
  assert.throws(() => syncRecordingRequest(1, 160, 80));
});

test('port20目录解析requestId/total/index和scene→attribute字节顺序', () => {
  const packet = unhex('011a00785634120200000004030201080706050209ffffffff000000000104');
  assert.deepEqual(decodeRecordingPage(packet, 20), {
    requestId: 0x12345678, total: 2, index: 0,
    files: [
      { sessionId: 0x01020304, size: 0x05060708, scene: 2, attribute: 9 },
      { sessionId: 0xffffffff, size: 0, scene: 1, attribute: 4 },
    ],
  });
  const second = unhex('011a007856341202000100ffffffff000000000104');
  assert.equal(decodeRecordingPage(second, 20).index, 1);
  const backing = concat(Uint8Array.of(9, 9), packet, Uint8Array.of(9));
  assert.deepEqual(decodeRecordingPage(backing.subarray(2, -1), 20), decodeRecordingPage(packet, 20));
});

test('旧协议目录条目长度遵循8/9字节，不伪造缺失元数据', () => {
  const header = unhex('011a000100000001000000');
  const record = unhex('0403020108070605');
  assert.deepEqual(decodeRecordingPage(concat(header, record), 1).files, [{ sessionId: 0x01020304, size: 0x05060708 }]);
  assert.deepEqual(decodeRecordingPage(concat(header, record, Uint8Array.of(7)), 6).files, [{ sessionId: 0x01020304, size: 0x05060708, attribute: 7 }]);
  assert.deepEqual(decodeRecordingPage(unhex('011a000100000000000000'), 20).files, []);
});

test('目录拒绝短头、截断条目、越界计数、错误命令和非法端口', () => {
  const valid = unhex('011a00785634120100000004030201080706050209');
  for (let length = 0; length < 11; length++) assert.throws(() => decodeRecordingPage(valid.slice(0, length), 20));
  assert.throws(() => decodeRecordingPage(valid.slice(0, -1), 20));
  assert.throws(() => decodeRecordingPage(concat(valid, Uint8Array.of(0)), 20));
  for (const [total, index] of [[0, 0], [1, 1], [1, 2]]) {
    const frame = valid.slice(); view(frame).setUint16(7, total, true); view(frame).setUint16(9, index, true);
    assert.throws(() => decodeRecordingPage(frame, 20));
  }
  assert.throws(() => decodeRecordingPage(valid.slice(0, 11), 20));
  const wrong = valid.slice(); wrong[1] = 0x1c;
  assert.throws(() => decodeRecordingPage(wrong, 20));
  for (const port of [0, -1, 1.5, 65536]) assert.throws(() => decodeRecordingPage(valid, port));
});

test('下载head/tail/stop响应独立于GATT ACK，保留原始status和CRC', () => {
  assert.deepEqual(decodeFileHead(unhex('011c007856341200')), { sessionId: 0x12345678, status: 0 });
  assert.equal(decodeFileHead(unhex('011c0078563412ff')).status, 255);
  assert.deepEqual(decodeFileTail(unhex('011d0078563412b129')), { sessionId: 0x12345678, crc: 0x29b1 });
  assert.equal(decodeFileStop(unhex('011e00')), undefined);
  assert.throws(() => decodeFileStop(unhex('011d00')));
  assert.throws(() => decodeFileStop(unhex('011e0000')));
  assert.throws(() => decodeFileHead(unhex('011c0078563412')));
  assert.throws(() => decodeFileTail(unhex('011d0078563412b1')));
  assert.throws(() => decodeFileHead(unhex('011d007856341200')));
});

test('port20与旧版数据偏移不同，unsigned会话和偏移不变号', () => {
  const encoded = unhex('02ffffffff7856341203616263');
  assert.deepEqual(decodeFileData(encoded, 20), { sessionId: 0xffffffff, offset: 0x12345678, data: Uint8Array.of(97, 98, 99) });
  assert.deepEqual(decodeFileData(unhex('027856341203616263'), 6), { offset: 0x12345678, data: Uint8Array.of(97, 98, 99) });
  const result = decodeFileData(encoded, 20); encoded[10] = 0;
  assert.equal(result.data[0], 97);
});

test('特殊offset原因在数据起点而不是length字节，不当作普通文件数据', () => {
  assert.deepEqual(decodeFileData(unhex('0207000000ffffffff0005'), 20), { sessionId: 7, offset: 0xffffffff, data: new Uint8Array(), endReason: 5 });
  assert.equal(decodeFileData(unhex('02ffffffff0003'), 6).endReason, 3);
  assert.throws(() => decodeFileData(unhex('0207000000ffffffff01'), 20));
  assert.throws(() => decodeFileData(unhex('02ffffffff01'), 6));
});

test('普通数据长度严格匹配，拒绝静默截断、空载荷、错误类型和offset溢出', () => {
  for (const frame of [
    '020700000000000000036162', '020700000000000000016162',
    '02070000000000000000', '0107000000000000000161',
    '0207000000feffffff026162',
  ]) assert.throws(() => decodeFileData(unhex(frame), 20));
  for (let size = 0; size < 10; size++) assert.throws(() => decodeFileData(new Uint8Array(size), 20));
});
