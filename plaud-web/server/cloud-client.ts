import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { emptyCredentials } from '../src/auth/credentials.ts';
import type { Credentials } from '../src/auth/credentials.ts';

export type CloudDevice = { serialNumber: string; name: string; model?: string; portVersion?: number; firmware?: string; lastConnectedAt?: number };
export type CloudSession = {
  userToken: string; userBaseUrl: string;
  refreshToken?: string; utExpireAt?: number; // APK ut_expire_at is an absolute Unix timestamp in seconds.
  account: { accountId: string; email: string }; devices: CloudDevice[];
  workspaceToken?: string; workspaceBaseUrl?: string; workspaceId?: string;
  rsaCache?: Credentials['rsa'];
};
export class CloudError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus = 502) {
    super(message); this.name = 'CloudError'; this.code = code; this.httpStatus = httpStatus;
  }
}

type Json = Record<string, unknown>;
type Scope = 'user' | 'workspace';
type RotatedTokens = { userToken: string; refreshToken: string; utExpireAt?: number; userBaseUrl: string };
type RequestOptions = { scope?: Scope; method?: 'GET' | 'POST'; body?: string; contentType?: string; baseUrl?: string; baseScope?: Scope; headers?: Record<string, string>; authToken?: string; refreshing?: boolean };
const MAX_RESPONSE = 1024 * 1024;
const DEFAULT_BASE = 'https://api.plaud.ai';
const SECURITY_CONFIG_TTL = 5 * 60 * 1000;
const object = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const validPort = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
const validUserToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[a-z\d._~+\/-]+=*$/i.test(value);
const tokenExpiry = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

function officialBase(value: unknown): string {
  if (typeof value !== 'string' || !/^https:\/\/api(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.plaud\.ai\/?$/i.test(value)) {
    throw new CloudError('UNSAFE_API_HOST', '云端返回的区域地址不受支持，已停止请求。');
  }
  return new URL(value).origin;
}

// APK v4.1.0 vfh.b / heh.invoke：官方客户端用于解码响应的公共协议材料。
const RESPONSE_KEY = Buffer.from(['8rRmMC', 'skL3Na', 'UiGr-U', 'smEEeI', '8NKH-Z', 'feGbpR', 'GqSLpuI='].join(''), 'base64url');
function decryptResponse(body: string): string {
  try {
    const clean = body.trim();
    if (!/^[\w=-]+$/.test(clean)) throw new Error();
    const token = Buffer.from(clean, 'base64url');
    if (token.length < 73 || token[0] !== 0x80) throw new Error();
    const signed = token.subarray(0, -32), signature = token.subarray(-32);
    const expected = createHmac('sha256', RESPONSE_KEY.subarray(0, 16)).update(signed).digest();
    if (!timingSafeEqual(expected, signature)) throw new Error();
    const decipher = createDecipheriv('aes-128-cbc', RESPONSE_KEY.subarray(16, 32), token.subarray(9, 25));
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([decipher.update(token.subarray(25, -32)), decipher.final()]));
  } catch { throw new CloudError('ENCRYPTED_RESPONSE_INVALID', '云端加密响应校验失败，已停止处理。'); }
}

async function responseText(response: Response): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE) {
    await response.body?.cancel();
    throw new CloudError('RESPONSE_TOO_LARGE', '云端响应超过允许大小。');
  }
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE) { await reader.cancel(); throw new CloudError('RESPONSE_TOO_LARGE', '云端响应超过允许大小。'); }
      chunks.push(part.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}

async function responseEnvelope(response: Response): Promise<Json> {
  const body = await responseText(response);
  const decoded = response.headers.get('x-encrypt-response') === '1' ? decryptResponse(body) : body;
  let envelope: Json;
  try { envelope = object(JSON.parse(decoded)); } catch { throw new CloudError('INVALID_CLOUD_RESPONSE', '云端响应格式无法识别。'); }
  if (!Object.keys(envelope).length) throw new CloudError('INVALID_CLOUD_RESPONSE', '云端响应格式无法识别。');
  return envelope;
}

function regionTarget(envelope: Json): unknown {
  const data = object(envelope.data), region = object(data.region), domains = object(data.domains);
  const regionDomains = object(data.region_domains);
  return data.api ?? data.api_domain ?? domains.api ?? regionDomains.api ?? region.api ?? object(region.domains).api;
}

function pem(data: Json, plain: string, encoded: string): string {
  const raw = string(data[plain]);
  if (raw.trim()) return raw;
  const base64 = string(data[encoded]).replace(/\s/g, '');
  if (!base64 || !/^(?:[\da-z+/]{4})*(?:[\da-z+/]{2}==|[\da-z+/]{3}=)?$/i.test(base64)) throw new Error();
  return Buffer.from(base64, 'base64').toString('utf8');
}
function rsaPair(data: Json): Pick<Credentials['rsa'], 'publicKeyPem' | 'privateKeyPem'> {
  try {
    const publicKeyPem = pem(data, 'public_key', 'public_key_base64');
    const privateKeyPem = pem(data, 'private_key', 'private_key_base64');
    const publicKey = createPublicKey(publicKeyPem), privateKey = createPrivateKey(privateKeyPem);
    if (publicKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyType !== 'rsa') throw new Error();
    const given = publicKey.export({ type: 'spki', format: 'der' });
    const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    if (given.length !== derived.length || !timingSafeEqual(given, derived)) throw new Error();
    return { publicKeyPem, privateKeyPem };
  } catch { throw new CloudError('RSA_KEYS_INVALID', 'RSA 密钥材料无效或公私钥不匹配。', 409); }
}

function validSignature(value: unknown): string {
  const encoded = string(value).replace(/\s/g, '');
  if (!encoded) throw new CloudError('SN_SIGNATURE_MISSING', '云端未返回所选设备的认证签名。', 409);
  const bytes = Buffer.from(encoded, 'base64');
  if (!/^[a-z\d+/]+={0,2}$/i.test(encoded) || encoded.length % 4 === 1 ||
      (encoded.includes('=') && encoded.length % 4 !== 0) ||
      bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '') ||
      !bytes.length || bytes.length > 25500) {
    throw new CloudError('SN_SIGNATURE_INVALID', '云端设备认证签名格式或长度无效。', 409);
  }
  return bytes.toString('base64');
}

// 登录密码使用 secp256k1；设备 BLE 的 ECC 握手使用另一条曲线 P-256。
function encryptPassword(password: string, serverPublicKey: Uint8Array): string {
  const ephemeralPrivateKey = secp256k1.utils.randomSecretKey();
  try {
    const ephemeralPublicKey = secp256k1.getPublicKey(ephemeralPrivateKey, false);
    // App KDF 输入包含完整的非压缩共享点，不能替换为 Node ECDH 的 32 字节 X 坐标。
    const sharedPoint = secp256k1.getSharedSecret(ephemeralPrivateKey, serverPublicKey, false);
    const key = Buffer.from(hkdfSync('sha256', Buffer.concat([ephemeralPublicKey, sharedPoint]), Buffer.alloc(0), Buffer.alloc(0), 32));
    try {
      const iv = randomBytes(16), cipher = createCipheriv('aes-256-gcm', key, iv);
      const plaintext = JSON.stringify({ pass: password, time: Math.floor(Date.now() / 1000) });
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([ephemeralPublicKey, iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    } finally { key.fill(0); }
  } catch {
    throw new CloudError('PASSWORD_ENCRYPTION_FAILED', '无法完成官方密码封装，请稍后重试。');
  } finally { ephemeralPrivateKey.fill(0); }
}

export class PlaudCloudClient {
  private fetchImpl: typeof fetch;
  private securityConfigs = new Map<string, { expiresAt: number; publicKey: Uint8Array }>();
  private refreshes = new Map<string, Promise<RotatedTokens>>();
  private proactiveAttempts = new WeakMap<CloudSession, number>();
  constructor(fetchImpl: typeof fetch = fetch) { this.fetchImpl = fetchImpl; }

  private async request(session: CloudSession, path: string, options: RequestOptions = {}): Promise<Json> {
    const userScope = (options.scope ?? 'user') === 'user';
    const replayable = userScope && (options.method ?? 'GET') === 'GET';
    if (replayable && session.userToken) await this.refreshIfNeeded(session);
    const usedToken = session.userToken;
    try { return await this.requestOnce(session, path, options); }
    catch (error) {
      if (!(error instanceof CloudError) || error.code !== 'SESSION_EXPIRED') throw error;
      if (!userScope) {
        // A failed WT must never trigger a UT refresh or a blind gen_key replay.
        session.workspaceToken = undefined;
        throw new CloudError('WORKSPACE_SESSION_EXPIRED', '个人工作区授权已过期，请重试准备以重新取得授权。', 409);
      }
      if (!replayable || !session.refreshToken) throw error;
      // A concurrent GET may already have rotated the pair while this old-bearer request was in flight.
      if (session.userToken === usedToken) await this.refreshUserToken(session);
      return this.requestOnce(session, path, options); // Exactly one replay; no recursive refresh.
    }
  }

  private async requestOnce(session: CloudSession, path: string, options: RequestOptions = {}): Promise<Json> {
    const scope = options.scope ?? 'user', baseScope = options.baseScope ?? scope;
    if (scope === 'workspace' && !session.workspaceToken) throw new CloudError('WORKSPACE_REQUIRED', '尚未取得个人工作区授权。', 409);
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\]/.test(path)) throw new CloudError('INVALID_REQUEST', '云端请求路径无效。', 400);
    let base = officialBase(options.baseUrl ?? (baseScope === 'workspace' ? session.workspaceBaseUrl : session.userBaseUrl));
    for (let attempt = 0; attempt < 2; attempt++) {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const token = options.authToken ?? (scope === 'workspace' ? session.workspaceToken : session.userToken);
        const headers: Record<string, string> = {
          Accept: 'application/json', 'app-platform': 'android', 'edit-from': 'android',
          'app-version': '4.1.0 (1289)', 'app-versionNumber': '4.1.0', 'app-buildNumber': '1289',
          'app-language': 'zh-CN', 'User-Agent': 'PLAUD-Web-Local/0.1.0', 'X-Encrypt-Response': '1', 'app-refresh-token-flag': '1',
          ...options.headers,
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (options.contentType) headers['Content-Type'] = options.contentType;
        const pending = (async () => {
          const response = await this.fetchImpl(base + path, { method: options.method ?? 'GET', headers, body: options.body, signal: abort.signal, redirect: 'manual' });
          if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new CloudError('HTTP_REDIRECT_BLOCKED', '云端返回了不允许自动跟随的跳转。'); }
          if (response.status === 401) { await response.body?.cancel(); throw new CloudError('SESSION_EXPIRED', '云端未接受当前登录凭据（HTTP 401），请重新登录或导入当前网页登录态。', 401); }
          if (response.status === 403) {
            const html = response.headers.get('content-type')?.includes('text/html');
            await response.body?.cancel();
            throw new CloudError('UPSTREAM_ACCESS_DENIED', html
              ? 'PLAUD 云端返回了 HTTP 403 网页拦截，请检查网络或稍后重试；这不是 localhost 跨域错误。'
              : 'PLAUD 云端拒绝了此请求（HTTP 403），请确认当前账号授权和网络。');
          }
          if (response.status === 409 && options.refreshing) {
            const rejected = await responseEnvelope(response);
            if (rejected.status === -4302) throw new CloudError('TOKEN_REFRESH_CONFLICT', '云端令牌续期发生冲突，请稍后重试。', 409);
            throw new CloudError('CLOUD_REQUEST_REJECTED', '云端未接受令牌续期请求。', 409);
          }
          if (!response.ok) { await response.body?.cancel(); throw new CloudError('UPSTREAM_HTTP_ERROR', '云端请求未成功，请稍后重试。'); }
          return responseEnvelope(response);
        })();
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new CloudError('CLOUD_TIMEOUT', '云端请求超时，请稍后重试。', 504)); }, 15000); });
        const envelope = await Promise.race([pending, timeout]);
        if (envelope.status === -302) {
          if (attempt) throw new CloudError('REGION_REDIRECT_LIMIT', '云端区域切换次数超过允许范围。');
          base = officialBase(regionTarget(envelope));
          if (baseScope === 'workspace') session.workspaceBaseUrl = base; else session.userBaseUrl = base;
          continue;
        }
        if (envelope.status === 10001) throw new CloudError('MFA_REQUIRED', '该账号需要额外验证，请先在 PLAUD 官方应用中完成验证。', 409);
        if (envelope.status !== undefined && envelope.status !== null && envelope.status !== 0) {
          const status = typeof envelope.status === 'number' && Number.isSafeInteger(envelope.status) ? `（状态码 ${envelope.status}）` : '';
          throw new CloudError('CLOUD_REQUEST_REJECTED', `云端未接受请求${status}。`, 409);
        }
        return envelope;
      } catch (error) {
        if (error instanceof CloudError) throw error;
        throw new CloudError('CLOUD_NETWORK_ERROR', '无法完成云端请求，请检查网络后重试。');
      } finally { clearTimeout(timer); }
    }
    throw new CloudError('REGION_REDIRECT_LIMIT', '云端区域切换次数超过允许范围。');
  }

  private async refreshIfNeeded(session: CloudSession): Promise<void> {
    if (session.refreshToken && this.refreshes.has(session.refreshToken)) return this.refreshUserToken(session);
    if (!session.refreshToken || session.utExpireAt === undefined || session.utExpireAt > Math.floor(Date.now() / 1000) + 300) return;
    const now = Date.now(), last = this.proactiveAttempts.get(session);
    if (last !== undefined && now - last < 60000) return;
    this.proactiveAttempts.set(session, now);
    await this.refreshUserToken(session);
  }

  async refreshUserToken(session: CloudSession): Promise<void> {
    const refreshToken = session.refreshToken;
    if (!refreshToken) throw new CloudError('SESSION_EXPIRED', '当前登录态没有续期凭据，请重新登录或导入当前网页登录态。', 401);
    if (!validUserToken(refreshToken)) throw new CloudError('SESSION_INPUT_INVALID', '保存的续期凭据格式无效，请重新登录。', 400);
    let refresh = this.refreshes.get(refreshToken);
    if (!refresh) {
      refresh = this.rotateUserToken(session, refreshToken);
      this.refreshes.set(refreshToken, refresh);
    }
    try {
      const pair = await refresh;
      if (session.refreshToken !== refreshToken) {
        if (session.refreshToken === pair.refreshToken && session.userToken === pair.userToken) return;
        throw new CloudError('SESSION_CHANGED', '登录会话已改变，请重新尝试。', 409);
      }
      // No await between writes: callers persist the whole resulting pair together, even after a later operation fails.
      session.userToken = pair.userToken; session.refreshToken = pair.refreshToken;
      session.utExpireAt = pair.utExpireAt; session.userBaseUrl = pair.userBaseUrl;
      this.proactiveAttempts.set(session, Date.now());
    } catch (error) {
      if (session.refreshToken !== refreshToken) throw new CloudError('SESSION_CHANGED', '登录会话已改变，请重新尝试。', 409);
      throw error;
    } finally { if (this.refreshes.get(refreshToken) === refresh) this.refreshes.delete(refreshToken); }
  }

  private async rotateUserToken(session: CloudSession, refreshToken: string): Promise<RotatedTokens> {
    // Regional routing during a shared refresh must not mutate one caller before the pair has been validated.
    const context = { ...session };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // l8d + ueh: the refresh bearer is RT; no JSON fields, form fields or internal override header go on the wire.
        const pair = await this.requestOnce(context, '/auth/refresh-user-token', {
          method: 'POST', body: '', contentType: 'application/json', authToken: refreshToken, refreshing: true,
        });
        const userToken = string(pair.access_token), nextRefresh = string(pair.refresh_token);
        if (!validUserToken(userToken) || !validUserToken(nextRefresh)) throw new CloudError('REFRESH_TOKEN_PAIR_INVALID', '云端未返回完整的续期凭据，已保留原登录材料。', 409);
        return { userToken, refreshToken: nextRefresh, utExpireAt: tokenExpiry(pair.ut_expire_at), userBaseUrl: context.userBaseUrl };
      } catch (error) {
        if (!(error instanceof CloudError) || error.code !== 'TOKEN_REFRESH_CONFLICT' || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new CloudError('TOKEN_REFRESH_CONFLICT', '云端令牌续期发生冲突，请稍后重试。', 409);
  }

  private async loginPassword(session: CloudSession, password: string): Promise<{ value: string; encrypted: boolean }> {
    const base = officialBase(session.userBaseUrl), cached = this.securityConfigs.get(base);
    let publicKey = cached && cached.expiresAt > Date.now() ? cached.publicKey : undefined;
    if (!publicKey) {
      let configuration: Json;
      try { configuration = await this.request(session, '/config/security'); }
      catch (error) {
        // 配置临时不可用时遵循 App 的 HTTPS 表单回退；校验失败或不安全跳转不能降级。
        if (!(error instanceof CloudError) || ![
          'UPSTREAM_HTTP_ERROR', 'CLOUD_NETWORK_ERROR', 'CLOUD_TIMEOUT',
          'INVALID_CLOUD_RESPONSE', 'CLOUD_REQUEST_REJECTED', 'RESPONSE_TOO_LARGE',
        ].includes(error.code)) throw error;
        return { value: password, encrypted: false };
      }
      const data = object(configuration.data), encoded = string(data.pass_pub_key);
      if (data.pass_algorithm !== 'secp256k1' || !/^(?:02[\da-f]{64}|03[\da-f]{64}|04[\da-f]{128})$/i.test(encoded)) return { value: password, encrypted: false };
      try {
        publicKey = Buffer.from(encoded, 'hex');
        secp256k1.Point.fromBytes(publicKey).assertValidity();
      } catch { return { value: password, encrypted: false }; }
      this.securityConfigs.set(officialBase(session.userBaseUrl), { expiresAt: Date.now() + SECURITY_CONFIG_TTL, publicKey });
    }
    return { value: encryptPassword(password, publicKey), encrypted: true };
  }

  async login(email: string, password: string, region = 'auto'): Promise<CloudSession> {
    if (region !== 'auto') throw new CloudError('UNSUPPORTED_REGION', '当前仅支持自动识别官方账号区域。', 400);
    if (!email.trim() || !password || email.length > 320 || password.length > 4096) throw new CloudError('LOGIN_INPUT_INVALID', '请填写有效的邮箱和密码。', 400);
    const session: CloudSession = { userToken: '', userBaseUrl: DEFAULT_BASE, account: { accountId: '', email: email.trim() }, devices: [] };
    const loginPassword = await this.loginPassword(session, password);
    const body = new URLSearchParams({ username: email.trim(), password: loginPassword.value, password_encrypted: String(loginPassword.encrypted), client_id: 'android' });
    const login = await this.request(session, '/auth/access-token', { method: 'POST', body: body.toString(), contentType: 'application/x-www-form-urlencoded' });
    session.userToken = string(login.access_token);
    if (!validUserToken(session.userToken)) throw new CloudError('LOGIN_TOKEN_MISSING', '云端未返回有效登录凭据，登录未完成。', 401);
    if (login.refresh_token !== undefined && login.refresh_token !== null && login.refresh_token !== '') {
      if (!validUserToken(login.refresh_token)) throw new CloudError('SESSION_INPUT_INVALID', '云端返回的续期凭据格式无效，登录未完成。', 409);
      session.refreshToken = login.refresh_token;
    }
    session.utExpireAt = tokenExpiry(login.ut_expire_at);
    const profile = await this.request(session, '/user-app/profile/account/me?setting&passport');
    const accountId = string(object(object(profile.data).basic).user_id);
    if (!accountId.trim()) throw new CloudError('ACCOUNT_ID_MISSING', '云端未返回账号标识，登录未完成。', 409);
    session.account.accountId = accountId;
    await this.devices(session);
    return session;
  }

  async importSession(userToken: string, userApiDomain: string): Promise<CloudSession> {
    // 官方 Web 的存储可能已经带有大小写不固定的 bearer 前缀，发送时只能添加一次。
    const token = typeof userToken === 'string' ? userToken.trim().replace(/^bearer\s+/i, '').trim() : '';
    if (!validUserToken(token)) throw new CloudError('SESSION_INPUT_INVALID', '网页登录态中的用户令牌格式无效，请重新导出。', 400);
    const session: CloudSession = {
      userToken: token, userBaseUrl: officialBase(userApiDomain),
      account: { accountId: '', email: '' }, devices: [],
    };
    const profile = await this.request(session, '/user-app/profile/account/me?setting&passport');
    const data = object(profile.data), basic = object(data.basic), accountId = string(basic.user_id);
    if (!accountId.trim()) throw new CloudError('ACCOUNT_ID_MISSING', '该网页登录态未通过 APP 账号身份校验，导入未完成。', 409);
    session.account = { accountId, email: string(object(data.passport).email) || string(basic.email) };
    await this.devices(session);
    return session;
  }

  async restore(saved: CloudSession): Promise<CloudSession> {
    if (!validUserToken(saved.userToken) || !string(saved.account?.accountId).trim() ||
      (saved.refreshToken !== undefined && !validUserToken(saved.refreshToken))) {
      throw new CloudError('SESSION_INPUT_INVALID', '保存的账号登录材料不完整，请重新登录。', 400);
    }
    officialBase(saved.userBaseUrl);
    if (saved.workspaceBaseUrl) officialBase(saved.workspaceBaseUrl);
    const expectedAccountId = saved.account.accountId;
    // Refresh in place so a rotated pair remains available to the vault even if later validation hits a network failure.
    await this.refreshIfNeeded(saved);
    const profile = await this.request(saved, '/user-app/profile/account/me?setting&passport');
    const data = object(profile.data), basic = object(data.basic), accountId = string(basic.user_id);
    if (!accountId.trim()) throw new CloudError('ACCOUNT_ID_MISSING', '保存的登录态未通过账号身份校验。', 409);
    if (accountId !== expectedAccountId) throw new CloudError('SESSION_ACCOUNT_MISMATCH', '保存的登录态与当前账号不一致，请重新登录。', 409);
    if (saved.rsaCache) rsaPair({ public_key: saved.rsaCache.publicKeyPem, private_key: saved.rsaCache.privateKeyPem });
    await this.devices(saved);
    saved.account = { accountId, email: string(object(data.passport).email) || string(basic.email) || saved.account.email };
    // A persisted WT has no known expiry here. Mint a fresh WT lazily if key preparation actually requires one.
    saved.workspaceToken = undefined;
    return saved;
  }

  async devices(session: CloudSession): Promise<CloudDevice[]> {
    const envelope = await this.request(session, '/device-app/device/list');
    if (!Array.isArray(envelope.data_devices)) throw new CloudError('DEVICE_LIST_INVALID', '云端设备列表格式无法识别。');
    const devices: CloudDevice[] = [];
    for (const item of envelope.data_devices) {
      const row = object(item), serialNumber = string(row.sn);
      if (!serialNumber || !/^[a-z\d_-]{1,128}$/i.test(serialNumber)) continue;
      const model = string(row.model), portVersion = validPort(row.prot_version) ? row.prot_version : undefined;
      const firmware = typeof row.version_number === 'number' || typeof row.version_number === 'string' ? String(row.version_number) : undefined;
      const lastConnectedAt = session.devices.find(device => device.serialNumber === serialNumber)?.lastConnectedAt;
      devices.push({ serialNumber, name: string(row.name) || model || 'PLAUD 设备', ...(model ? { model } : {}), ...(portVersion ? { portVersion } : {}), ...(firmware ? { firmware } : {}),
        ...(typeof lastConnectedAt === 'number' && Number.isFinite(lastConnectedAt) && lastConnectedAt > 0 ? { lastConnectedAt } : {}) });
    }
    session.devices = devices;
    return devices;
  }

  private async ensureWorkspace(session: CloudSession): Promise<void> {
    if (session.workspaceToken && session.workspaceBaseUrl) { officialBase(session.workspaceBaseUrl); return; }
    const envelope = await this.request(session, '/team-app/workspaces/list?need_personal_workspace=true&include_details=true');
    const data = envelope.data, rows = Array.isArray(data) ? data : object(data).workspaces ?? object(data).list ?? object(data).items ?? object(data).records;
    if (!Array.isArray(rows)) throw new CloudError('WORKSPACE_REQUIRED', '云端未返回可用的个人工作区。', 409);
    const personal = rows.map(object).find(row => {
      const type = row.workspace_type, namedType = string(row.type).toUpperCase();
      if (namedType === 'TEAM' || string(type).toUpperCase() === 'TEAM') return false;
      if (typeof type === 'number' && Number.isInteger(type)) return type !== 1;
      if (typeof type === 'string' && /^\d+$/.test(type)) return Number(type) !== 1;
      return string(type).toUpperCase() === 'PERSONAL' || namedType === 'PERSONAL';
    });
    if (!personal) throw new CloudError('WORKSPACE_SELECTION_REQUIRED', '当前账号没有可自动选择的个人工作区，请先在官方应用中确认工作区。', 409);
    const id = string(personal.workspace_id) || string(personal.id);
    if (!id || id.length > 128 || /[\r\n]/.test(id)) throw new CloudError('WORKSPACE_REQUIRED', '云端未返回有效工作区标识。', 409);
    const domain = string(personal.api_domain).trim() || string(object(personal.domains).api).trim();
    session.workspaceBaseUrl = domain ? officialBase(domain.includes('://') ? domain : `https://${domain}`) : session.userBaseUrl;
    const grant = await this.request(session, `/user-app/auth/workspace/token/${encodeURIComponent(id)}`, { method: 'POST', scope: 'user', baseScope: 'workspace', baseUrl: session.workspaceBaseUrl, headers: { 'X-Region-Workspace-Id': id } });
    const token = string(object(grant.data).workspace_token) || string(object(grant.data).access_token);
    if (!token.trim() || !string(object(grant.data).refresh_token).trim()) throw new CloudError('WORKSPACE_REQUIRED', '云端未返回完整工作区授权，无法准备设备密钥。', 409);
    session.workspaceToken = token; session.workspaceId = id;
  }

  async prepare(session: CloudSession, serialNumber: string, portVersion?: number, allowKeyInitialization = true): Promise<{ credentials: Credentials; device: CloudDevice }> {
    await this.refreshIfNeeded(session);
    await this.devices(session);
    const device = session.devices.find(item => item.serialNumber === serialNumber);
    if (!device) throw new CloudError('DEVICE_NOT_BOUND', '所选设备不在当前账号的绑定设备列表中。', 403);
    const port = portVersion ?? device.portVersion;
    if (!validPort(port)) throw new CloudError('PORT_VERSION_REQUIRED', '尚未取得设备实际协议版本，请先读取广播或填写协议版本。', 409);
    if (port === 30) throw new CloudError('UNSUPPORTED_AUTO_ECC', '当前自动准备仅支持传统协议和 RSA 设备；ECC 请使用高级手工认证。', 409);
    const credentials = emptyCredentials();
    credentials.accountId = session.account.accountId; credentials.serialNumber = device.serialNumber; credentials.portVersion = port;
    if (port !== 20) return { credentials, device };
    const cached = session.rsaCache?.publicKeyPem.trim() && session.rsaCache.privateKeyPem.trim();
    if (!cached && !allowKeyInitialization) throw new CloudError('KEY_INITIALIZATION_REQUIRED', '此请求仅复用已有材料，当前没有可用的 RSA 缓存。', 409);
    const signatures = await this.request(session, '/device-app/device/sn-sign', { method: 'POST', contentType: 'application/json', body: JSON.stringify({ sns: [serialNumber] }) });
    const snSignature = validSignature(object(object(signatures.data).signature)[serialNumber]);
    let pair: Pick<Credentials['rsa'], 'publicKeyPem' | 'privateKeyPem'>;
    if (cached) pair = rsaPair({ public_key: session.rsaCache!.publicKeyPem, private_key: session.rsaCache!.privateKeyPem });
    else {
      await this.ensureWorkspace(session);
      const keys = await this.request(session, '/device-app/e2ee/gen_key', { method: 'POST', scope: 'workspace', contentType: 'application/json', body: '{}' });
      pair = rsaPair(object(keys.data));
    }
    credentials.rsa = { ...pair, snSignature, alternateCommand: false };
    session.rsaCache = { ...credentials.rsa };
    return { credentials, device };
  }
}
