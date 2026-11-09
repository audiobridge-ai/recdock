import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concat, view } from '../protocol/bytes.ts';

export interface Codec { encode(b: Uint8Array): Uint8Array; decode(b: Uint8Array): Uint8Array; dispose(): void }
export const plainCodec = (): Codec => ({ encode: b => b, decode: b => b, dispose() {} });
export class ReplayError extends Error {}
export class EncryptedSession implements Codec {
  private key: Uint8Array; private nonce: Uint8Array; private aad: Uint8Array;
  private tx = 1; private rx = -1; private disposed = false;
  constructor(material: Uint8Array) {
    if (material.length !== 56) throw new Error('会话材料必须为 56 字节');
    this.key = material.slice(0, 32); this.nonce = material.slice(32, 44); this.aad = material.slice(44, 56);
  }
  encode(b: Uint8Array) {
    if (this.disposed || this.tx >= 2147483647) throw new Error('会话已结束，请重新连接');
    const seq = new Uint8Array(4); view(seq).setInt32(0, ++this.tx, true);
    // 按 APK 的线缆格式复现。这里的固定 nonce 仅用于互操作，不是通用加密设计。
    return chacha20poly1305(this.key, this.nonce, this.aad).encrypt(concat(seq, b));
  }
  decode(b: Uint8Array) {
    if (this.disposed) throw new Error('会话已结束');
    const p = chacha20poly1305(this.key, this.nonce, this.aad).decrypt(b);
    if (p.length < 4) throw new Error('加密响应缺少序号');
    const seq = view(p).getInt32(0, true);
    if (seq <= this.rx) throw new ReplayError('重复或过期的设备响应');
    this.rx = seq;
    return p.slice(4);
  }
  dispose() { this.disposed = true; this.key.fill(0); this.nonce.fill(0); this.aad.fill(0); }
}
