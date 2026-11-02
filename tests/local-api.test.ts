import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCloudMiddleware } from '../server/http.ts';
import { CloudError } from '../server/cloud-client.ts';
import type { CloudSession, CloudDevice } from '../server/cloud-client.ts';
import type { VaultData } from '../server/vault.ts';
import { emptyCredentials } from '../src/auth/credentials.ts';
import type { Credentials } from '../src/auth/credentials.ts';

const cloudSession = (): CloudSession => ({
  userToken: 'SECRET_USER_TOKEN', userBaseUrl: 'https://api.plaud.ai',
  account: { accountId: 'fixture-account', email: 'fixture@example.com' },
  devices: [{ serialNumber: '888FIXTURE', name: '已改名 Note', portVersion: 20 }],
});
function fixture() {
  let calls = 0, clock = 0;
  const client = {
    async login() { calls++; return cloudSession(); },
    async importSession() { calls++; return cloudSession(); },
    async devices(s: CloudSession) { return s.devices; },
    async restore(s: CloudSession) { return s; },
    async prepare(_s: CloudSession, sn: string, _port?: number, _allowKeyInitialization?: boolean): Promise<{ credentials: Credentials; device: CloudDevice }> { calls++; return { credentials: { ...emptyCredentials(), serialNumber: sn, accountId: 'fixture-account', portVersion: 20 }, device: cloudSession().devices[0] }; },
  };
  let stored: VaultData = { version: 1, accounts: {} };
  const store = { async load() { return structuredClone(stored); }, async update(fn: (data: VaultData) => void | Promise<void>) { const next = structuredClone(stored); await fn(next); stored = next; } };
  let detections = 0;
  const detector = { async detectDevice(sn: string, _signal: AbortSignal) { detections++; return { serialNumber: sn, portVersion: 20, firmware: 'V123', source: 'native-advertisement' as const }; } };
  let middleware = createCloudMiddleware(client, () => clock, { store, detectDevice: (sn, signal) => detector.detectDevice(sn, signal) });
  async function request(path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) {
    const input = data === undefined ? '' : JSON.stringify(data);
    const req = Object.assign(Readable.from([Buffer.from(input)]), {
      method, url: path, headers: { host: 'localhost:5173', 'content-type': 'application/json', ...headers },
      socket: { remoteAddress: '127.0.0.1' }, aborted: false,
    }) as unknown as IncomingMessage;
    const responseHeaders: Record<string, string> = {};
    let raw = '', next = false;
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string) { responseHeaders[name.toLowerCase()] = value; },
      end(value: string) { raw = value; },
    };
    await middleware(req, res as unknown as ServerResponse, () => { next = true; });
    return { status: res.statusCode, headers: responseHeaders, json: raw ? JSON.parse(raw) : undefined, raw, next };
  }
  return { request, client, store, detector, get detections() { return detections; }, restart() { middleware = createCloudMiddleware(client, () => clock, { store, detectDevice: (sn, signal) => detector.detectDevice(sn, signal) }); }, get calls() { return calls; }, advance(ms: number) { clock += ms; } };
}
async function guest(f: ReturnType<typeof fixture>) {
  const r = await f.request('/api/session');
  const cookie = r.headers['set-cookie'].split(';')[0];
  return { cookie, 'x-csrf-token': r.json.csrfToken };
}
const login = { email: 'fixture@example.com', password: 'SECRET_PASSWORD', region: 'auto' };

test('本地登录会话不泄露云token，登录后旋转cookie与CSRF，禁止缓存', async () => {
  const f = fixture(), headers = await guest(f);
  const r = await f.request('/api/login', 'POST', login, headers);
  assert.equal(r.status, 200); assert.equal(r.json.authenticated, true);
  assert.equal(r.json.account.accountId, 'fixture-account');
  assert.doesNotMatch(r.raw, /SECRET_USER_TOKEN|SECRET_PASSWORD/);
  assert.match(r.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  assert.notEqual(r.headers['set-cookie'].split(';')[0], headers.cookie);
  assert.notEqual(r.json.csrfToken, headers['x-csrf-token']);
  assert.match(r.headers['cache-control'], /no-store/);
  assert.equal((await f.request('/api/prepare-device', 'POST', { serialNumber: '888FIXTURE' }, headers)).status, 403);
});

test('其他网站、DNS重绑Host和没有CSRF的请求不会提交任何密码到PLAUD', async () => {
  const f = fixture(), headers = await guest(f);
  const blockedHeaders: Record<string, string>[] = [{ origin: 'https://unrelated.example' }, { host: 'unrelated.example' }, { 'sec-fetch-site': 'cross-site' }, { 'x-csrf-token': 'wrong' }];
  for (const extra of blockedHeaders) {
    const r = await f.request('/api/login', 'POST', login, { ...headers, ...extra });
    assert.equal(r.status, 403); assert.doesNotMatch(r.raw, /SECRET_PASSWORD/);
  }
  assert.equal(f.calls, 0);
});

test('导入网页登录态经过同样的本机与CSRF保护，成功旋转会话且不返回云token', async () => {
  const f = fixture(), headers = await guest(f);
  const imported = { userToken: 'SECRET_WEB_TOKEN', userApiDomain: 'https://api-euc1.plaud.ai' };
  const rejectedHeaders: Record<string, string>[] = [{ origin: 'https://web.plaud.ai' }, { 'x-csrf-token': 'wrong' }, { host: 'evil.example' }];
  for (const extra of rejectedHeaders) {
    const blocked = await f.request('/api/import-session', 'POST', imported, { ...headers, ...extra });
    assert.equal(blocked.status, 403); assert.doesNotMatch(blocked.raw, /SECRET_WEB_TOKEN/);
  }
  assert.equal(f.calls, 0);
  const success = await f.request('/api/import-session', 'POST', imported, headers);
  assert.equal(success.status, 200); assert.equal(success.json.authenticated, true); assert.equal(f.calls, 1);
  assert.notEqual(success.headers['set-cookie'].split(';')[0], headers.cookie);
  assert.notEqual(success.json.csrfToken, headers['x-csrf-token']);
  assert.doesNotMatch(success.raw, /SECRET_WEB_TOKEN|SECRET_USER_TOKEN/);
  assert.match(success.headers['cache-control'], /no-store/);
});

test('导入验证失败或退出后的迟到导入结果不能登录，也不回显用户令牌', async () => {
  const f = fixture(), headers = await guest(f);
  const missing = await f.request('/api/import-session', 'POST', { userToken: 'SECRET_WEB_TOKEN' }, headers);
  assert.equal(missing.status, 400); assert.equal(f.calls, 0);
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.client.importSession = async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return cloudSession(); };
  const pending = f.request('/api/import-session', 'POST', { userToken: 'SECRET_WEB_TOKEN', userApiDomain: 'https://api-euc1.plaud.ai' }, headers);
  await entered;
  const loggedOut = await f.request('/api/logout', 'POST', {}, headers);
  release();
  const late = await pending;
  assert.equal(late.status, 409); assert.equal(late.json.error.code, 'OPERATION_CANCELLED');
  assert.doesNotMatch(late.raw, /SECRET_WEB_TOKEN|SECRET_USER_TOKEN/);
  const check = await f.request('/api/session', 'GET', undefined, { cookie: loggedOut.headers['set-cookie'].split(';')[0] });
  assert.equal(check.json.authenticated, false);
});

test('云端不接受导入令牌时本地会话保持未登录', async () => {
  const f = fixture(), headers = await guest(f);
  f.client.importSession = async () => { throw new CloudError('SESSION_EXPIRED', '当前授权未通过云端校验', 401); };
  const result = await f.request('/api/import-session', 'POST', { userToken: 'SECRET_WEB_TOKEN', userApiDomain: 'https://api-euc1.plaud.ai' }, headers);
  assert.equal(result.status, 401); assert.doesNotMatch(result.raw, /SECRET_WEB_TOKEN/);
  assert.equal((await f.request('/api/session', 'GET', undefined, { cookie: headers.cookie })).json.authenticated, false);
});

test('未登录、无效协议版本与非布尔密钥许可都不能准备设备材料', async () => {
  const f = fixture(), headers = await guest(f);
  assert.equal((await f.request('/api/prepare-device', 'POST', { serialNumber: '888FIXTURE' }, headers)).status, 401);
  const r = await f.request('/api/login', 'POST', login, headers);
  const logged = { cookie: r.headers['set-cookie'].split(';')[0], 'x-csrf-token': r.json.csrfToken };
  for (const extra of [{ portVersion: 0 }, { portVersion: 20.5 }, { allowKeyInitialization: 'true' }]) {
    assert.equal((await f.request('/api/prepare-device', 'POST', { serialNumber: '888FIXTURE', ...extra }, logged)).status, 400);
  }
  assert.equal(f.calls, 1);
});

test('退出登录与会话过期清除认证状态', async () => {
  const f = fixture(), headers = await guest(f);
  const r = await f.request('/api/login', 'POST', login, headers);
  const logged = { cookie: r.headers['set-cookie'].split(';')[0], 'x-csrf-token': r.json.csrfToken };
  const out = await f.request('/api/logout', 'POST', {}, logged);
  assert.equal(out.json.authenticated, false);
  const old = await f.request('/api/session', 'GET', undefined, { cookie: logged.cookie });
  assert.equal(old.json.authenticated, false);
  const newHeaders = await guest(f);
  f.advance(60 * 60 * 1000 + 1);
  const expired = await f.request('/api/session', 'GET', undefined, { cookie: newHeaders.cookie });
  assert.equal(expired.json.authenticated, false); assert.notEqual(expired.json.csrfToken, newHeaders['x-csrf-token']);
});

test('退出后的迟到材料请求不返回私钥或恢复登录状态', async () => {
  const f = fixture(), headers = await guest(f);
  const r = await f.request('/api/login', 'POST', login, headers);
  const logged = { cookie: r.headers['set-cookie'].split(';')[0], 'x-csrf-token': r.json.csrfToken };
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.client.prepare = async () => {
    started(); await new Promise<void>(resolve => { release = resolve; });
    const credentials = emptyCredentials(); credentials.rsa.privateKeyPem = 'SECRET_PRIVATE_KEY';
    return { credentials, device: cloudSession().devices[0] };
  };
  const pending = f.request('/api/prepare-device', 'POST', { serialNumber: '888FIXTURE' }, logged);
  await entered;
  await f.request('/api/logout', 'POST', {}, logged);
  release();
  const late = await pending;
  assert.equal(late.status, 409); assert.equal(late.json.error.code, 'OPERATION_CANCELLED');
  assert.doesNotMatch(late.raw, /SECRET_PRIVATE_KEY/);
});

test('请求体上限和JSON错误不回显密码；普通页面交回Vite', async () => {
  const f = fixture(), headers = await guest(f);
  const r = await f.request('/api/login', 'POST', { ...login, password: 'SECRET_PASSWORD'.repeat(2000) }, headers);
  assert.equal(r.status, 413); assert.doesNotMatch(r.raw, /SECRET_PASSWORD/);
  assert.equal((await f.request('/')).next, true);
  assert.equal(f.calls, 0);
});

async function loggedIn(f: ReturnType<typeof fixture>, remember = true) {
  const headers = await guest(f);
  const result = await f.request('/api/login', 'POST', { ...login, remember }, headers);
  assert.equal(result.status, 200);
  return { cookie: result.headers['set-cookie'].split(';')[0], 'x-csrf-token': result.json.csrfToken };
}

test('服务重启后恢复经过在线校验的登录，记住选项关闭时不自动恢复', async () => {
  const f = fixture(); await loggedIn(f); f.restart();
  const restored = await f.request('/api/session');
  assert.equal(restored.json.authenticated, true); assert.equal(restored.json.offline, false);
  assert.equal(restored.json.persistence.hasSavedAccount, true);
  assert.doesNotMatch(restored.raw, /SECRET_USER_TOKEN/);
  const g = fixture(); await loggedIn(g, false); g.restart();
  assert.equal((await g.request('/api/session')).json.authenticated, false);
});

test('离线恢复限30天，真实401要求重登并保留录音密钥记录', async () => {
  const f = fixture(); await loggedIn(f);
  f.client.restore = async () => { throw new CloudError('CLOUD_NETWORK_ERROR', '网络不可用'); };
  f.restart(); assert.equal((await f.request('/api/session')).json.offline, true);
  f.advance(30 * 24 * 60 * 60 * 1000 + 1); f.restart();
  assert.equal((await f.request('/api/session')).json.authenticated, false);
  const g = fixture(); await loggedIn(g);
  g.client.restore = async () => { throw new CloudError('SESSION_EXPIRED', 'expired', 401); };
  g.restart(); assert.equal((await g.request('/api/session')).json.authenticated, false);
  assert.ok((await g.store.load()).accounts['fixture-account']);
  assert.equal((await g.store.load()).accounts['fixture-account'].login, undefined);
});

test('认证成功记忆按SN保存，固件变化不复用已验证协议，换账号设备不接受', async () => {
  const f = fixture(), headers = await loggedIn(f);
  const r = await f.request('/api/device-memory', 'POST', { serialNumber: '888FIXTURE', portVersion: 20 }, headers);
  assert.equal(r.status, 200);
  f.restart(); const session = await f.request('/api/session');
  assert.equal(session.json.devices[0].portVersion, 20);
  assert.equal((await f.request('/api/device-memory', 'POST', { serialNumber: 'OTHER', portVersion: 20 }, { cookie: session.headers['set-cookie'].split(';')[0], 'x-csrf-token': session.json.csrfToken })).status, 403);
});

test('缓存故障允许内存登录并明确未记住，不回显路径或凭据', async () => {
  const f = fixture(), headers = await guest(f);
  f.store.update = async () => { throw new Error('SECRET_DISK_PATH'); };
  const r = await f.request('/api/login', 'POST', login, headers);
  assert.equal(r.status, 200); assert.equal(r.json.authenticated, true);
  assert.equal(r.json.persistence.available, false);
  assert.doesNotMatch(r.raw, /SECRET_DISK_PATH|SECRET_USER_TOKEN|SECRET_PASSWORD/);
});

test('准备材料持久保存、重连复用；退出保留RSA，明确清理才删除本账号材料', async () => {
  const f = fixture();
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let preparations = 0;
  f.client.prepare = async (auth, sn) => {
    preparations++;
    const credentials = { ...emptyCredentials(), serialNumber: sn, accountId: auth.account.accountId, portVersion: 20 };
    credentials.rsa = { publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), snSignature: 'AAAA', alternateCommand: false };
    auth.rsaCache = credentials.rsa;
    return { credentials, device: auth.devices[0] };
  };
  let headers = await loggedIn(f);
  const first = await f.request('/api/prepare-device', 'POST', { serialNumber: '888FIXTURE' }, headers);
  assert.equal(first.status, 200); assert.equal(first.json.source, 'cloud');
  const second = await f.request('/api/prepare-device', 'POST', { serialNumber: '888FIXTURE' }, headers);
  assert.equal(second.json.source, 'cache'); assert.equal(preparations, 1);
  await f.request('/api/logout', 'POST', {}, headers);
  const saved = (await f.store.load()).accounts['fixture-account'];
  assert.equal(saved.rsaKeys.length, 1); assert.equal(saved.login, undefined);
  headers = await loggedIn(f);
  assert.equal((await f.request('/api/prepare-device', 'POST', { serialNumber: '888FIXTURE' }, headers)).json.source, 'cache');
  assert.equal(preparations, 1);
  await f.request('/api/logout', 'POST', { forgetLocalData: true }, headers);
  assert.equal((await f.store.load()).accounts['fixture-account'], undefined);
});

test('准备失败前已旋转的refresh token仍保存，退出后的迟到结果不恢复登录', async () => {
  const f = fixture(), headers = await loggedIn(f);
  f.client.prepare = async auth => {
    auth.userToken = 'ROTATED_SYNTHETIC_USER_TOKEN'; auth.refreshToken = 'ROTATED_SYNTHETIC_REFRESH_TOKEN';
    throw new CloudError('KEY_INITIALIZATION_REQUIRED', '需要首次初始化', 409);
  };
  const r = await f.request('/api/prepare-device', 'POST', { serialNumber: '888FIXTURE' }, headers);
  assert.equal(r.status, 409);
  assert.equal((await f.store.load()).accounts['fixture-account'].login?.refreshToken, 'ROTATED_SYNTHETIC_REFRESH_TOKEN');
  assert.doesNotMatch(r.raw, /ROTATED_SYNTHETIC/);
});

test('保存登录态在线恢复身份不一致时停止自动恢复，保留本账号资料', async () => {
  const f = fixture(); await loggedIn(f);
  f.client.restore = async () => { throw new CloudError('SESSION_ACCOUNT_MISMATCH', '身份不一致', 409); };
  f.restart(); const result = await f.request('/api/session');
  assert.equal(result.json.authenticated, false);
  assert.equal((await f.store.load()).activeAccountId, undefined);
  assert.ok((await f.store.load()).accounts['fixture-account']);
});


test('首次设备自动识别受登录、绑定设备和CSRF保护，广播版本尚不冒充认证缓存', async () => {
  const f = fixture(), guestHeaders = await guest(f);
  assert.equal((await f.request('/api/detect-device', 'POST', { serialNumber: '888FIXTURE' }, guestHeaders)).status, 401);
  const headers = await loggedIn(f);
  assert.equal((await f.request('/api/detect-device', 'POST', { serialNumber: '888FIXTURE' }, { ...headers, origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.request('/api/detect-device', 'POST', { serialNumber: 'OTHER' }, headers)).status, 403);
  assert.equal(f.detections, 0);
  const result = await f.request('/api/detect-device', 'POST', { serialNumber: '888FIXTURE' }, headers);
  assert.equal(result.status, 200); assert.equal(result.json.portVersion, 20); assert.equal(f.detections, 1);
  assert.equal((await f.store.load()).accounts['fixture-account'].devices['888FIXTURE'].verifiedPortVersion, undefined);
});

test('识别过程中退出会取消本机扫描，迟到识别结果不能返回或记忆', async () => {
  const f = fixture(), headers = await loggedIn(f);
  let started!: () => void, release!: () => void, signal: AbortSignal | undefined;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.detector.detectDevice = async (sn, abort) => { signal = abort; started(); await new Promise<void>(resolve => { release = resolve; }); return { serialNumber: sn, portVersion: 20, firmware: 'V123', source: 'native-advertisement' }; };
  const pending = f.request('/api/detect-device', 'POST', { serialNumber: '888FIXTURE' }, headers); await entered;
  await f.request('/api/logout', 'POST', {}, headers); assert.equal(signal?.aborted, true); release();
  const late = await pending; assert.equal(late.status, 409); assert.equal(late.json.error.code, 'OPERATION_CANCELLED');
  assert.equal(late.json.portVersion, undefined);
});

test('连接请求不传初始化选项时也默认自动准备RSA材料', async () => {
  const f = fixture(), headers = await loggedIn(f);
  let automatic: boolean | undefined;
  const prepare = f.client.prepare.bind(f.client);
  f.client.prepare = async (auth, sn, port, allow) => { automatic = allow; return prepare(auth, sn, port, allow); };
  const response = await f.request('/api/prepare-device', 'POST', { serialNumber: '888FIXTURE' }, headers);
  assert.equal(response.status, 200); assert.equal(automatic, true);
});

test('材料正在准备时拒绝重复连接请求，不重复触发云端准备', async () => {
  const f = fixture(), headers = await loggedIn(f);
  let entered!: () => void, release!: () => void, preparations = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const prepare = f.client.prepare.bind(f.client);
  f.client.prepare = async (auth, sn, port, allow) => {
    preparations++; assert.equal(allow, true); entered();
    await new Promise<void>(resolve => { release = resolve; }); return prepare(auth, sn, port, allow);
  };
  const pending = f.request('/api/prepare-device', 'POST', { serialNumber: '888FIXTURE' }, headers); await started;
  const repeated = await f.request('/api/prepare-device', 'POST', { serialNumber: '888FIXTURE' }, headers);
  assert.equal(repeated.status, 409); assert.equal(repeated.json.error.code, 'OPERATION_BUSY');
  assert.equal(preparations, 1); release(); assert.equal((await pending).status, 200);
});
