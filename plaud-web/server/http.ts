import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PlaudCloudClient, CloudError } from './cloud-client.ts';
import type { CloudSession } from './cloud-client.ts';
import { Vault } from './vault.ts';
import type { VaultAccount } from './vault.ts';
import { accountEntry, cachedDevice, compatibleMemory, injectAccountKeys, offlineLifetime, publicDevices, retainKey, savedAccount, withKeyHistory } from './session-memory.ts';
import type { PersistenceStore } from './session-memory.ts';
import { NativeDeviceDiscovery } from './device-discovery.ts';
import type { DeviceDetector } from './device-discovery.ts';
import type { LibraryContext } from './library/http.ts';

interface LocalSession {
  id: string; csrf: string; expires: number; generation: number;
  busy: boolean; auth?: CloudSession; remember: boolean; offline: boolean; restored: boolean; memory?: VaultAccount; detection?: AbortController;
}
type Client = Pick<PlaudCloudClient, 'login' | 'importSession' | 'devices' | 'prepare' | 'restore'>;
const ttl = 60 * 60 * 1000;
const cookieName = 'plaud_local_session';
const secret = () => randomBytes(32).toString('base64url');
const failure = (code: string, message: string, status = 400) => new CloudError(code, message, status);

function sameToken(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw failure('JSON_REQUIRED', '请求需要使用 JSON 格式', 415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024) throw failure('REQUEST_TOO_LARGE', '请求内容过大', 413);
    chunks.push(bytes);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* 不把含密码的原始 JSON 写入错误。 */ }
  throw failure('INVALID_JSON', '请求内容不是有效的 JSON 对象');
}

function allowLocalRequest(req: IncomingMessage) {
  const host = req.headers.host ?? '';
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) throw failure('LOCAL_ONLY', '登录服务仅允许本机访问', 403);
  const remote = req.socket.remoteAddress;
  if (remote && remote !== '::1' && remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1') throw failure('LOCAL_ONLY', '登录服务仅允许本机访问', 403);
  const origin = req.headers.origin;
  if ((origin && origin !== `http://${host}` && origin !== `https://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw failure('ORIGIN_REJECTED', '此登录请求来自其他网站，已拒绝', 403);
  }
}

export function createCloudMiddleware(client: Client = new PlaudCloudClient(), now = Date.now, options: {
  store?: PersistenceStore; detectDevice?: DeviceDetector;
  library?: (req: IncomingMessage, res: ServerResponse, context: LibraryContext) => Promise<void>;
  onAccountGranted?: (accountId: string) => Promise<void>; onAccountRevoked?: (accountId: string) => Promise<void>;
} = {}) {
  const store = options.store ?? new Vault();
  const detectDevice = options.detectDevice ?? new NativeDeviceDiscovery().detect;
  let persistence = { available: true, hasSavedAccount: false, error: undefined as string | undefined };
  let restoreEpoch = 0;
  let restoring: Promise<{ auth: CloudSession; memory: VaultAccount; offline: boolean } | undefined> | undefined;
  const persistenceError = () => { persistence.available = false; persistence.error = '本机受保护缓存不可用，本次可继续使用，但关闭服务后可能需要重新登录。'; };
  async function loadAccount(id: string) {
    try { const data = await store.load(); persistence.available = true; persistence.error = undefined; persistence.hasSavedAccount = !!data.activeAccountId; return savedAccount(data, id); }
    catch { persistenceError(); return; }
  }
  async function save(s: LocalSession, live: () => void, explicitLogin = false) {
    if (!s.auth) return;
    const auth = structuredClone(s.auth), remember = s.remember, savedAt = now();
    try {
      await store.update(draft => {
        live();
        const account = accountEntry(draft, auth);
        if (explicitLogin) {
          for (const a of Object.values(draft.accounts)) { delete a.login; delete a.loginSavedAt; delete a.loginValidUntil; }
          delete draft.activeAccountId;
        }
        account.account = auth.account;
        retainKey(account, auth.rsaCache, savedAt);
        for (const device of auth.devices) if (!['__proto__', 'constructor', 'prototype'].includes(device.serialNumber)) account.devices[device.serialNumber] ??= { device };
        if (remember) {
          account.login = auth; account.loginSavedAt = savedAt;
          // Offline grace does not extend during offline use or token refresh.
          account.loginValidUntil ??= savedAt + offlineLifetime;
          draft.activeAccountId = auth.account.accountId;
        } else {
          delete account.login; delete account.loginSavedAt; delete account.loginValidUntil;
          if (draft.activeAccountId === auth.account.accountId) delete draft.activeAccountId;
        }
      });
      live(); s.memory = await loadAccount(auth.account.accountId);
    } catch (error) { if (error instanceof CloudError) throw error; persistenceError(); }
  }
  async function restoreSaved() {
    if (restoring) return restoring;
    const epoch = restoreEpoch;
    restoring = (async () => {
      try {
        const data = await store.load(); persistence.available = true; persistence.error = undefined; persistence.hasSavedAccount = !!data.activeAccountId;
        const account = data.activeAccountId ? savedAccount(data, data.activeAccountId) : undefined;
        if (!account?.login) return;
        if (!account.loginValidUntil || account.loginValidUntil <= now()) {
          await store.update(draft => { if (epoch !== restoreEpoch) return; const a = savedAccount(draft, account.account.accountId); if (a) delete a.login; delete draft.activeAccountId; });
          persistence.hasSavedAccount = false; return;
        }
        let auth: CloudSession, offline = false;
        const candidate = structuredClone(account.login);
        try { auth = await client.restore(candidate); }
        catch (error) {
          if (error instanceof CloudError && ['CLOUD_NETWORK_ERROR', 'CLOUD_TIMEOUT', 'UPSTREAM_HTTP_ERROR'].includes(error.code)) { auth = candidate; offline = true; }
          else {
            if (error instanceof CloudError && (error.httpStatus === 401 || error.code === 'SESSION_ACCOUNT_MISMATCH')) {
              await store.update(draft => { if (epoch !== restoreEpoch) return; const a = savedAccount(draft, account.account.accountId); if (a) delete a.login; delete draft.activeAccountId; });
              persistence.hasSavedAccount = false;
            }
            return;
          }
        }
        if (epoch !== restoreEpoch) return;
        injectAccountKeys(auth, account);
        await store.update(draft => { if (epoch !== restoreEpoch) return; const a = savedAccount(draft, auth.account.accountId); if (a) { a.login = auth; a.loginSavedAt = now(); } });
        if (epoch !== restoreEpoch) return;
        return { auth, memory: account, offline };
      } catch { persistenceError(); return; }
    })();
    try { return await restoring; } finally { restoring = undefined; }
  }
  const sessions = new Map<string, LocalSession>();
  function current(req: IncomingMessage) {
    for (const [id, s] of sessions) if (s.expires <= now()) sessions.delete(id);
    const cookies = (req.headers.cookie ?? '').split(';').map(part => part.trim().split('='));
    const ids = cookies.filter(([key]) => key === cookieName);
    if (ids.length !== 1) return;
    return sessions.get(ids[0][1]);
  }
  function fresh(res: ServerResponse, auth?: CloudSession) {
    if (sessions.size >= 64) throw failure('SESSION_LIMIT', '本地会话过多，请稍后重试', 429);
    const s: LocalSession = { id: secret(), csrf: secret(), expires: now() + ttl, generation: 0, busy: false, auth, remember: true, offline: false, restored: !!auth };
    sessions.set(s.id, s);
    res.setHeader('Set-Cookie', `${cookieName}=${s.id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=3600`);
    return s;
  }
  function publicSession(s: LocalSession) {
    return { authenticated: !!s.auth, csrfToken: s.csrf, persistence: { ...persistence }, ...(s.auth ? { account: s.auth.account, devices: publicDevices(s.auth, s.memory), offline: s.offline } : {}) };
  }
  function send(res: ServerResponse, status: number, data: unknown) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify(data));
  }
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url ?? '').split('?')[0];
    if (!path.startsWith('/api/')) { next(); return; }
    let session: LocalSession | undefined;
    let acquired: LocalSession | undefined;
    try {
      allowLocalRequest(req);
      session = current(req);
      if (path === '/api/session' && req.method === 'GET') {
        session ??= fresh(res);
        if (!session.auth && !session.restored) {
          session.restored = true;
          const epoch = restoreEpoch;
          const restored = await restoreSaved();
          if (restored && epoch === restoreEpoch && sessions.get(session.id) === session) Object.assign(session, restored, { remember: true });
        }
        session.expires = now() + ttl;
        if (session.auth) await options.onAccountGranted?.(session.auth.account.accountId);
        send(res, 200, publicSession(session)); return;
      }
      if (path.startsWith('/api/library/') && options.library) {
        if (!session && path === '/api/library/context' && req.method === 'GET') session = fresh(res);
        if (!session) throw failure('CSRF_REJECTED', '本地会话已变化，请刷新页面后重试', 403);
        if (!['GET', 'HEAD'].includes(req.method || '') && (typeof req.headers['x-csrf-token'] !== 'string' || !sameToken(req.headers['x-csrf-token'], session.csrf))) throw failure('CSRF_REJECTED', '本地会话已变化，请刷新页面后重试', 403);
        session.expires = now() + ttl;
        await options.library(req, res, { accountId: session.auth?.account.accountId, deviceIds: session.auth?.devices.map(d => d.serialNumber) || [], csrfToken: session.csrf });
        return;
      }
      if (req.method !== 'POST') throw failure('METHOD_NOT_ALLOWED', '此接口仅支持 POST 请求', 405);
      if (!session || typeof req.headers['x-csrf-token'] !== 'string' || !sameToken(req.headers['x-csrf-token'], session.csrf)) {
        throw failure('CSRF_REJECTED', '本地会话已变化，请刷新页面后重试', 403);
      }
      const data = await body(req);
      if (path === '/api/logout') {
        if (data.forgetLocalData !== undefined && typeof data.forgetLocalData !== 'boolean') throw failure('CONSENT_INVALID', '请明确选择是否清除本机数据');
        const accountId = session.auth?.account.accountId;
        restoreEpoch++; session.detection?.abort(); session.generation++; session.auth = undefined; sessions.delete(session.id);
        for (const [id, other] of sessions) if (accountId && other.auth?.account.accountId === accountId) {
          other.detection?.abort(); other.generation++; other.auth = undefined; sessions.delete(id);
        }
        try {
          await store.update(draft => {
            const target = accountId ?? draft.activeAccountId;
            if (target && data.forgetLocalData === true) delete draft.accounts[target];
            else if (accountId) { const a = savedAccount(draft, accountId); if (a) { delete a.login; delete a.loginSavedAt; delete a.loginValidUntil; } }
            // A local logout also stops automatic restoration after a server restart.
            if (draft.activeAccountId) { const a = savedAccount(draft, draft.activeAccountId); if (a) { delete a.login; delete a.loginSavedAt; delete a.loginValidUntil; } }
            delete draft.activeAccountId;
          }); persistence.hasSavedAccount = false;
        } catch { persistenceError(); }
        if (accountId) await options.onAccountRevoked?.(accountId);
        const nextSession = fresh(res); nextSession.restored = true;
        send(res, 200, publicSession(nextSession)); return;
      }
      if (session.busy) throw failure('OPERATION_BUSY', '正在准备账号或设备，请等待当前操作完成', 409);
      session.busy = true; acquired = session;
      const generation = ++session.generation;
      const live = () => {
        if (sessions.get(session!.id) !== session || generation !== session!.generation || session!.expires <= now() || req.aborted) {
          throw failure('OPERATION_CANCELLED', '当前操作已取消，请重新登录或选择设备', 409);
        }
      };
      if (path === '/api/login') {
        const email = typeof data.email === 'string' ? data.email.trim() : '';
        const password = typeof data.password === 'string' ? data.password : '';
        if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length > 4096) {
          throw failure('LOGIN_INPUT_INVALID', '请填写有效的邮箱和 PLAUD 密码');
        }
        if (data.region !== undefined && data.region !== 'auto') throw failure('REGION_UNSUPPORTED', '请选择自动账号区域');
        if (data.remember !== undefined && typeof data.remember !== 'boolean') throw failure('CONSENT_INVALID', '请明确选择是否记住登录');
        const auth = await client.login(email, password, 'auto'); live();
        const memory = await loadAccount(auth.account.accountId); live(); injectAccountKeys(auth, memory);
        if (session.auth && session.auth.account.accountId !== auth.account.accountId && ![...sessions.values()].some(other => other !== session && other.auth?.account.accountId === session!.auth!.account.accountId)) await options.onAccountRevoked?.(session.auth.account.accountId);
        session.auth = auth; session.remember = data.remember !== false; session.memory = memory;
        // A fresh explicit login starts a new bounded offline grace period.
        restoreEpoch++;
        await save(session, live, true); live();
        sessions.delete(session.id);
        const authenticated = fresh(res, auth); authenticated.remember = session.remember; authenticated.memory = session.memory;
        await options.onAccountGranted?.(auth.account.accountId);
        send(res, 200, publicSession(authenticated)); return;
      }
      if (path === '/api/import-session') {
        if (typeof data.userToken !== 'string' || !data.userToken || data.userToken.length > 8192 ||
            typeof data.userApiDomain !== 'string' || !data.userApiDomain || data.userApiDomain.length > 256) {
          throw failure('SESSION_INPUT_INVALID', '请粘贴官方 Web 导出的完整登录态 JSON');
        }
        if (data.remember !== undefined && typeof data.remember !== 'boolean') throw failure('CONSENT_INVALID', '请明确选择是否记住登录');
        const auth = await client.importSession(data.userToken, data.userApiDomain); live();
        const memory = await loadAccount(auth.account.accountId); live(); injectAccountKeys(auth, memory);
        if (session.auth && session.auth.account.accountId !== auth.account.accountId && ![...sessions.values()].some(other => other !== session && other.auth?.account.accountId === session!.auth!.account.accountId)) await options.onAccountRevoked?.(session.auth.account.accountId);
        session.auth = auth; session.remember = data.remember !== false; session.memory = memory;
        // A fresh explicit login starts a new bounded offline grace period.
        restoreEpoch++;
        await save(session, live, true); live();
        sessions.delete(session.id);
        const authenticated = fresh(res, auth); authenticated.remember = session.remember; authenticated.memory = session.memory;
        await options.onAccountGranted?.(auth.account.accountId);
        send(res, 200, publicSession(authenticated)); return;
      }
      if (path === '/api/detect-device') {
        if (!session.auth) throw failure('LOGIN_REQUIRED', '请先登录设备绑定的 PLAUD 账号', 401);
        const serialNumber = typeof data.serialNumber === 'string' ? data.serialNumber : '';
        if (!/^[a-z\d_-]{1,128}$/i.test(serialNumber) || ['__proto__', 'constructor', 'prototype'].includes(serialNumber)) throw failure('DEVICE_REQUIRED', '请选择账号绑定设备');
        if (!session.auth.devices.some(device => device.serialNumber === serialNumber)) throw failure('DEVICE_NOT_BOUND', '所选设备不在当前账号的绑定设备列表中', 403);
        const abort = new AbortController(); session.detection = abort;
        const closed = () => { if (!res.writableFinished) abort.abort(); };
        if (typeof res.once === 'function') res.once('close', closed);
        try {
          const result = await detectDevice(serialNumber, abort.signal); live();
          if (result.serialNumber !== serialNumber || !Number.isInteger(result.portVersion) || result.portVersion < 1 || result.portVersion > 65535 || typeof result.firmware !== 'string' || result.firmware.length > 128) {
            throw failure('DEVICE_DISCOVERY_INVALID', '设备识别结果无效，请重试。', 502);
          }
          session.expires = now() + ttl;
          // A broadcast value is not a successful authentication. Remember only after ready.
          send(res, 200, { serialNumber, portVersion: result.portVersion, firmware: result.firmware, source: 'native-advertisement' }); return;
        } finally {
          abort.abort(); if (session.detection === abort) session.detection = undefined;
          if (typeof res.removeListener === 'function') res.removeListener('close', closed);
        }
      }
      if (path === '/api/prepare-device') {
        if (!session.auth) throw failure('LOGIN_REQUIRED', '请先登录设备绑定的 PLAUD 账号', 401);
        const serialNumber = typeof data.serialNumber === 'string' ? data.serialNumber.trim() : '';
        if (['__proto__', 'constructor', 'prototype'].includes(serialNumber) || !serialNumber || serialNumber.length > 128 || /[\x00-\x1f\x7f]/.test(serialNumber)) throw failure('DEVICE_REQUIRED', '请选择账号绑定设备');
        if (data.portVersion !== undefined && (!Number.isInteger(data.portVersion) || Number(data.portVersion) < 1 || Number(data.portVersion) > 65535)) {
          throw failure('PROTOCOL_INVALID', '协议版本应为 1–65535 的整数');
        }
        if (data.allowKeyInitialization !== undefined && typeof data.allowKeyInitialization !== 'boolean') throw failure('CONSENT_INVALID', '设备材料准备选项无效');
        const device = session.auth.devices.find(row => row.serialNumber === serialNumber);
        if (!device || ['__proto__', 'constructor', 'prototype'].includes(serialNumber)) throw failure('DEVICE_NOT_BOUND', '所选设备不在当前账号的绑定设备列表中', 403);
        const account = session.memory ?? await loadAccount(session.auth.account.accountId); live();
        const cached = cachedDevice(session.auth, account, serialNumber, data.portVersion as number | undefined);
        if (cached) { send(res, 200, cached); return; }
        if (session.offline) throw failure('OFFLINE_MATERIALS_MISSING', '当前无法访问云端，且此设备尚无完整的本机认证材料。请联网后重试。', 503);
        const memory = account?.devices[serialNumber];
        const verifiedPort = compatibleMemory(device, memory) ? memory?.verifiedPortVersion : undefined;
        const port = data.portVersion as number | undefined ?? verifiedPort ?? device.portVersion;
        let result: Awaited<ReturnType<Client['prepare']>>;
        try { result = await client.prepare(session.auth, serialNumber, port, data.allowKeyInitialization !== false); }
        catch (error) {
          // Refresh may rotate tokens before a later preparation step fails.
          live(); await save(session, live); throw error;
        }
        live(); session.expires = now() + ttl;
        try {
          await store.update(draft => {
            live(); const a = accountEntry(draft, session!.auth!);
            retainKey(a, result.credentials.rsa, now());
            const previous = a.devices[serialNumber];
            a.devices[serialNumber] = { ...previous, device: result.device, credentials: result.credentials, preparedAt: now() };
          });
          session.memory = await loadAccount(session.auth.account.accountId); live();
        } catch (error) { if (error instanceof CloudError) throw error; persistenceError(); }
        await save(session, live); live();
        send(res, 200, { ...result, credentials: withKeyHistory(result.credentials, session.memory), source: 'cloud',
          portSource: data.portVersion !== undefined ? 'provided' : verifiedPort ? 'verified' : 'cloud' }); return;
      }
      if (path === '/api/device-memory') {
        if (!session.auth) throw failure('LOGIN_REQUIRED', '请先登录设备绑定的 PLAUD 账号', 401);
        const serialNumber = typeof data.serialNumber === 'string' ? data.serialNumber : '';
        const device = session.auth.devices.find(row => row.serialNumber === serialNumber);
        if (!device || ['__proto__', 'constructor', 'prototype'].includes(serialNumber)) throw failure('DEVICE_NOT_BOUND', '所选设备不在当前账号的绑定设备列表中', 403);
        if (!Number.isInteger(data.portVersion) || Number(data.portVersion) < 1 || Number(data.portVersion) > 65535 ||
          (data.firmware !== undefined && (typeof data.firmware !== 'string' || data.firmware.length > 128))) throw failure('PROTOCOL_INVALID', '设备验证信息格式无效');
        try {
          await store.update(draft => {
            live(); const a = accountEntry(draft, session!.auth!);
            const old = a.devices[serialNumber];
            a.devices[serialNumber] = { ...old, device, verifiedPortVersion: Number(data.portVersion), verifiedFirmware: (data.firmware as string | undefined) ?? device.firmware, verifiedAt: now() };
          });
          session.memory = await loadAccount(session.auth.account.accountId); live();
        } catch (error) { if (error instanceof CloudError) throw error; persistenceError(); }
        send(res, 200, publicSession(session)); return;
      }
      throw failure('API_NOT_FOUND', '未找到此本地接口', 404);
    } catch (error) {
      const safe = error instanceof CloudError ? error : failure('LOCAL_SERVICE_ERROR', '本地登录服务处理失败，请重试', 500);
      if (safe.httpStatus === 401 && session?.auth) { session.offline = true; }
      send(res, safe.httpStatus, { error: { code: safe.code, message: safe.message } });
    } finally { if (acquired) acquired.busy = false; }
  };
}
