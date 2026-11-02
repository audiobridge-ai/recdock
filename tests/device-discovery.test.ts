import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { NativeDeviceDiscovery, parseDiscoveredDevice, readNativeAdvertisement } from '../server/device-discovery.ts';
import { CloudError } from '../server/cloud-client.ts';
const payload = '5900027803045608020209888001234567890000140000000000000101';
const serialNumber = '888001234567890000';
const advertisement = JSON.stringify({ type: 'advertisement', manufacturerHex: payload });
function processFixture() {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: [] as string[], kill(signal: string) { this.kills.push(signal); queueMicrotask(() => emitter.emit('close', 0)); return true; } });
  let input = ''; child.stdin.on('data', chunk => { input += chunk.toString(); });
  return { child, launch: () => child as unknown as ChildProcessWithoutNullStreams, input: () => input };
}
test('本机广播使用App对齐解析器，去除company头；改名与未知company不影响SN匹配', () => {
  const result = parseDiscoveredDevice(advertisement, serialNumber);
  assert.equal(result?.portVersion, 20); assert.equal(result?.source, 'native-advertisement');
  assert.equal(result?.serialNumber, serialNumber);
  assert.equal(parseDiscoveredDevice(advertisement, '888OTHER'), undefined);
  assert.equal(parseDiscoveredDevice(JSON.stringify({ type: 'advertisement', manufacturerHex: '3412' + payload.slice(4) }), serialNumber)?.portVersion, 20);
  assert.equal(parseDiscoveredDevice(JSON.stringify({ type: 'advertisement', manufacturerHex: '59000102030405060708' }), serialNumber), undefined);
});
test('空/截断/长SN绑定元数据不被当协议，错误响应不会回显原始材料', () => {
  assert.equal(parseDiscoveredDevice('{"type":"advertisement","manufacturerHex":"secret"}', serialNumber), undefined);
  for (const line of ['secret-not-json', 'x'.repeat(2049)]) assert.throws(() => parseDiscoveredDevice(line, serialNumber), error => error instanceof CloudError && !error.message.includes('secret'));
  assert.throws(() => parseDiscoveredDevice('{"type":"error","code":"BLUETOOTH_PERMISSION_REQUIRED","secret":"ignored"}', serialNumber), error => error instanceof CloudError && error.code === 'BLUETOOTH_PERMISSION_REQUIRED' && !error.message.includes('ignored'));
});
test('私有pipe只传目标SN；流分片可组包并忽略其他设备，成功后停止扫描', async () => {
  const f = processFixture();
  const task = readNativeAdvertisement('/synthetic-helper', serialNumber, new AbortController().signal, f.launch);
  assert.deepEqual(JSON.parse(f.input()), { serialNumber });
  f.child.stdout.write('{"type":"advertisement","manufacturerHex":"00000102030405060708"}\n');
  f.child.stdout.write(advertisement.slice(0, 10)); f.child.stdout.write(advertisement.slice(10) + '\n');
  assert.equal((await task).portVersion, 20); assert.deepEqual(f.child.kills, ['SIGTERM']);
});
test('取消/超时/权限失败都会停止扫描，取消前不启动新进程', async () => {
  for (const mode of ['cancel', 'timeout', 'permission'] as const) {
    const f = processFixture(), abort = new AbortController();
    const task = readNativeAdvertisement('/synthetic-helper', serialNumber, abort.signal, f.launch, 5);
    if (mode === 'cancel') abort.abort();
    if (mode === 'permission') f.child.stdout.write('{"type":"error","code":"BLUETOOTH_PERMISSION_REQUIRED"}\n');
    await assert.rejects(task, error => error instanceof CloudError && error.code === (mode === 'cancel' ? 'OPERATION_CANCELLED' : mode === 'timeout' ? 'DEVICE_NOT_FOUND' : 'BLUETOOTH_PERMISSION_REQUIRED'));
    assert.deepEqual(f.child.kills, ['SIGTERM']);
  }
  const abort = new AbortController(); abort.abort(); let spawned = false;
  await assert.rejects(readNativeAdvertisement('/synthetic-helper', serialNumber, abort.signal, () => { spawned = true; throw new Error(); }), /取消/);
  assert.equal(spawned, false);
});
test('辅助进程输出超限或异常退出返回固定错误，不泄露stderr', async () => {
  const f = processFixture(), task = readNativeAdvertisement('/synthetic-helper', serialNumber, new AbortController().signal, f.launch);
  f.child.stderr.write('SECRET_NATIVE_DIAGNOSTICS'); f.child.stdout.write('x'.repeat(5000));
  await assert.rejects(task, error => error instanceof CloudError && error.code === 'DEVICE_DISCOVERY_INVALID' && !error.message.includes('SECRET'));
});


test('首次准备辅助程序时取消立即释放操作，不等编译完成或启动扫描', async () => {
  const discovery = new NativeDeviceDiscovery();
  let finish!: (value: string) => void;
  discovery.executable = () => new Promise<string>(resolve => { finish = resolve; });
  const abort = new AbortController(), pending = discovery.detect(serialNumber, abort.signal);
  abort.abort();
  await assert.rejects(pending, error => error instanceof CloudError && error.code === 'OPERATION_CANCELLED');
  finish('/not-launched');
  const next = new AbortController(), nextPending = discovery.detect(serialNumber, next.signal);
  next.abort(); await assert.rejects(nextPending, error => error instanceof CloudError && error.code === 'OPERATION_CANCELLED');
  finish('/not-launched');
});
