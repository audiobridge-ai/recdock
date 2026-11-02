import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { MAX_WAV_INPUT_BYTES, MAX_WAV_PCM_BYTES, pcm16Wav, toWav } from '../src/audio/wav.ts';
import type { PlayableRecording } from '../src/audio/ogg.ts';

const text = (bytes: Uint8Array, start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
const sample = (bytes: Uint8Array, index: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(44 + index * 2, true);
const ogg: PlayableRecording = { data: Uint8Array.of(1, 2, 3), filename: 'plaud-42.ogg', mimeType: 'audio/ogg', format: 'ogg' };

test('PCM16 WAV 使用标准 RIFF/fmt/data 头、正确长度和小端整数', () => {
  const wav = pcm16Wav([Float32Array.of(0, 1, -1, 0.5, -0.5)], 16000), fields = new DataView(wav.buffer);
  assert.equal(wav.length, 54); assert.equal(text(wav, 0, 4), 'RIFF'); assert.equal(fields.getUint32(4, true), 46);
  assert.equal(text(wav, 8, 12), 'WAVE'); assert.equal(text(wav, 12, 16), 'fmt ');
  assert.equal(fields.getUint32(16, true), 16); assert.equal(fields.getUint16(20, true), 1);
  assert.equal(fields.getUint16(22, true), 1); assert.equal(fields.getUint32(24, true), 16000);
  assert.equal(fields.getUint32(28, true), 32000); assert.equal(fields.getUint16(32, true), 2); assert.equal(fields.getUint16(34, true), 16);
  assert.equal(text(wav, 36, 40), 'data'); assert.equal(fields.getUint32(40, true), 10);
  assert.deepEqual(Array.from({ length: 5 }, (_, index) => sample(wav, index)), [0, 32767, -32768, 16383, -16384]);
});

test('多声道按采样帧交织，越界夹紧、NaN 静音且小数截断', () => {
  const wav = pcm16Wav([Float32Array.of(2, Number.NaN, 0.00004), Float32Array.of(-2, Infinity, -0.00004)], 48000);
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => sample(wav, index)), [32767, -32768, 0, 32767, 1, -1]);
  const fields = new DataView(wav.buffer);
  assert.equal(fields.getUint16(22, true), 2); assert.equal(fields.getUint16(32, true), 4); assert.equal(fields.getUint32(28, true), 192000);
});

test('无声道、声道不等长及无法放入 RIFF 字段的采样参数提前拒绝', () => {
  assert.throws(() => pcm16Wav([], 16000), /声道数/);
  assert.throws(() => pcm16Wav([new Float32Array(1), new Float32Array(2)], 16000), /采样数/);
  for (const rate of [0, -1, 1.5, Number.NaN, Infinity, 0xffffffff]) assert.throws(() => pcm16Wav([new Float32Array()], rate), /采样率|字节率/);
  assert.throws(() => pcm16Wav(Array(32768).fill(new Float32Array()), 16000), /声道数/);
  assert.equal(pcm16Wav([new Float32Array()], 16000).length, 44);
});

async function withAudioContext(mock: unknown, run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: mock });
  try { await run(); }
  finally { if (original) Object.defineProperty(globalThis, 'AudioContext', original); else Reflect.deleteProperty(globalThis, 'AudioContext'); }
}

test('toWav 仅在 16kHz AudioContext 解码、生成 WAV 并关闭上下文，不播放', async () => {
  let closed = 0, options: unknown, input: ArrayBuffer | undefined;
  class DecoderOnly {
    constructor(value: unknown) { options = value; }
    async decodeAudioData(value: ArrayBuffer) { input = value; return { numberOfChannels: 1, length: 2, sampleRate: 16000, getChannelData: () => Float32Array.of(0.25, -0.25) }; }
    async close() { closed++; }
  }
  await withAudioContext(DecoderOnly, async () => {
    const wav = await toWav(ogg);
    assert.deepEqual(options, { sampleRate: 16000 }); assert.deepEqual(new Uint8Array(input!), ogg.data);
    assert.notEqual(input, ogg.data.buffer); assert.equal(closed, 1);
    assert.equal(wav.format, 'wav'); assert.equal(wav.mimeType, 'audio/wav'); assert.equal(wav.filename, 'plaud-42.wav');
    assert.equal(text(wav.data, 0, 4), 'RIFF'); assert.equal(sample(wav.data, 0), 8191); assert.equal(sample(wav.data, 1), -8192);
    assert.deepEqual(ogg.data, Uint8Array.of(1, 2, 3));
  });
});

test('toWav 拒绝超限输入和原始数据，解码失败或超限 PCM 仍关闭上下文', async () => {
  let created = 0, closed = 0;
  class FailingDecoder {
    constructor() { created++; }
    async decodeAudioData() { throw new Error('decoder error'); }
    async close() { closed++; }
  }
  await withAudioContext(FailingDecoder, async () => {
    const existing = { ...ogg, format: 'wav' as const };
    assert.equal(await toWav(existing), existing);
    await assert.rejects(toWav({ ...ogg, data: new Uint8Array(MAX_WAV_INPUT_BYTES + 1) }), /16 MiB/);
    await assert.rejects(toWav({ ...ogg, format: 'raw' }), /尚未恢复/); assert.equal(created, 0);
    await assert.rejects(toWav(ogg), /无法解码/); assert.equal(closed, 1);
  });
  class HugeDecoder {
    async decodeAudioData() { return { numberOfChannels: 1, length: MAX_WAV_PCM_BYTES / 4 + 1, sampleRate: 16000, getChannelData: () => { throw new Error('不应获取超限 PCM'); } }; }
    async close() { closed++; }
  }
  await withAudioContext(HugeDecoder, async () => { await assert.rejects(toWav(ogg), /内存上限/); });
  assert.equal(closed, 2);
});

const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
test('FFmpeg 合成音经 PCM16 WAV 封装后可由独立解码器读取', { skip: ffmpeg.error || ffmpeg.status !== 0 ? '本机未安装 FFmpeg' : false }, () => {
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=0.1', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr.toString());
  const floats = new Float32Array(new Uint8Array(generated.stdout).buffer), wav = pcm16Wav([floats], 16000);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], { input: wav, maxBuffer: 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr.toString()); assert.equal(decoded.stdout.length, 3200);
  assert.deepEqual(new Uint8Array(decoded.stdout), wav.subarray(44));
});
