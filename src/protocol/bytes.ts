export const utf8 = (s: string) => new TextEncoder().encode(s);
export const text = (b: Uint8Array) => new TextDecoder().decode(b);
export const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export function unhex(s: string, length?: number): Uint8Array {
  const clean = s.replace(/\s/g, '');
  if (!/^(?:[\da-f]{2})+$/i.test(clean)) throw new Error('十六进制格式无效');
  const b = Uint8Array.from(clean.match(/../g)!, x => parseInt(x, 16));
  if (length !== undefined && b.length !== length) throw new Error(`应提供 ${length} 字节的十六进制数据`);
  return b;
}
export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { b.set(p, offset); offset += p.length; }
  return b;
};
export const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
export const le16 = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255);
export function base64(s: string) {
  try { return Uint8Array.from(atob(s.replace(/\s/g, '')), x => x.charCodeAt(0)); }
  catch { throw new Error('Base64 格式无效'); }
}
export const command = (b: Uint8Array) => b.length >= 3 && b[0] === 1 ? view(b).getUint16(1, true) : undefined;
export const request = (cmd: number) => concat(Uint8Array.of(1), le16(cmd));
export const feCommand = (b: Uint8Array) => b.length >= 2 ? view(b).getUint16(0, true) : undefined;
