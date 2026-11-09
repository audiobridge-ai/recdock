import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDevicePreference, WorkspacePreferences } from '../src/ui/preferences.ts';

const origin = 'http://localhost:5173';

function indexedDatabase(values = new Map<string, unknown>()) {
  const database = {
    close() {},
    transaction() {
      let pending = 0, finished = false;
      const transaction: Record<string, unknown> = {};
      const finish = () => { if (!pending && !finished) { finished = true; (transaction.oncomplete as (() => void) | undefined)?.(); } };
      const request = (read: () => unknown) => {
        pending++;
        const result: Record<string, unknown> = {};
        queueMicrotask(() => { result.result = read(); (result.onsuccess as (() => void) | undefined)?.(); pending--; queueMicrotask(finish); });
        return result;
      };
      const store = {
        get: (key: string) => request(() => values.get(key)),
        getAll: () => request(() => [...values.values()]),
        put: (value: unknown, key: string) => request(() => { values.set(key, value); }),
        clear: () => request(() => values.clear()),
        openCursor() {
          const keys = [...values.keys()]; let index = 0;
          const cursorRequest: Record<string, unknown> = {};
          const next = () => {
            pending++;
            queueMicrotask(() => {
              const key = keys[index++];
              cursorRequest.result = key === undefined ? null : { key, delete: () => request(() => values.delete(key)), continue: next };
              (cursorRequest.onsuccess as (() => void) | undefined)?.(); pending--; queueMicrotask(finish);
            });
          };
          next(); return cursorRequest;
        },
      };
      transaction.objectStore = () => store;
      transaction.abort = () => { finished = true; (transaction.onabort as (() => void) | undefined)?.(); };
      queueMicrotask(finish); return transaction;
    },
  };
  const factory = { open() {
    const request: Record<string, unknown> = { result: database };
    queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.()); return request;
  } } as unknown as IDBFactory;
  return { factory, values };
}

test('设备偏好只接受匹配 origin/账号/SN 的成功协议记录，丢弃额外敏感字段', () => {
  const value = { origin, accountId: 'a', serialNumber: 's', browserDeviceId: 'b', verifiedPortVersion: 20, lastUsed: 100, privateKey: 'test-fixture', userToken: 'test-fixture' };
  assert.deepEqual(parseDevicePreference(value, origin, 'a', 's'), { origin, accountId: 'a', serialNumber: 's', browserDeviceId: 'b', verifiedPortVersion: 20, lastUsed: 100 });
  assert.equal(parseDevicePreference(value, 'http://localhost:5174', 'a', 's'), undefined);
  assert.equal(parseDevicePreference({ ...value, verifiedPortVersion: undefined }, origin, 'a', 's'), undefined);
  assert.equal(parseDevicePreference({ ...value, lastUsed: -1 }, origin, 'a', 's'), undefined);
});

test('IndexedDB 不可用时本页内存仍可复用设备与格式，清账号不影响其他账号', async () => {
  let now = 100;
  const preferences = new WorkspacePreferences(origin, undefined, () => now++);
  assert.equal(await preferences.loadAudioFormat('a'), 'ogg');
  assert.equal(await preferences.rememberDevice('a', 's1', 'b1', 20), false);
  await preferences.rememberDevice('a', 's2', 'b2', 30); await preferences.rememberDevice('other', 's1', 'b3', 20);
  await preferences.saveAudioFormat('a', 'ogg'); await preferences.saveAudioFormat('other', 'ogg');
  assert.deepEqual((await preferences.loadDevices('a')).map(row => row.serialNumber), ['s2', 's1']);
  assert.equal((await preferences.loadDevice('a', 's1'))?.browserDeviceId, 'b1');
  assert.equal(await preferences.loadAudioFormat('a'), 'ogg'); assert.equal(preferences.persistent, false);
  await preferences.clearAccount('a');
  assert.equal(await preferences.loadDevice('a', 's1'), undefined); assert.equal(await preferences.loadAudioFormat('a'), 'ogg');
  assert.equal((await preferences.loadDevice('other', 's1'))?.browserDeviceId, 'b3'); assert.equal(await preferences.loadAudioFormat('other'), 'ogg');
});

test('无痕或权限导致 open 抛错时自动降级，后续操作不重复打开数据库', async () => {
  let opens = 0;
  const factory = { open() { opens++; throw new Error('SecurityError'); } } as unknown as IDBFactory;
  const preferences = new WorkspacePreferences(origin, factory, () => 100);
  assert.equal(await preferences.rememberDevice('a', 's', 'b', 20), false);
  assert.equal((await preferences.loadDevice('a', 's'))?.verifiedPortVersion, 20);
  assert.equal(await preferences.saveAudioFormat('a', 'ogg'), false); assert.equal(await preferences.loadAudioFormat('a'), 'ogg');
  assert.equal(opens, 1); assert.equal(preferences.persistent, false);
});

test('持久缓存可跨实例恢复，并按复合键隔离账号、设备和 origin', async () => {
  const { factory, values } = indexedDatabase();
  const first = new WorkspacePreferences(origin, factory, () => 123);
  assert.equal(await first.rememberDevice('a', 's', 'b', 20), true); assert.equal(await first.saveAudioFormat('a', 'ogg'), true);
  await first.rememberDevice('other', 's', 'other-browser', 30);
  const restored = new WorkspacePreferences(origin, factory);
  assert.equal((await restored.loadDevice('a', 's'))?.browserDeviceId, 'b'); assert.equal(await restored.loadAudioFormat('a'), 'ogg');
  assert.equal(await new WorkspacePreferences('http://localhost:5174', factory).loadDevice('a', 's'), undefined);
  await restored.clearAccount('a');
  assert.equal(await new WorkspacePreferences(origin, factory).loadDevice('a', 's'), undefined);
  assert.equal((await restored.loadDevice('other', 's'))?.browserDeviceId, 'other-browser');
  assert.ok([...values.values()].every(value => !('privateKey' in (value as object)) && !('userToken' in (value as object))));
});

test('坏缓存和未知格式不阻塞恢复，也不会被当作已验证设备使用', async () => {
  const { factory, values } = indexedDatabase();
  values.set(JSON.stringify([origin, 'device', 'a', 's']), { origin, accountId: 'a', serialNumber: 's', browserDeviceId: 'b', verifiedPortVersion: '20', lastUsed: 100 });
  values.set(JSON.stringify([origin, 'format', 'a']), { kind: 'format', origin, accountId: 'a', format: 'malformed' });
  const preferences = new WorkspacePreferences(origin, factory);
  assert.equal(await preferences.loadDevice('a', 's'), undefined); assert.deepEqual(await preferences.loadDevices('a'), []);
  assert.equal(await preferences.loadAudioFormat('a'), 'ogg'); assert.equal(preferences.persistent, true);
  assert.equal(await preferences.rememberDevice('a', 's', 'b', 0), false);
});
