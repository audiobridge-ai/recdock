import type { PlayableRecording } from './ogg.ts';

export const MAX_WAV_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_WAV_PCM_BYTES = 256 * 1024 * 1024;

function pcmSize(channelCount: number, frames: number, sampleRate: number): number {
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount * 2 > 0xffff) throw new Error('WAV 声道数无效。');
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate * channelCount * 2 > 0xffffffff) throw new Error('WAV 采样率或字节率无效。');
  const samples = channelCount * frames, dataBytes = samples * 2;
  if (!Number.isSafeInteger(frames) || frames < 0 || !Number.isSafeInteger(dataBytes) ||
    samples * 4 > MAX_WAV_PCM_BYTES || dataBytes > 0xffffffff - 36) {
    throw new Error('解码后的音频超过本机 WAV 转换内存上限，请保存 Ogg。');
  }
  return dataBytes;
}

/** Standard RIFF/WAVE PCM16 little endian, with interleaved channels. */
export function pcm16Wav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const frames = channels[0]?.length ?? 0, dataBytes = pcmSize(channels.length, frames, sampleRate);
  if (channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frames)) throw new Error('WAV 各声道的采样数必须相同。');
  const bytes = new Uint8Array(44 + dataBytes), fields = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index); };
  text(0, 'RIFF'); fields.setUint32(4, 36 + dataBytes, true); text(8, 'WAVE'); text(12, 'fmt ');
  fields.setUint32(16, 16, true); fields.setUint16(20, 1, true); fields.setUint16(22, channels.length, true);
  fields.setUint32(24, sampleRate, true); fields.setUint32(28, sampleRate * channels.length * 2, true);
  fields.setUint16(32, channels.length * 2, true); fields.setUint16(34, 16, true);
  text(36, 'data'); fields.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const sample = Number.isNaN(channel[frame]) ? 0 : Math.max(-1, Math.min(1, channel[frame]));
      fields.setInt16(offset, Math.trunc(sample * (sample < 0 ? 32768 : 32767)), true); offset += 2;
    }
  }
  return bytes;
}

/** Decode only: no source node is created and nothing is connected to speakers. */
export async function toWav(recording: PlayableRecording): Promise<PlayableRecording> {
  if (recording.format === 'wav') return recording;
  if (recording.format !== 'ogg') throw new Error('此文件尚未恢复为 Ogg 音频，无法转换 WAV。');
  if (!recording.data.length || recording.data.length > MAX_WAV_INPUT_BYTES) throw new Error('WAV 转换仅支持不超过 16 MiB 的压缩音频，请保存 Ogg。');
  if (typeof AudioContext === 'undefined') throw new Error('当前浏览器未提供音频解码，请保存 Ogg。');
  const context = new AudioContext({ sampleRate: 16000 });
  try {
    let decoded: AudioBuffer;
    try { decoded = await context.decodeAudioData(new Uint8Array(recording.data).buffer); }
    catch { throw new Error('浏览器无法解码此 Ogg 音频，请保存 Ogg 后用兼容播放器打开。'); }
    pcmSize(decoded.numberOfChannels, decoded.length, decoded.sampleRate);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
    const data = pcm16Wav(channels, decoded.sampleRate);
    return { ...recording, data, filename: `${recording.filename.replace(/\.[^/.\\]+$/, '') || 'plaud-recording'}.wav`, mimeType: 'audio/wav', format: 'wav' };
  } finally {
    await context.close().catch(() => {});
  }
}
