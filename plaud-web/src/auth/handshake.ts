import { p256 } from '@noble/curves/nist.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { base64, command, concat, feCommand, hex, le16, text, unhex, utf8 } from '../protocol/bytes.ts';
import { decodeHandshake } from '../protocol/status.ts';
import { tokenSource, validateCredentials } from './credentials.ts';
import type { Credentials } from './credentials.ts';
import { EncryptedSession, plainCodec, ReplayError } from './session.ts';
import type { Codec } from './session.ts';

export interface AuthIO {
  send: (b: Uint8Array) => Promise<void>;
  receive: (predicate?: (b: Uint8Array) => boolean, timeout?: number) => Promise<Uint8Array>;
  stage: (message: string) => void;
  handshake?: (details: ReturnType<typeof decodeHandshake>) => void;
}
export function legacyHandshake(token: string, port: number, second = false, extra8 = '', extraText = '') {
  const size = port >= 9 ? 32 : 16;
  const head = port >= 3 ? [1, 1, 0, 2, 0, second ? 1 : 0] : [1, 1, 0, 2, 0];
  let packet = concat(Uint8Array.from(head), utf8(token.padEnd(size, '0').slice(0, size)));
  if (second && (extra8 || extraText)) {
    const extra = new Uint8Array(8); extra.set(utf8(extra8).slice(0, 8));
    const tail = utf8(extraText);
    if (tail.length > 255) throw new Error('扩展握手字段超过 255 字节');
    packet = concat(packet, extra, Uint8Array.of(tail.length), tail);
  }
  return packet;
}
export const eccTokenHandshake = (token: string) => concat(Uint8Array.of(1, 1, 0, 2, 1, 1), utf8(token.padEnd(32, '0').slice(0, 32)));

async function receiveBusiness(io: AuthIO, codec: Codec, until: number) {
  while (Date.now() < until) {
    const raw = await io.receive(undefined, Math.max(1, until - Date.now()));
    try { const p = codec.decode(raw); if (command(p) !== undefined) return p; }
    catch (e) { if (!(e instanceof ReplayError)) throw new Error('握手响应解密失败，请核对认证材料'); }
  }
  throw new Error('握手响应超时');
}
async function tokenHandshake(io: AuthIO, c: Credentials, codec: Codec) {
  io.stage('正在验证设备 BLE token');
  await io.send(codec.encode(legacyHandshake(tokenSource(c), c.portVersion!)));
  const until = Date.now() + 15000;
  let secondSent = false;
  while (Date.now() < until) {
    const p = await receiveBusiness(io, codec, until);
    if (command(p) === 2 && !secondSent) {
      if (p.length < 4) throw new Error('设备 SN 响应过短');
      const sn = text(p.slice(3, Math.min(59, p.length))).split('\0')[0];
      if (c.serialNumber && sn && sn !== c.serialNumber) throw new Error('设备返回的 SN 与认证配置不一致');
      io.stage('正在进行第二阶段 token 握手'); secondSent = true;
      await io.send(codec.encode(legacyHandshake(tokenSource(c), c.portVersion!, true, c.secondHandshake.extra8, c.secondHandshake.extraText)));
    } else if (command(p) === 1) {
      const ack = decodeHandshake(p);
      if (ack.status !== 0) throw new Error(`设备拒绝认证，状态码 ${ack.status}`);
      if (ack.portVersion !== undefined && ack.portVersion !== c.portVersion) throw new Error(`设备报告 portVersion=${ack.portVersion}，请修改配置后重连`);
      io.handshake?.(ack);
      return;
    }
  }
  throw new Error('未收到设备认证确认');
}

export function fragments(cmd: number, bytes: Uint8Array) {
  const total = Math.ceil(bytes.length / 100);
  if (!total || total > 255) throw new Error('握手材料长度无效');
  return Array.from({ length: total }, (_, i) => concat(le16(cmd), Uint8Array.of(total, i), bytes.slice(i * 100, (i + 1) * 100)));
}
async function rsaSession(io: AuthIO, c: Credentials): Promise<Codec> {
  io.stage('正在发送设备 SN 签名');
  const signature = fragments(c.rsa.alternateCommand ? 0xfe20 : 0xfe10, base64(c.rsa.snSignature));
  for (const p of signature) await io.send(p);
  io.stage(`SN 签名已写入（${signature.length} 片），等待 FE11 确认或 FE12 会话材料`);
  let first: Uint8Array | undefined;
  try {
    // APK js2 / ar2：FE11 要求上传公钥；设备也可复用已登记公钥，直接返回 FE12。
    first = await io.receive(b => [0xfe11, 0xfe12, 0xfe30].includes(feCommand(b) ?? -1), 15000);
  } catch (e) {
    if (e instanceof Error && e.message === '设备响应超时') {
      throw new Error('SN 签名已写入，但等待 FE11 确认或 FE12 会话材料超时；请核对所选设备与签名 SN，并导出日志');
    }
    throw e;
  }
  if (feCommand(first) === 0xfe30) throw new Error('设备返回了 ECC 挑战（FE30），与当前 portVersion=20 不一致；请核对协议版本和所选设备');
  if (feCommand(first) === 0xfe11) {
    io.stage('收到 FE11 确认，正在上传 RSA 公钥');
    for (const p of fragments(0xfe12, utf8(c.rsa.publicKeyPem))) await io.send(p);
    first = undefined;
    io.stage('RSA 公钥已写入，正在接收设备会话材料');
  } else io.stage('设备直接返回 FE12，正在验证复用公钥的 RSA 会话材料');
  const parts = new Map<number, Uint8Array>();
  let total = 0; const until = Date.now() + 20000;
  do {
    const p: Uint8Array = first ?? await io.receive(b => feCommand(b) === 0xfe12, Math.max(1, until - Date.now()));
    first = undefined;
    if (p.length < 5 || !p[2] || p[3] >= p[2] || (total && total !== p[2])) throw new Error('RSA 响应分片无效');
    total = p[2];
    if (parts.has(p[3]) && hex(parts.get(p[3])!) !== hex(p.slice(4))) throw new Error('RSA 响应包含冲突分片');
    parts.set(p[3], p.slice(4));
  } while (parts.size !== total);
  const cipher = concat(...Array.from({ length: total }, (_, i) => parts.get(i)!));
  let material: Uint8Array;
  try {
    const forge = (await import('node-forge')).default;
    const key = forge.pki.privateKeyFromPem(c.rsa.privateKeyPem);
    const output = key.decrypt(String.fromCharCode(...cipher), 'RSAES-PKCS1-V1_5');
    material = Uint8Array.from(output, x => x.charCodeAt(0));
    if (material.length < 80) throw new Error();
    const marker = chacha20poly1305(material.slice(0, 32), material.slice(32, 44), material.slice(44, 56)).decrypt(material.slice(56));
    if (text(marker) !== 'PLAUD.AI') throw new Error();
  } catch { throw new Error('RSA 会话校验失败，请核对 SN 签名及用户密钥'); }
  const codec = new EncryptedSession(material.slice(0, 56)); material.fill(0); return codec;
}

async function eccSession(io: AuthIO, c: Credentials): Promise<Codec> {
  io.stage('正在等待设备 ECC 挑战');
  const p = await io.receive(b => feCommand(b) === 0xfe30, 15000);
  if (p.length < 148) throw new Error('ECC 挑战长度无效');
  if (p[2] !== 2) throw new Error(`设备要求 ECC 绑定流程（mode=${p[2]}），需实时云验证／签名。首版仅支持已绑定设备的本地重连。`);
  const nonceDev = p.slice(3, 19), sig = p.slice(19, 83), ephDev = p.slice(83, 148);
  const deviceKey = unhex(c.ecc.devicePublicKeyHex, 65), privateKey = unhex(c.ecc.userPrivateKeyHex, 32);
  let ephemeral: Uint8Array | undefined;
  try {
    if (!p256.verify(sig, concat(nonceDev, utf8(c.serialNumber), ephDev), deviceKey, { prehash: true, lowS: false })) throw new Error('设备签名校验失败');
    const nonceApp = crypto.getRandomValues(new Uint8Array(16));
    ephemeral = p256.utils.randomSecretKey();
    const ephApp = p256.getPublicKey(ephemeral, false);
    const signature = p256.sign(concat(nonceDev, nonceApp, utf8(c.serialNumber), ephDev, ephApp), privateKey, { prehash: true, lowS: false });
    io.stage('正在进行 ECC 双向认证');
    await io.send(concat(le16(0xfe31), nonceApp, signature, ephApp));
    const ack = await io.receive(b => feCommand(b) === 0xfe34, 15000);
    if (ack.length < 3 || ack[2] !== 0) throw new Error('设备拒绝 ECC 认证');
    const secret = p256.getSharedSecret(ephemeral, ephDev, false).slice(1, 33);
    try {
      const key = await crypto.subtle.importKey('raw', new Uint8Array(secret), 'HKDF', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: concat(nonceDev, nonceApp) as Uint8Array<ArrayBuffer>, info: utf8('plaud-v2:ble-session') as Uint8Array<ArrayBuffer> }, key, 448);
      return new EncryptedSession(new Uint8Array(bits));
    } finally { secret.fill(0); }
  } finally { privateKey.fill(0); ephemeral?.fill(0); }
}
export async function authenticate(io: AuthIO, c: Credentials): Promise<Codec> {
  validateCredentials(c);
  let codec: Codec | undefined;
  try {
    codec = c.portVersion === 20 ? await rsaSession(io, c) : c.portVersion === 30 ? await eccSession(io, c) : plainCodec();
    if (c.portVersion === 30) {
      io.stage('正在验证加密 BLE token');
      await io.send(codec.encode(eccTokenHandshake(tokenSource(c))));
      // SDK 在此乐观完成；工作台随后要求实际 GetState 响应，才进入“可读取”。
    } else await tokenHandshake(io, c, codec);
    return codec;
  } catch (e) { codec?.dispose(); throw e; }
}
