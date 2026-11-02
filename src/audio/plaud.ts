import { chacha20 } from '@noble/ciphers/chacha.js';
import { view } from '../protocol/bytes.ts';

export interface PlaudHeader {
  version: number;
  headerSize: number;
  fileType: number;
  channels: number;
  encryptType: number;
  durationMs: number;
  segmentSize: number;
  counter: number;
  nonce: Uint8Array;
  keyCipher: Uint8Array;
}

const MAGIC = Uint8Array.of(0x50, 0x4c, 0x41, 0x55, 0x44, 0x2e, 0x41, 0x49);
const HEADER_SIZE = 512;
class PlaudAudioError extends Error {}

export function parsePlaudHeader(bytes: Uint8Array): PlaudHeader | undefined {
  if (bytes.length < MAGIC.length || !MAGIC.every((value, index) => bytes[index] === value)) return undefined;
  if (bytes.length < HEADER_SIZE) throw new PlaudAudioError('PLAUD录音文件头不完整，需要512字节。');
  const fields = view(bytes), version = fields.getUint16(8, true), headerSize = fields.getUint16(10, true);
  if (version !== 1) throw new PlaudAudioError('当前尚不支持此PLAUD录音文件版本。');
  if (headerSize !== HEADER_SIZE) throw new PlaudAudioError('PLAUD录音文件头长度不受支持。');
  if (bytes.length === HEADER_SIZE) throw new PlaudAudioError('PLAUD录音文件没有音频正文。');
  const channels = fields.getUint16(50, true);
  if (!channels) throw new PlaudAudioError('PLAUD录音文件头的声道数无效。');
  // qkn.a.h：不复制userId；头内CRC算法尚未确认，此处不声称校验该字段。
  return {
    version, headerSize, fileType: fields.getUint16(48, true), channels,
    encryptType: fields.getUint16(52, true), durationMs: fields.getUint32(54, true) * 1000,
    counter: fields.getUint32(128, true), nonce: Uint8Array.from(bytes.subarray(132, 144)),
    segmentSize: fields.getUint32(144, true), keyCipher: Uint8Array.from(bytes.subarray(256, 512)),
  };
}

async function rsaContentKey(privateKeyPem: string, keyCipher: Uint8Array): Promise<Uint8Array> {
  let decoded: Uint8Array | undefined;
  try {
    // 与BLE握手一样在本地使用forge；私钥不发送到服务端、不写入持久存储。
    const forge = (await import('node-forge')).default;
    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
    let plaintext = privateKey.decrypt(String.fromCharCode(...keyCipher), 'RSAES-PKCS1-V1_5');
    decoded = Uint8Array.from(plaintext, character => character.charCodeAt(0));
    plaintext = '';
    if (decoded.length !== 32) throw new PlaudAudioError('PLAUD录音内容密钥长度无效。');
    const key = decoded; decoded = undefined;
    return key;
  } catch {
    // 不保留库异常、cause或材料片段，避免密钥解析错误进入UI/日志。
    throw new PlaudAudioError('无法解开录音内容密钥，请确认使用录制时对应账号的RSA私钥。');
  } finally { decoded?.fill(0); }
}

function firmwareKeyPattern(keyCipher: Uint8Array): boolean {
  // qkn.a.m / qkn.a.k：只兼容App明确识别的固件异常模式，不能泛化为任意RSA失败。
  return keyCipher.length >= 224 && keyCipher[0] === 0 && keyCipher[1] === 2 && keyCipher[223] === 0;
}

export async function decryptPlaudRecording(bytes: Uint8Array, privateKeyPem?: string): Promise<{
  data: Uint8Array; channels: number; isOggAudio: boolean; fileType: number; notice?: string;
}> {
  const header = parsePlaudHeader(bytes);
  if (!header) throw new PlaudAudioError('该文件不包含受支持的PLAUD录音文件头。');
  let key: Uint8Array | undefined, output: Uint8Array | undefined;
  let notice: string | undefined;
  try {
    if (header.encryptType !== 1) throw new PlaudAudioError('当前尚不支持此PLAUD录音文件加密类型。');
    if (privateKeyPem?.trim()) {
      try { key = await rsaContentKey(privateKeyPem, header.keyCipher); }
      catch (error) { if (!firmwareKeyPattern(header.keyCipher)) throw error; }
    }
    if (!key) {
      if (!firmwareKeyPattern(header.keyCipher)) throw new PlaudAudioError('缺少此录音文件对应账号的RSA私钥，无法解密音频正文。');
      key = header.keyCipher.slice(-32);
      notice = '已使用官方客户端针对特定固件格式的兼容解密方式。';
    }
    const body = bytes.subarray(HEADER_SIZE);
    output = new Uint8Array(body.length);
    // qkn.a.n → j38.a：头内counter被解析但未用于此文件解密路径。
    // 分段模式每段从counter=0重启；非分段模式是一条从counter=0开始的连续流。
    if (header.segmentSize > 0) {
      for (let offset = 0; offset < body.length; offset += header.segmentSize) {
        const end = Math.min(offset + header.segmentSize, body.length);
        chacha20(key, header.nonce, body.subarray(offset, end), output.subarray(offset, end), 0);
      }
    } else chacha20(key, header.nonce, body, output, 0);
    const data = output; output = undefined;
    return { data, channels: header.channels, isOggAudio: header.fileType === 1, fileType: header.fileType, ...(notice ? { notice } : {}) };
  } catch (error) {
    if (error instanceof PlaudAudioError) throw error;
    throw new PlaudAudioError('PLAUD录音文件解密失败，请保留原始文件后重试。');
  } finally {
    key?.fill(0); output?.fill(0); header.nonce.fill(0); header.keyCipher.fill(0);
  }
}
