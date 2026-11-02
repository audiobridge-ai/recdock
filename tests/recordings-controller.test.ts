import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createCipheriv, generateKeyPairSync, publicEncrypt } from 'node:crypto';
import { PlaudController } from '../src/app/controller.ts';
import { emptyCredentials } from '../src/auth/credentials.ts';
import type { BleLink } from '../src/ble/transport.ts';
import { command, concat, feCommand, le16, request, unhex, utf8, view } from '../src/protocol/bytes.ts';
import { EncryptedSession } from '../src/auth/session.ts';

const u32 = (n: number) => { const b = new Uint8Array(4); view(b).setUint32(0, n, true); return b; };
const SID = 1234, audio = Uint8Array.of(1, 2, 3, 4);
const credentials = (sn = '888FIXTURE') => ({ ...emptyCredentials(), accountId: 'fixture-owner', portVersion: 9, serialNumber: sn });
class FileDevice implements BleLink {
  connected = false; recording = false; hold = false; stopAck = true;
  frame: (packet: Uint8Array) => void = () => {};
  lost: () => void = () => {};
  writes: Uint8Array[] = []; starts: number[] = [];
  async connect(frame: (packet: Uint8Array) => void, lost: () => void) { this.frame = frame; this.lost = lost; this.connected = true; }
  status() { return concat(request(3), u32(this.recording ? 4099 : 0), Uint8Array.of(0, this.recording ? 1 : 0, 0, 1), u32(this.recording ? 9999 : 0)); }
  async write(packet: Uint8Array) {
    this.writes.push(packet.slice());
    const cmd = command(packet);
    if (cmd === 1) this.frame(unhex('010100000900'));
    if (cmd === 3) this.frame(this.status());
    if (cmd === 9) this.frame(unhex('0109000150'));
    if (cmd === 6) this.frame(unhex('01060000100000000000000020000000000000'));
    if (cmd === 26) {
      this.frame(concat(request(26), packet.slice(3, 7), le16(1), le16(0), u32(SID), u32(audio.length), Uint8Array.of(1, 0)));
    }
    if (cmd === 28) {
      const offset = view(packet).getUint32(7, true); this.starts.push(offset);
      this.frame(concat(request(28), u32(SID), Uint8Array.of(0)));
      const end = this.hold ? Math.max(offset, 2) : audio.length;
      if (end > offset) this.frame(concat(Uint8Array.of(2), u32(SID), u32(offset), Uint8Array.of(end - offset), audio.slice(offset, end)));
      if (!this.hold) this.frame(concat(request(29), u32(SID), le16(0)));
    }
    if (cmd === 29 && this.stopAck) this.frame(request(30));
  }
  startRecording() { this.recording = true; this.frame(concat(request(20), u32(9999), u32(0), Uint8Array.of(0, 1))); }
  stopRecording() { this.recording = false; this.frame(concat(request(23), u32(9999), Uint8Array.of(0, 1), u32(80))); }
  disconnect() { this.connected = false; this.lost(); }
  async battery() { return 80; }
  close() { this.connected = false; }
}
async function fixture() {
  const device = new FileDevice(), logs: string[] = [];
  const controller = new PlaudController(() => {}, message => logs.push(message), 30, { monitorInterval: 0, fileTimeout: 10, stopTimeout: 5 });
  await controller.connect(device, credentials());
  return { device, controller, logs };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('主动录音事件实时更新状态，带ACK的时长推送走现有写通道，停止后忽略旧时长', async () => {
  const { device: d, controller: c } = await fixture();
  d.startRecording(); assert.equal(c.snapshot.recording.mode, 'recording');
  d.frame(concat(request(19), le16(1), le16(7), Uint8Array.of(1, 0, 0, 0), u32(9999), u32(12345)));
  await tick();
  assert.equal(c.snapshot.recording.durationMs, 12345);
  assert.deepEqual(d.writes.find(p => command(p) === 19), unhex('01130001000700'));
  d.stopRecording(); assert.equal(c.snapshot.recording.mode, 'idle');
  d.frame(concat(request(19), le16(1), le16(8), Uint8Array.of(0, 0, 0, 0), u32(9999), u32(13000)));
  assert.equal(c.snapshot.recording.mode, 'idle'); c.disconnect();
});

test('目录与下载通过真实控制器路由，完整数据和文件尾到齐才导出，保持BLE连接', async () => {
  const { device: d, controller: c } = await fixture();
  await c.listFiles();
  assert.deepEqual(c.snapshot.files.data, [{ sessionId: SID, size: 4, scene: 1, attribute: 0 }]);
  const output = await c.download(SID);
  assert.deepEqual(output?.data, audio); assert.equal(output?.format, 'raw');
  assert.match(output?.notice ?? '', /原始|格式|确认/);
  assert.equal(c.snapshot.transfer.phase, 'complete'); assert.equal(c.snapshot.transfer.received, 4);
  assert.equal(c.snapshot.phase, 'ready'); assert.equal(d.connected, true); c.disconnect();
});

test('port20从RSA握手到AEAD目录、type02数据与文件尾完整互通', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }), material = Uint8Array.from({ length: 56 }, (_, i) => i + 1);
  const publicKeyPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const cipher = createCipheriv('chacha20-poly1305', material.slice(0, 32), material.slice(32, 44), { authTagLength: 16 });
  cipher.setAAD(material.slice(44), { plaintextLength: 8 });
  const marker = concat(cipher.update(utf8('PLAUD.AI')), cipher.final(), cipher.getAuthTag());
  const encryptedMaterial = publicEncrypt({ key: rsa.publicKey, padding: constants.RSA_PKCS1_PADDING }, concat(material, marker));
  const peer = new EncryptedSession(material), d = new FileDevice(), publicParts: Uint8Array[] = [];
  let notify: (p: Uint8Array) => void = () => {};
  d.connect = async (frame, lost) => { notify = frame; d.frame = p => notify(peer.encode(p)); d.lost = lost; d.connected = true; };
  const innerWrite = d.write.bind(d);
  d.write = async packet => {
    if (feCommand(packet) === 0xfe10) { if (packet[3] === packet[2] - 1) notify(le16(0xfe11)); return; }
    if (feCommand(packet) === 0xfe12) {
      publicParts.push(packet.slice(4));
      if (packet[3] === packet[2] - 1) {
        assert.equal(new TextDecoder().decode(concat(...publicParts)), publicKeyPem);
        for (let i = 0; i < 3; i++) notify(concat(le16(0xfe12), Uint8Array.of(3, i), encryptedMaterial.slice(i * 100, (i + 1) * 100)));
      }
      return;
    }
    const plain = peer.decode(packet);
    if (command(plain) === 1) { d.frame(unhex('010100001400000001000000')); return; }
    await innerWrite(plain);
  };
  const c = new PlaudController(() => {}, () => {}, 30, { monitorInterval: 0, fileTimeout: 10, stopTimeout: 5 });
  await c.connect(d, { ...credentials(), portVersion: 20, rsa: { snSignature: 'AQID', publicKeyPem, privateKeyPem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), alternateCommand: false } });
  assert.equal(c.snapshot.phase, 'ready');
  await c.listFiles(); assert.equal(c.snapshot.files.data?.[0].sessionId, SID);
  const output = await c.download(SID);
  assert.deepEqual(output?.data, audio); assert.equal(c.snapshot.transfer.phase, 'complete');
  c.disconnect(); peer.dispose();
});

test('文件自身PLAUD.AI加密层也会用连接账号的RSA解密，不把完整传输误当可播放格式', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }), key = Buffer.alloc(32, 7), nonce = Buffer.alloc(12, 9);
  const raw = new Uint8Array(80).fill(1); raw[0] = 0xb8;
  const cipher = createCipheriv('chacha20', key, concat(new Uint8Array(4), nonce));
  const header = new Uint8Array(512), h = view(header);
  header.set(utf8('PLAUD.AI')); h.setUint16(8, 1, true); h.setUint16(10, 512, true);
  h.setUint16(48, 5, true); h.setUint16(50, 1, true); h.setUint16(52, 1, true); h.setUint32(144, 80, true);
  header.set(nonce, 132); header.set(publicEncrypt({ key: rsa.publicKey, padding: constants.RSA_PKCS1_PADDING }, key), 256);
  const encryptedFile = concat(header, cipher.update(raw), cipher.final()), d = new FileDevice();
  const original = d.write.bind(d);
  d.write = async packet => {
    const cmd = command(packet);
    if (cmd === 26) d.frame(concat(request(26), packet.slice(3, 7), le16(1), le16(0), u32(SID), u32(encryptedFile.length), Uint8Array.of(1, 0)));
    else if (cmd === 28) {
      d.frame(concat(request(28), u32(SID), Uint8Array.of(0)));
      for (let offset = 0; offset < encryptedFile.length; offset += 100) {
        const bytes = encryptedFile.slice(offset, offset + 100);
        d.frame(concat(Uint8Array.of(2), u32(SID), u32(offset), Uint8Array.of(bytes.length), bytes));
      }
      d.frame(concat(request(29), u32(SID), le16(0)));
    } else await original(packet);
  };
  const c = new PlaudController(() => {}, () => {}, 30, { monitorInterval: 0, fileTimeout: 10, stopTimeout: 5 });
  const auth = credentials(); auth.rsa.privateKeyPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await c.connect(d, auth); await c.listFiles();
  const output = await c.download(SID);
  assert.equal(output?.format, 'ogg'); assert.equal(new TextDecoder().decode(output?.data.subarray(0, 4)), 'OggS');
  assert.deepEqual(output?.data.subarray(-80), raw); assert.equal(c.snapshot.transfer.total, encryptedFile.length);
  assert.equal(c.snapshot.transfer.phase, 'complete'); c.disconnect();
});

test('正在录音时目录和下载会先查状态并阻止文件命令', async () => {
  const { device: d, controller: c } = await fixture();
  await c.listFiles(); const count = d.writes.filter(p => [26, 28].includes(command(p)!)).length;
  d.startRecording();
  await c.listFiles(); assert.match(c.snapshot.files.error!, /正在录音或暂停/);
  assert.equal(await c.download(SID), undefined); assert.match(c.snapshot.transfer.error!, /正在录音或暂停/);
  assert.equal(d.writes.filter(p => [26, 28].includes(command(p)!)).length, count); c.disconnect();
});

test('取消先发送停止并等ACK，不返回不完整文件；再次点击同文件从连续位置续传', async () => {
  const { device: d, controller: c } = await fixture(); await c.listFiles(); d.hold = true;
  const pending = c.download(SID); await tick(); assert.equal(c.snapshot.transfer.received, 2);
  c.cancelDownload(); assert.equal(await pending, undefined);
  assert.equal(c.snapshot.transfer.phase, 'cancelled'); assert.equal(c.snapshot.transfer.received, 2);
  assert.equal(command(d.writes.at(-1)!), 29); assert.equal(d.connected, true);
  d.hold = false; const output = await c.download(SID);
  assert.deepEqual(output?.data, audio); assert.deepEqual(d.starts, [0, 2]); c.disconnect();
});

test('设备开始录音会暂停传输并停止同步，录音状态保持有效', async () => {
  const { device: d, controller: c } = await fixture(); await c.listFiles(); d.hold = true;
  const pending = c.download(SID); await tick(); d.startRecording();
  assert.equal(await pending, undefined);
  assert.equal(c.snapshot.recording.mode, 'recording'); assert.equal(c.snapshot.transfer.phase, 'paused');
  assert.match(c.snapshot.transfer.notice!, /开始录音/); assert.equal(command(d.writes.at(-1)!), 29); c.disconnect();
});

test('停止确认缺失时释放BLE连接并保留进度，不把取消当作成功文件', async () => {
  const { device: d, controller: c } = await fixture(); await c.listFiles(); d.hold = true; d.stopAck = false;
  const pending = c.download(SID); await tick(); c.cancelDownload();
  assert.equal(await pending, undefined); assert.equal(d.connected, false);
  assert.equal(c.snapshot.transfer.phase, 'paused'); assert.equal(c.snapshot.transfer.received, 2);
  assert.match(c.snapshot.transfer.error!, /未确认停止/); assert.equal(c.snapshot.phase, 'error');
});

test('断线后的迟到通知不污染进度，只有同一设备且相同目录条目才恢复', async () => {
  const { device: d, controller: c } = await fixture(); await c.listFiles(); d.hold = true;
  const pending = c.download(SID); await tick(); const late = d.frame; d.disconnect();
  assert.equal(await pending, undefined); assert.equal(c.snapshot.transfer.phase, 'paused');
  const next = new FileDevice(); await c.connect(next, credentials()); await c.listFiles();
  late(concat(Uint8Array.of(2), u32(SID), u32(2), Uint8Array.of(2), audio.slice(2)));
  assert.equal(c.snapshot.transfer.received, 2);
  assert.deepEqual((await c.download(SID))?.data, audio); assert.deepEqual(next.starts, [2]); c.disconnect();
});

test('换设备不能把旧部分内容与同编号新文件拼接', async () => {
  const { device: d, controller: c } = await fixture(); await c.listFiles(); d.hold = true;
  const pending = c.download(SID); await tick(); d.disconnect(); await pending;
  const other = new FileDevice(); await c.connect(other, credentials('888OTHER')); await c.listFiles();
  assert.equal(c.snapshot.transfer.received, 0);
  assert.deepEqual((await c.download(SID))?.data, audio); assert.deepEqual(other.starts, [0]); c.disconnect();
});

test('同一设备切换绑定账号也清除旧下载前缀，退出时可显式忘记下载', async () => {
  const { device: d, controller: c } = await fixture(); await c.listFiles(); d.hold = true;
  const pending = c.download(SID); await tick(); d.disconnect(); await pending;
  const next = new FileDevice();
  await c.connect(next, { ...credentials(), accountId: 'another-account' }); await c.listFiles();
  assert.equal(c.snapshot.transfer.received, 0);
  next.hold = true; const second = c.download(SID); await tick(); c.disconnect(true); await second;
  assert.equal(c.snapshot.transfer.phase, 'idle'); assert.equal(c.snapshot.transfer.received, 0);
});

test('目录最后一包与录音开始同tick到达时不提交已取消的列表', async () => {
  const { device: d, controller: c } = await fixture(), original = d.write.bind(d);
  d.write = async packet => {
    if (command(packet) !== 26) { await original(packet); return; }
    setImmediate(() => {
      d.frame(concat(request(26), packet.slice(3, 7), le16(1), le16(0), u32(SID), u32(4), Uint8Array.of(1, 0)));
      d.startRecording();
    });
  };
  await c.listFiles();
  assert.equal(c.snapshot.files.data, undefined); assert.match(c.snapshot.files.error!, /录音.*暂缓/);
  assert.equal(c.snapshot.recording.mode, 'recording'); assert.equal(d.connected, true); c.disconnect();
});

test('传输写入超时自行关闭链路而无lost回调时也清除所有旧状态', async () => {
  for (const target of [26, 28]) {
    const { device: d, controller: c } = await fixture();
    if (target === 28) await c.listFiles();
    const original = d.write.bind(d);
    d.write = async packet => {
      if (command(packet) !== target) { await original(packet); return; }
      d.connected = false; throw new Error('蓝牙写入超时');
    };
    if (target === 26) await c.listFiles(); else await c.download(SID);
    assert.equal(c.snapshot.phase, 'error'); assert.equal(c.snapshot.state.data, undefined);
    assert.equal(c.snapshot.battery.data, undefined); assert.equal(c.snapshot.files.data, undefined);
    assert.equal(c.connected, false);
  }
});

test('gap已在等待停止确认时取消，不关闭ACK队列也不重复发stop', async () => {
  const { device: d, controller: c } = await fixture(); await c.listFiles();
  const original = d.write.bind(d); let stopEntered!: () => void;
  const stopping = new Promise<void>(resolve => { stopEntered = resolve; });
  d.write = async packet => {
    const cmd = command(packet);
    if (cmd === 28) {
      d.writes.push(packet.slice());
      d.frame(concat(request(28), u32(SID), Uint8Array.of(0)));
      d.frame(concat(Uint8Array.of(2), u32(SID), u32(0), Uint8Array.of(2), audio.slice(0, 2)));
      d.frame(concat(Uint8Array.of(2), u32(SID), u32(3), Uint8Array.of(1), audio.slice(3)));
    } else if (cmd === 29) { d.writes.push(packet.slice()); stopEntered(); }
    else await original(packet);
  };
  const pending = c.download(SID); await stopping; c.cancelDownload(); d.frame(request(30));
  assert.equal(await pending, undefined); assert.equal(c.snapshot.transfer.phase, 'cancelled');
  assert.equal(c.snapshot.transfer.received, 2); assert.equal(d.connected, true);
  assert.equal(d.writes.filter(p => command(p) === 29).length, 1); c.disconnect();
});

test('轮询是单个低频定时器，断开后不再发状态请求', async () => {
  const d = new FileDevice(), c = new PlaudController(() => {}, () => {}, 30, { monitorInterval: 5, fileTimeout: 10, stopTimeout: 5 });
  await c.connect(d, credentials());
  await new Promise(resolve => setTimeout(resolve, 18));
  assert.equal(c.snapshot.files.data?.length, 1);
  assert.ok(d.writes.filter(p => command(p) === 3).length >= 2);
  c.disconnect(); const count = d.writes.length;
  await new Promise(resolve => setTimeout(resolve, 12)); assert.equal(d.writes.length, count);
});
