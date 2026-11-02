import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaudController } from '../src/app/controller.ts';
import { emptyCredentials } from '../src/auth/credentials.ts';
import type { BleLink } from '../src/ble/transport.ts';
import { command, concat, le16, unhex, utf8 } from '../src/protocol/bytes.ts';
import { FrameInbox } from '../src/ble/inbox.ts';

const c = { ...emptyCredentials(), accountId: 'test-account', portVersion: 9 };
class Device implements BleLink {
  connected = false;
  frame: (b: Uint8Array) => void = () => {};
  lost: () => void = () => {};
  sent: number[] = []; reject = false; silentBattery = false; silentState = false; onState?: () => void;
  async connect(frame: (b: Uint8Array) => void, lost: () => void) { this.connected = true; this.frame = frame; this.lost = lost; }
  async write(b: Uint8Array) {
    const cmd = command(b)!; this.sent.push(cmd);
    if (cmd === 1) this.frame(unhex(this.reject ? '010100010900' : '010100000900'));
    if (cmd === 3 && !this.silentState) { this.onState?.(); this.frame(unhex('01030000000000000000')); }
    if (cmd === 9 && !this.silentBattery) this.frame(unhex('010900014b'));
    if (cmd === 6) this.frame(unhex('01060000040000000000000008000000000000'));
  }
  async battery() { return 50; }
  close() { this.connected = false; }
}
const controller = () => new PlaudController(() => {}, () => {}, 20);
test('只有实际 GetState 返回后进入 ready，所有查询串行', async () => {
  const d = new Device(), x = controller();
  d.onState = () => assert.equal(x.snapshot.phase, 'authenticating');
  await x.connect(d, c);
  assert.equal(x.snapshot.phase, 'ready'); assert.equal(x.snapshot.battery.data?.level, 75);
  assert.equal(x.snapshot.storage.data?.free, 1024n);
  assert.deepEqual(d.sent, [1, 3, 9, 6]);
  x.disconnect(); assert.equal(x.snapshot.state.data, undefined);
});
test('缺少材料时不触碰 GATT，材料准备完成后才连接并立即认证', async () => {
  const d = new Device(), x = controller();
  await x.connect(d, emptyCredentials());
  assert.equal(x.snapshot.phase, 'credentials'); assert.equal(d.connected, false); assert.deepEqual(d.sent, []);
  assert.match(x.snapshot.stage, /连接前检查未通过/);
  await x.connect(d, c); assert.equal(x.snapshot.phase, 'ready'); x.disconnect();
});
test('GATT 尚未建立时可以报告阶段；连接和通知准备完成后直接进入认证', async () => {
  const d = new Device(), messages: string[] = [];
  const connect = d.connect.bind(d);
  const link: BleLink = {
    get connected() { return d.connected; },
    async connect(frame, lost, stage) {
      stage?.('正在建立 GATT 连接');
      await connect(frame, lost); stage?.('正在订阅设备通知');
    },
    write: b => d.write(b), battery: () => d.battery(), close: () => d.close(),
  };
  const x = new PlaudController(() => {}, s => messages.push(s), 20);
  await x.connect(link, c);
  assert.equal(x.snapshot.phase, 'ready');
  assert.ok(messages.indexOf('正在订阅设备通知') < messages.indexOf('正在验证设备 BLE token'));
  assert.deepEqual(d.sent, [1, 3, 9, 6]); x.disconnect();
});
test('port20材料缺失在连接前被拒绝，不建立等待认证的空GATT', async () => {
  const d = new Device(), x = controller();
  await x.connect(d, { ...emptyCredentials(), accountId: 'fixture-account', serialNumber: '888FIXTURE', portVersion: 20 });
  assert.equal(x.snapshot.phase, 'credentials'); assert.equal(d.connected, false);
  assert.match(x.snapshot.error!, /SN 签名、RSA/); assert.deepEqual(d.sent, []);
});
test('port20遇FE30挑战明确报告版本不符，认证日志不输出通知中的敏感内容', async () => {
  const d = new Device(), logs: string[] = [], x = new PlaudController(() => {}, s => logs.push(s), 20);
  d.connect = async (frame, lost) => {
    d.connected = true; d.frame = frame; d.lost = lost;
    frame(concat(le16(0xfe30), utf8('SECRET_CHALLENGE_CONTENT'), new Uint8Array(148)));
  };
  let writes = 0; d.write = async () => { writes++; };
  const credentials = { ...emptyCredentials(), portVersion: 20, accountId: 'SECRET_ACCOUNT', serialNumber: 'SECRET_SERIAL' };
  credentials.rsa = { alternateCommand: false, snSignature: Buffer.from('SECRET_SIGNATURE').toString('base64'), publicKeyPem: 'SECRET_PUBLIC_KEY', privateKeyPem: 'SECRET_PRIVATE_KEY' };
  await x.connect(d, credentials);
  assert.equal(x.snapshot.phase, 'error'); assert.match(x.snapshot.error!, /FE30.*portVersion=20/);
  assert.equal(d.connected, false); assert.equal(writes, 1);
  assert.ok(logs.some(s => s.includes('收到认证通知 · FE30')));
  assert.doesNotMatch(logs.join('\n'), /SECRET_/);
});
test('认证被拒绝不发送状态请求，清理连接', async () => {
  const d = new Device(), x = controller(); d.reject = true;
  await x.connect(d, c);
  assert.equal(x.snapshot.phase, 'error'); assert.equal(d.connected, false);
  assert.equal(x.snapshot.state.data, undefined); assert.deepEqual(d.sent, [1]);
});
test('状态探测超时不伪报 ready', async () => {
  const d = new Device(), x = controller(); d.silentState = true;
  await x.connect(d, c);
  assert.equal(x.snapshot.phase, 'error'); assert.match(x.snapshot.error!, /超时/);
  assert.deepEqual(d.sent, [1, 3]);
});
test('电量超时保留其他成功项，该命令重连前不重试以避免过期响应串扰', async () => {
  const d = new Device(), x = controller(); d.silentBattery = true;
  await x.connect(d, c);
  assert.equal(x.snapshot.phase, 'ready'); assert.match(x.snapshot.battery.error!, /超时/);
  assert.equal(x.snapshot.storage.data?.total, 2048n);
  const before = d.sent.filter(n => n === 9).length;
  await x.refresh();
  assert.equal(d.sent.filter(n => n === 9).length, before);
  assert.match(x.snapshot.battery.error!, /请重连/); x.disconnect();
});
test('断开时取消请求，旧回调不能污染下一次连接', async () => {
  const d = new Device(), x = controller(); d.silentState = true;
  const task = x.connect(d, c);
  await new Promise(resolve => setTimeout(resolve, 1));
  const oldFrame = d.frame; x.disconnect(); await task;
  const next = new Device(); await x.connect(next, c);
  oldFrame(unhex('010300ffffffff010101'));
  assert.equal(x.snapshot.phase, 'ready'); assert.equal(x.snapshot.state.data?.stateCode, 0);
  next.lost(); assert.equal(x.snapshot.phase, 'error'); assert.equal(x.snapshot.state.data, undefined);
});
test('通知早于等待的场景可排队，close 会取消 waiter', async () => {
  const inbox = new FrameInbox(); inbox.push(Uint8Array.of(2)); inbox.push(Uint8Array.of(3));
  assert.equal((await inbox.next(b => b[0] === 3))[0], 3);
  const pending = inbox.next(b => b[0] === 4); inbox.close();
  await assert.rejects(pending, /断开/);
});
