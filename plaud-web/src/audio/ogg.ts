import { concat, utf8, view } from '../protocol/bytes.ts';

export type PlayableRecording = {
  data: Uint8Array;
  filename: string;
  mimeType: string;
  format: 'ogg' | 'wav' | 'raw';
  notice?: string;
};
export type RecordingAudioMetadata = { channels?: number; isOggAudio?: boolean; sessionId: number };

// RFC 3533 §6：不反射的Ogg CRC，初值0，校验字段计算时视作0。
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0);
  return crc >>> 0;
});
function pageCrc(page: Uint8Array): number {
  let crc = 0;
  for (let offset = 0; offset < page.length; offset++) {
    const byte = offset >= 22 && offset < 26 ? 0 : page[offset];
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 255]) >>> 0;
  }
  return crc;
}
const hasOggMagic = (bytes: Uint8Array): boolean => bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;

function validOgg(bytes: Uint8Array): boolean {
  const streams = new Map<number, { sequence: number; continued: boolean; ended: boolean }>();
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 27) return false;
    const header = bytes.subarray(offset), fields = view(header);
    if (!hasOggMagic(header) || header[4] !== 0 || (header[5] & ~7) !== 0) return false;
    const segments = header[26], headerSize = 27 + segments;
    if (header.length < headerSize) return false;
    let payloadSize = 0;
    for (let index = 0; index < segments; index++) payloadSize += header[27 + index];
    const pageSize = headerSize + payloadSize;
    if (header.length < pageSize) return false;
    const page = header.subarray(0, pageSize);
    if (pageCrc(page) !== fields.getUint32(22, true)) return false;
    const serial = fields.getUint32(14, true), sequence = fields.getUint32(18, true), flags = header[5];
    const prior = streams.get(serial);
    if (!prior) {
      if (!(flags & 2) || (flags & 1) || sequence !== 0) return false;
    } else if (prior.ended || (flags & 2) || sequence !== prior.sequence || Boolean(flags & 1) !== prior.continued) return false;
    const continued = segments > 0 ? header[headerSize - 1] === 255 : prior?.continued ?? false;
    if ((flags & 4) && continued) return false;
    streams.set(serial, { sequence: (sequence + 1) >>> 0, continued, ended: Boolean(flags & 4) });
    offset += pageSize;
  }
  return streams.size > 0 && [...streams.values()].every(stream => stream.ended && !stream.continued);
}

// RFC 6716 §3：只校验包结构/TOC时长，不把任意80字节宣称为20ms Opus。
function opusPacketDuration(packet: Uint8Array): number | undefined {
  if (!packet.length || (packet[0] & 4)) return undefined; // 当前只支持经握手确认的单声道。
  const config = packet[0] >>> 3, code = packet[0] & 3;
  const samplesPerFrame = config >= 16 ? 120 << (config & 3) : config >= 12 ? 480 << (config & 1) : [480, 960, 1920, 2880][config & 3];
  let count = code === 0 ? 1 : 2, cursor = 1, end = packet.length;
  function frameLength(): number | undefined {
    if (cursor >= end) return undefined;
    const first = packet[cursor++];
    if (first < 252) return first;
    return cursor < end ? first + 4 * packet[cursor++] : undefined;
  }
  if (code === 0) {
    if (end - cursor > 1275) return undefined;
  } else if (code === 1) {
    if ((end - cursor) % 2 || (end - cursor) / 2 > 1275) return undefined;
  } else if (code === 2) {
    const first = frameLength();
    if (first === undefined || first > 1275 || first > end - cursor || end - cursor - first > 1275) return undefined;
  } else {
    if (packet.length < 2) return undefined;
    const descriptor = packet[cursor++]; count = descriptor & 63;
    if (!count || count > 48) return undefined;
    if (descriptor & 64) {
      let padding = 0, byte: number;
      do {
        if (cursor >= end) return undefined;
        byte = packet[cursor++]; padding += byte === 255 ? 254 : byte;
        if (padding > end - cursor) return undefined;
      } while (byte === 255);
      end -= padding;
    }
    if (descriptor & 128) {
      let declared = 0;
      for (let index = 0; index < count - 1; index++) {
        const length = frameLength();
        if (length === undefined || length > 1275) return undefined;
        declared += length;
      }
      if (declared > end - cursor || end - cursor - declared > 1275) return undefined;
    } else if (cursor > end || (end - cursor) % count || (end - cursor) / count > 1275) return undefined;
  }
  const duration = samplesPerFrame * count;
  return duration <= 5760 ? duration : undefined;
}

function oggPage(packets: Uint8Array[], serial: number, sequence: number, granule: bigint, flags = 0): Uint8Array {
  const lacing: number[] = [];
  for (const packet of packets) {
    let length = packet.length;
    while (length >= 255) { lacing.push(255); length -= 255; }
    lacing.push(length);
  }
  if (lacing.length > 255) throw new Error('Ogg页分片过多');
  const header = new Uint8Array(27 + lacing.length), fields = view(header);
  header.set(utf8('OggS')); header[5] = flags;
  fields.setBigUint64(6, granule, true); fields.setUint32(14, serial, true); fields.setUint32(18, sequence, true);
  header[26] = lacing.length; header.set(lacing, 27);
  const page = concat(header, ...packets);
  view(page).setUint32(22, pageCrc(page), true);
  return page;
}

function wrapMonoOpus(bytes: Uint8Array): Uint8Array {
  const serial = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  const identification = new Uint8Array(19), header = view(identification);
  identification.set(utf8('OpusHead')); identification[8] = 1; identification[9] = 1;
  // 原始录音没有encoder lookahead元数据，pre-skip保留0，不凭空裁掉音频采样。
  header.setUint32(12, 16000, true);
  const vendor = utf8('PLAUD BLE Console'), tags = new Uint8Array(16 + vendor.length);
  tags.set(utf8('OpusTags')); view(tags).setUint32(8, vendor.length, true); tags.set(vendor, 12);
  const pages = [oggPage([identification], serial, 0, 0n, 2), oggPage([tags], serial, 1, 0n)];
  let sequence = 2, completed = 0;
  // 每页最多1秒，保留80字节Opus包边界；granule固定以48kHz计数。
  for (let offset = 0; offset < bytes.length;) {
    const packets: Uint8Array[] = [];
    for (let index = 0; index < 50 && offset < bytes.length; index++, offset += 80) packets.push(bytes.subarray(offset, offset + 80));
    completed += packets.length;
    pages.push(oggPage(packets, serial, sequence++, BigInt(completed) * 960n, offset === bytes.length ? 4 : 0));
  }
  const output = new Uint8Array(pages.reduce((total, page) => total + page.length, 0));
  let cursor = 0;
  for (const page of pages) { output.set(page, cursor); cursor += page.length; }
  return output;
}

export function playableRecording(bytes: Uint8Array, meta: RecordingAudioMetadata): PlayableRecording {
  if (!Number.isInteger(meta.sessionId) || meta.sessionId < 0 || meta.sessionId > 0xffffffff) throw new Error('录音ID无效');
  const name = `plaud-${meta.sessionId}`;
  const raw = (notice: string): PlayableRecording => ({ data: bytes, filename: `${name}.bin`, mimeType: 'application/octet-stream', format: 'raw', notice });
  if (hasOggMagic(bytes)) {
    return validOgg(bytes) ? { data: bytes, filename: `${name}.ogg`, mimeType: 'audio/ogg', format: 'ogg' } : raw('Ogg容器不完整或校验失败，已保留原始文件。');
  }
  if (meta.isOggAudio !== false) return raw('尚未确认原始音频格式，已保留原始文件。');
  if (meta.channels !== 1) return raw('当前仅支持将已确认的单声道原始Opus封装播放，已保留原始文件。');
  if (!bytes.length || bytes.length % 80) return raw('原始音频长度不符合完整Opus帧边界，已保留原始文件。');
  for (let offset = 0; offset < bytes.length; offset += 80) {
    if (opusPacketDuration(bytes.subarray(offset, offset + 80)) !== 960) return raw('原始音频帧格式或时长无法确认，已保留原始文件。');
  }
  return { data: wrapMonoOpus(bytes), filename: `${name}.ogg`, mimeType: 'audio/ogg', format: 'ogg' };
}
