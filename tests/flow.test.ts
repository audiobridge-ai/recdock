import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudFailureAction, connectionChoice, connectionProgress, initialFlowState, parseBrowserDeviceBinding, reduceFlow, savedAudioFormat } from '../src/ui/flow.ts';

const session = () => reduceFlow(initialFlowState(), { type: 'session', accountId: 'account-a', deviceSerialNumbers: ['note-a', 'note-b'] });
test('云端过期或 CSRF rotation 不清除已认证 BLE；CSRF 在未连接时也只要求重试', () => {
  assert.equal(cloudFailureAction('LOGIN_EXPIRED', 401, true), 'keep-device');
  assert.equal(cloudFailureAction('CSRF_REJECTED', 403, true), 'keep-device');
  assert.equal(cloudFailureAction('CSRF_REJECTED', 403, false), 'retry');
  assert.equal(cloudFailureAction('LOGIN_EXPIRED', 401, false), 'login');
  assert.equal(cloudFailureAction('NETWORK_ERROR', 503, true), 'report');
});
function connected() {
  const started = reduceFlow(session(), { type: 'connect-start', serialNumber: 'note-a' });
  return reduceFlow(started, { type: 'connect-ready', operation: started.operation, serialNumber: 'note-a' });
}

test('恢复阶段只在确认会话后进入登录或设备列表，单设备自动选中', () => {
  assert.equal(initialFlowState().screen, 'restore');
  assert.equal(reduceFlow(initialFlowState(), { type: 'session' }).screen, 'login');
  const one = reduceFlow(initialFlowState(), { type: 'session', accountId: 'account-a', deviceSerialNumbers: ['note-a', 'note-a'] });
  assert.equal(one.screen, 'devices'); assert.equal(one.selectedSerialNumber, 'note-a'); assert.deepEqual(one.deviceSerialNumbers, ['note-a']);
  assert.equal(session().selectedSerialNumber, undefined);
});

test('首次连接经过独立进度页，只有同一操作同一设备 ready 才进入工作台', () => {
  let state = reduceFlow(session(), { type: 'connect-start', serialNumber: 'note-a' });
  assert.equal(state.screen, 'connecting'); assert.equal(state.connection, 'connecting');
  assert.equal(reduceFlow(state, { type: 'connect-ready', operation: state.operation, serialNumber: 'note-b' }), state);
  state = reduceFlow(state, { type: 'connect-progress', operation: state.operation, step: 'gatt' });
  assert.deepEqual(connectionProgress(state).map(row => row.status), ['done', 'done', 'active', 'pending', 'pending']);
  assert.equal(reduceFlow(state, { type: 'connect-progress', operation: state.operation, step: 'preparing' }), state);
  state = reduceFlow(state, { type: 'connect-ready', operation: state.operation, serialNumber: 'note-a' });
  assert.equal(state.screen, 'workspace'); assert.equal(state.workspaceSerialNumber, 'note-a');
  assert.ok(connectionProgress(state).every(row => row.status === 'done'));
});

test('连接取消后迟到的材料、进度和 ready 不会恢复旧操作', () => {
  const started = reduceFlow(session(), { type: 'connect-start', serialNumber: 'note-a' }), operation = started.operation;
  const cancelled = reduceFlow(started, { type: 'cancel-connect' });
  assert.equal(cancelled.screen, 'devices'); assert.equal(cancelled.connection, 'offline');
  assert.equal(reduceFlow(cancelled, { type: 'connect-progress', operation, step: 'reading' }), cancelled);
  assert.equal(reduceFlow(cancelled, { type: 'connect-ready', operation, serialNumber: 'note-a' }), cancelled);
  const retry = reduceFlow(cancelled, { type: 'connect-start', serialNumber: 'note-b' });
  assert.notEqual(retry.operation, operation);
  assert.equal(reduceFlow(retry, { type: 'connect-error', operation, message: '旧请求失败' }), retry);
});

test('工作台断线保留页面和标签，同设备重连时仍留在工作台', () => {
  const workspace = reduceFlow(connected(), { type: 'tab', tab: 'recordings' });
  let state = reduceFlow(workspace, { type: 'disconnect', message: '设备连接已断开' });
  assert.equal(state.screen, 'workspace'); assert.equal(state.tab, 'recordings'); assert.equal(state.connection, 'offline');
  assert.equal(state.error, '设备连接已断开');
  state = reduceFlow(state, { type: 'connect-start', serialNumber: 'note-a', step: 'preparing' });
  assert.equal(state.screen, 'workspace'); assert.equal(state.connection, 'connecting');
  state = reduceFlow(state, { type: 'connect-error', operation: state.operation, message: '设备未唤醒' });
  assert.equal(state.screen, 'workspace'); assert.equal(state.connection, 'offline');
});

test('切换设备失败回到设备列表，切换账号或退出清除旧工作台', () => {
  let state = reduceFlow(connected(), { type: 'disconnect' });
  state = reduceFlow(state, { type: 'connect-start', serialNumber: 'note-b' });
  assert.equal(state.screen, 'connecting');
  state = reduceFlow(state, { type: 'cancel-connect' }); assert.equal(state.screen, 'devices');
  const changed = reduceFlow(connected(), { type: 'session', accountId: 'account-b', deviceSerialNumbers: ['note-b'] });
  assert.equal(changed.workspaceSerialNumber, undefined); assert.equal(changed.selectedSerialNumber, 'note-b');
  const logout = reduceFlow(connected(), { type: 'logout' });
  assert.equal(logout.screen, 'login'); assert.equal(logout.accountId, undefined); assert.equal(logout.workspaceSerialNumber, undefined);
  assert.deepEqual(logout.deviceSerialNumbers, []);
});

test('已授权设备复用必须同时匹配账号、SN 和浏览器设备 ID', () => {
  const binding = { accountId: 'account-a', serialNumber: 'note-a', browserDeviceId: 'browser-a', verifiedPortVersion: 20 };
  assert.deepEqual(connectionChoice('account-a', 'note-a', binding, [{ id: 'browser-a' }]), { kind: 'reuse', browserDeviceId: 'browser-a' });
  for (const choice of [
    connectionChoice('account-b', 'note-a', binding, [{ id: 'browser-a' }]),
    connectionChoice('account-a', 'note-b', binding, [{ id: 'browser-a' }]),
    connectionChoice('account-a', 'note-a', binding, []),
    connectionChoice('account-a', 'note-a', undefined, [{ id: 'browser-a' }]),
  ]) assert.deepEqual(choice, { kind: 'choose' });
});

test('IndexedDB 缓存解析只保留非敏感白名单，畸形端口与跨账号映射拒绝', () => {
  const value = { accountId: 'account-a', serialNumber: 'note-a', browserDeviceId: 'browser-a', verifiedPortVersion: 20, verifiedAt: 100,
    password: 'fixture-only', token: 'fixture-only', privateKey: 'fixture-only' };
  assert.deepEqual(parseBrowserDeviceBinding(value, 'account-a', 'note-a'), {
    accountId: 'account-a', serialNumber: 'note-a', browserDeviceId: 'browser-a', verifiedPortVersion: 20, verifiedAt: 100,
  });
  assert.equal(parseBrowserDeviceBinding(value, 'account-b', 'note-a'), undefined);
  assert.equal(parseBrowserDeviceBinding({ ...value, verifiedPortVersion: 20.5 }, 'account-a', 'note-a'), undefined);
  assert.equal(parseBrowserDeviceBinding({ ...value, verifiedPortVersion: 65536 }, 'account-a', 'note-a'), undefined);
  assert.equal(parseBrowserDeviceBinding({ ...value, verifiedAt: Infinity }, 'account-a', 'note-a'), undefined);
  assert.equal(savedAudioFormat('ogg'), 'ogg'); assert.equal(savedAudioFormat('wav'), 'wav'); assert.equal(savedAudioFormat('unexpected'), 'wav');
});
