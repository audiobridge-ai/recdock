import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBleLink, RX, TX, SERVICE } from '../src/ble/transport.ts';

function fixture() {
  const device = new EventTarget();
  const received: number[][] = [], writes: number[][] = [], services: string[] = [];
  const rx = Object.assign(new EventTarget(), {
    properties: { notify: true, indicate: false }, value: new DataView(Uint8Array.of(1, 3, 0).buffer),
    async startNotifications() { rx.dispatchEvent(new Event('characteristicvaluechanged')); return rx; },
  });
  const tx = {
    properties: { write: true, writeWithoutResponse: true },
    async writeValueWithResponse(b: Uint8Array) { writes.push(Array.from(b)); },
    async writeValueWithoutResponse() { assert.fail('优先使用支持的有响应写入'); },
  };
  const gatt = {
    connected: false,
    async connect() { this.connected = true; return gatt; },
    async getPrimaryService(uuid: string) {
      services.push(uuid);
      return { async getCharacteristic(id: string) { if (id === RX) return rx; if (id === TX) return tx; throw Error('未知特征'); } };
    },
    disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
  };
  Object.assign(device, { gatt });
  return { device: device as unknown as BluetoothDevice, gatt, rx, received, writes, services };
}
test('GATT 在开启通知前安装监听，使用准确 UUID 和有响应写入，关闭后释放监听', async () => {
  const f = fixture(), link = new BrowserBleLink(f.device); let lost = 0;
  await link.connect(b => f.received.push(Array.from(b)), () => lost++);
  assert.equal(link.connected, true); assert.deepEqual(f.services, [SERVICE]);
  assert.deepEqual(f.received, [[1, 3, 0]]);
  await link.write(Uint8Array.of(1, 9, 0)); assert.deepEqual(f.writes, [[1, 9, 0]]);
  link.close(); assert.equal(link.connected, false); assert.equal(lost, 0);
  f.rx.dispatchEvent(new Event('characteristicvaluechanged')); assert.equal(f.received.length, 1);
});
test('通知订阅失败释放连接，不能留下已连未初始化状态', async () => {
  const f = fixture(), link = new BrowserBleLink(f.device);
  f.rx.startNotifications = async () => { throw Error('notify failed'); };
  await assert.rejects(link.connect(() => {}, () => {}), /notify failed/);
  assert.equal(link.connected, false); assert.equal(f.gatt.connected, false);
});
test('设备主动断线只通知一次，close 不再次通知', async () => {
  const f = fixture(), link = new BrowserBleLink(f.device); let count = 0;
  await link.connect(() => {}, () => count++);
  f.gatt.disconnect(); f.gatt.disconnect(); link.close();
  assert.equal(count, 1); assert.equal(link.connected, false);
});
