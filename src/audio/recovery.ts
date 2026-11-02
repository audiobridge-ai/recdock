import { playableRecording } from './ogg.ts';
import type { PlayableRecording, RecordingAudioMetadata } from './ogg.ts';
import { decryptPlaudRecording, parsePlaudHeader } from './plaud.ts';

/** Restore the file encryption layer independently of the BLE transport encryption. */
export async function recoverRecording(bytes: Uint8Array, meta: RecordingAudioMetadata & { privateKeyPem?: string; privateKeyHistory?: readonly string[] }): Promise<PlayableRecording> {
  let plaintext: Uint8Array | undefined;
  try {
    const header = parsePlaudHeader(bytes);
    if (!header) return playableRecording(bytes, meta);
    header.nonce.fill(0); header.keyCipher.fill(0);
    const keys = [...new Set([meta.privateKeyPem, ...(meta.privateKeyHistory ?? [])].filter((key): key is string => !!key?.trim()))];
    let decoded: Awaited<ReturnType<typeof decryptPlaudRecording>> | undefined;
    // Retain older account keys when a later official initialization rotates the pair.
    for (const key of keys) {
      try { decoded = await decryptPlaudRecording(bytes, key); break; } catch { /* Try the next retained account key. */ }
    }
    if (!decoded) throw new Error('RSA material unavailable');
    plaintext = decoded.data;
    const result = playableRecording(plaintext, { channels: decoded.channels, isOggAudio: decoded.isOggAudio, sessionId: meta.sessionId });
    if (result.format === 'raw') {
      return { data: bytes, filename: `plaud-${meta.sessionId}.bin`, mimeType: 'application/octet-stream', format: 'raw', notice: `已识别PLAUD文件加密，但解密后的音频暂不支持播放，已保留原始加密文件。${result.notice ?? ''}` };
    }
    if (result.data === plaintext) plaintext = undefined;
    return { ...result, notice: decoded.notice };
  } catch {
    // Keep the original encrypted recording recoverable with its original account key.
    return { data: bytes, filename: `plaud-${meta.sessionId}.bin`, mimeType: 'application/octet-stream', format: 'raw', notice: '此文件包含PLAUD私有音频封装，当前材料未能完成解密。请使用录制时对应账号的RSA材料，在“恢复已下载文件”中重试；原始文件已保留。' };
  } finally { plaintext?.fill(0); }
}
