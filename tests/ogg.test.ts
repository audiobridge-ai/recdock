import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { concat, utf8, view } from '../src/protocol/bytes.ts';
import { playableRecording } from '../src/audio/ogg.ts';

const metadata = { sessionId: 0x12345678, channels: 1, isOggAudio: false };
function rawPackets(count = 1, toc = 0x48): Uint8Array {
  const data = new Uint8Array(80 * count).fill(1);
  for (let offset = 0; offset < data.length; offset += 80) data[offset] = toc;
  return data;
}

// 与生产查表算法独立的逐bit CRC oracle，Ogg使用初值0且不反射。
function crc(bytes: Uint8Array): number {
  let result = 0;
  for (const byte of bytes) {
    result ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) result = result & 0x80000000 ? (result << 1) ^ 0x04c11db7 : result << 1;
  }
  return result >>> 0;
}
function pages(bytes: Uint8Array) {
  const result: Array<{ bytes: Uint8Array; payload: Uint8Array; lacing: number[] }> = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.equal(new TextDecoder().decode(bytes.subarray(offset, offset + 4)), 'OggS');
    const headerLength = 27 + bytes[offset + 26], lacing = Array.from(bytes.subarray(offset + 27, offset + headerLength));
    const length = headerLength + lacing.reduce((sum, value) => sum + value, 0);
    assert.ok(offset + length <= bytes.length);
    const page = bytes.slice(offset, offset + length), expected = view(page).getUint32(22, true);
    page.fill(0, 22, 26); assert.equal(crc(page), expected);
    result.push({ bytes: bytes.slice(offset, offset + length), payload: bytes.slice(offset + headerLength, offset + length), lacing });
    offset += length;
  }
  return result;
}
function repack(page: Uint8Array): Uint8Array {
  const output = page.slice(); output.fill(0, 22, 26); view(output).setUint32(22, crc(output), true); return output;
}

test('Ogg页有独立CRC校验、OpusHead/Tags、完整包边界和48kHz granule', () => {
  assert.equal(crc(utf8('123456789')), 0x89a1897f);
  const original = rawPackets(51), result = playableRecording(original, metadata);
  assert.equal(result.format, 'ogg'); assert.equal(result.mimeType, 'audio/ogg'); assert.equal(result.filename, 'plaud-305419896.ogg');
  const all = pages(result.data);
  assert.equal(all.length, 4);
  assert.deepEqual(all.map(page => view(page.bytes).getUint32(18, true)), [0, 1, 2, 3]);
  assert.deepEqual(all.map(page => page.bytes[5]), [2, 0, 0, 4]);
  assert.deepEqual(all.map(page => view(page.bytes).getBigUint64(6, true)), [0n, 0n, 48000n, 48960n]);
  assert.equal(new TextDecoder().decode(all[0].payload.subarray(0, 8)), 'OpusHead');
  assert.equal(all[0].payload.length, 19); assert.equal(all[0].payload[8], 1); assert.equal(all[0].payload[9], 1);
  assert.equal(view(all[0].payload).getUint16(10, true), 0); assert.equal(view(all[0].payload).getUint32(12, true), 16000);
  assert.equal(all[0].payload[18], 0);
  assert.equal(new TextDecoder().decode(all[1].payload.subarray(0, 8)), 'OpusTags');
  assert.equal(view(all[1].payload).getUint32(all[1].payload.length - 4, true), 0);
  assert.deepEqual(all[2].lacing, Array(50).fill(80)); assert.deepEqual(all[3].lacing, [80]);
  assert.deepEqual(concat(all[2].payload, all[3].payload), original);
});

test('已有完整Ogg原样保存，即使metadata声道未知也不改写', () => {
  const encoded = playableRecording(rawPackets(2), metadata).data;
  const result = playableRecording(encoded, { sessionId: 7 });
  assert.equal(result.format, 'ogg'); assert.equal(result.filename, 'plaud-7.ogg'); assert.equal(result.data, encoded);
});

test('截断、CRC损坏、尾随垃圾、缺EOS或序号跳跃的Ogg保留为原始文件', () => {
  const encoded = playableRecording(rawPackets(2), metadata).data, all = pages(encoded);
  const corrupted = encoded.slice(); corrupted[corrupted.length - 1] ^= 1;
  const noEos = all[2].bytes.slice(); noEos[5] = 0;
  const wrongSequence = all[2].bytes.slice(); view(wrongSequence).setUint32(18, 5, true);
  const reservedFlags = all[2].bytes.slice(); reservedFlags[5] |= 8;
  for (const bytes of [
    utf8('OggS'), encoded.slice(0, -1), corrupted, concat(encoded, Uint8Array.of(1)),
    concat(all[0].bytes, all[1].bytes, repack(noEos)),
    concat(all[0].bytes, all[1].bytes, repack(wrongSequence)),
    concat(all[0].bytes, all[1].bytes, repack(reservedFlags)),
  ]) {
    const result = playableRecording(bytes, metadata);
    assert.equal(result.format, 'raw'); assert.match(result.notice!, /Ogg/); assert.equal(result.data, bytes);
  }
});

test('空EOS页不能掩盖前页未结束的255字节续包', () => {
  const all = pages(playableRecording(rawPackets(), metadata).data);
  const partial = new Uint8Array(28 + 255), emptyEos = new Uint8Array(27);
  const serial = view(all[0].bytes).getUint32(14, true);
  partial.set(utf8('OggS')); view(partial).setUint32(14, serial, true); view(partial).setUint32(18, 2, true);
  partial[26] = 1; partial[27] = 255;
  emptyEos.set(utf8('OggS')); emptyEos[5] = 5;
  view(emptyEos).setUint32(14, serial, true); view(emptyEos).setUint32(18, 3, true);
  const bytes = concat(all[0].bytes, all[1].bytes, repack(partial), repack(emptyEos));
  assert.equal(playableRecording(bytes, metadata).format, 'raw');
});

test('格式、通道、帧边界不明确时返回.bin，不伪造多声道或WAV', () => {
  for (const meta of [
    { sessionId: 1 }, { sessionId: 1, channels: 1 },
    { sessionId: 1, channels: 1, isOggAudio: true },
    { sessionId: 1, channels: 2, isOggAudio: false },
    { sessionId: 1, channels: 4, isOggAudio: false },
    { sessionId: 1, channels: 0, isOggAudio: false },
  ]) {
    const result = playableRecording(rawPackets(2), meta);
    assert.equal(result.format, 'raw'); assert.equal(result.filename, 'plaud-1.bin'); assert.equal(result.mimeType, 'application/octet-stream');
    assert.ok(result.notice);
  }
  for (const bytes of [new Uint8Array(), rawPackets().slice(0, -1), concat(rawPackets(), Uint8Array.of(0))]) assert.equal(playableRecording(bytes, metadata).format, 'raw');
  assert.throws(() => playableRecording(rawPackets(), { ...metadata, sessionId: -1 }));
});

test('RFC6716 TOC时长与帧结构必须匹配20ms，不能只凭80字节长度包装', () => {
  // 单帧10/40/60ms、双声道标志、code1奇数CBR载荷、坏code2长度、code3零帧/过长均拒绝。
  for (const toc of [0x40, 0x50, 0x58, 0x4c, 0x49, 0x4a, 0x4b]) {
    const bytes = rawPackets(1, toc);
    if (toc === 0x4a) bytes[1] = 255;
    if (toc === 0x4b) bytes[1] = 0;
    assert.equal(playableRecording(bytes, metadata).format, 'raw', `TOC ${toc}`);
  }
  // 两个10ms VBR帧总时长20ms：code2首帧长30，其余47字节为第二帧。
  const code2 = rawPackets(1, 0x42); code2[1] = 30;
  assert.equal(playableRecording(code2, metadata).format, 'ogg');
  // 四个5ms CBR帧，3字节包头及1字节尾填充，每帧19字节。
  const code3 = rawPackets(1, 0x8b); code3[1] = 0x44; code3[2] = 1;
  assert.equal(playableRecording(code3, metadata).format, 'ogg');
  const vbrCode3 = rawPackets(1, 0x43); vbrCode3[1] = 0x82; vbrCode3[2] = 30;
  assert.equal(playableRecording(vbrCode3, metadata).format, 'ogg');
  const damagedLater = rawPackets(2); damagedLater[80] = 0x50;
  assert.equal(playableRecording(damagedLater, metadata).format, 'raw');
});

const ffmpegVersion = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
test('独立FFmpeg编码的80字节Opus帧封装后可被原生解码器播放', { skip: ffmpegVersion.error || ffmpegVersion.status !== 0 ? '本机没有FFmpeg，已执行独立CRC/容器测试' : false }, () => {
  const pcm = Buffer.alloc(16000 / 5 * 2);
  for (let sample = 0; sample < pcm.length / 2; sample++) pcm.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 440 / 16000) * 1000), sample * 2);
  const native = spawnSync('ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'off', '-frame_duration', '20', '-f', 'opus', 'pipe:1'], { input: pcm, maxBuffer: 1024 * 1024 });
  assert.equal(native.status, 0, native.stderr.toString());
  const packets: Uint8Array[] = [];
  for (const page of pages(native.stdout).slice(2)) {
    let at = 0, packet: Uint8Array[] = [];
    for (const length of page.lacing) {
      packet.push(page.payload.subarray(at, at + length)); at += length;
      if (length < 255) { packets.push(concat(...packet)); packet = []; }
    }
    assert.equal(packet.length, 0);
  }
  assert.ok(packets.length > 1); assert.ok(packets.every(packet => packet.length === 80));
  const result = playableRecording(concat(...packets), metadata);
  assert.equal(result.format, 'ogg'); pages(result.data);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'], { input: result.data, maxBuffer: 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  assert.equal(decoded.stdout.length, packets.length * 320 * 2);
});
