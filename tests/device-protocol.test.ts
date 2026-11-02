import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDeviceProtocol } from '../src/app/device-protocol.ts';
import { CloudApiError } from '../src/auth/cloud.ts';
const sn = '888TEST';
const device = { id: 'synthetic-browser-device' } as BluetoothDevice;
const detected = { serialNumber: sn, portVersion: 20, firmware: 'V123' };
function options() {
  let calls = 0;
  return { device, serialNumber: sn, signal: new AbortController().signal, stage() {}, async local() { calls++; return detected; }, get calls() { return calls; } };
}
test('首次连接没有版本且浏览器不支持广播时自动调用本机识别，不要求填写20', async () => {
  const o = options(); assert.deepEqual(await detectDeviceProtocol(o), detected); assert.equal(o.calls, 1);
});
test('浏览器可读广播时直接取得版本，不触发本机权限；监听成功后释放', async () => {
  const o = options(); let stopped = false;
  const result = await detectDeviceProtocol({ ...o, observe: async (_device, callback) => { callback({ ...detected, project: 888, model: 'Note' }); return () => { stopped = true; }; } });
  assert.deepEqual(result, detected); assert.equal(o.calls, 0); assert.equal(stopped, true);
});
test('浏览器启动失败或超时自动转本机；晚到监听会释放', async () => {
  const o = options(); let stopped = false;
  const result = await detectDeviceProtocol({ ...o, browserTimeout: 1, observe: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return () => { stopped = true; }; } });
  assert.equal(result.portVersion, 20); await new Promise(resolve => setTimeout(resolve, 8)); assert.equal(stopped, true);
  assert.equal((await detectDeviceProtocol({ ...o, observe: async () => { throw new Error('browser unavailable'); } })).portVersion, 20);
});
test('错误设备或非法协议不会尝试认证，不猜型号默认值', async () => {
  for (const bad of [{ ...detected, serialNumber: 'OTHER' }, { ...detected, portVersion: 0 }, { ...detected, portVersion: 70000 }]) {
    await assert.rejects(detectDeviceProtocol({ ...options(), local: async () => bad }), error => error instanceof CloudApiError);
  }
  let local = false;
  await assert.rejects(detectDeviceProtocol({ ...options(), local: async () => { local = true; return detected; }, observe: async (_d, callback) => { callback({ ...detected, serialNumber: 'OTHER', project: 888, model: 'Note' }); return () => {}; } }), error => error instanceof CloudApiError && error.code === 'DEVICE_MISMATCH');
  assert.equal(local, false);
});
test('取消浏览器等待或本机识别后丢弃迟到结果，不启动下一阶段', async () => {
  const abort = new AbortController(); let local = false;
  const task = detectDeviceProtocol({ ...options(), signal: abort.signal, local: async () => { local = true; return detected; }, observe: async () => () => {} });
  abort.abort(); await assert.rejects(task, error => error instanceof CloudApiError && error.code === 'OPERATION_CANCELLED'); assert.equal(local, false);
  const other = new AbortController();
  await assert.rejects(detectDeviceProtocol({ ...options(), signal: other.signal, local: async () => { other.abort(); return detected; } }), error => error instanceof CloudApiError && error.code === 'OPERATION_CANCELLED');
});
