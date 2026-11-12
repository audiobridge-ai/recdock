import type { Credentials } from './credentials.ts';
import { localConnection } from '../local/connection.ts';

export interface CloudDevice {
  serialNumber: string;
  name: string;
  model?: string;
  portVersion?: number;
  firmware?: string;
  lastConnectedAt?: number;
}
export interface CloudSession {
  authenticated: boolean;
  csrfToken: string;
  account?: { accountId: string; email: string };
  devices?: CloudDevice[];
  offline?: boolean;
  persistence?: { available: boolean; hasSavedAccount: boolean; error?: string };
}
export interface PreparedDevice { credentials: Credentials; device: CloudDevice; source: 'cache' | 'cloud'; portSource: 'verified' | 'cloud' | 'provided' }
export interface OfficialWebSessionInput { userToken: string; userApiDomain: string }

const messages: Record<string, string> = {
  MFA_REQUIRED: '账号需要额外验证，可先在官方 Web 完成登录，再使用“导入官方 Web 登录态”。',
  CAPTCHA_REQUIRED: '账号需要验证码或人机验证，可先在官方 Web 完成登录，再导入本次登录态。',
  KEY_INITIALIZATION_REQUIRED: '设备认证材料暂未就绪，请重试连接。',
  PORT_VERSION_REQUIRED: '暂未获取设备协议版本。请在“设置 / 诊断”中读取广播或填写已确认的版本，再重试连接。',
  SESSION_EXPIRED: '当前授权未通过云端校验，请在官方 Web 重新登录并导出，或重新提交邮箱密码登录。',
  UNAUTHORIZED: '当前授权未通过云端校验，请在官方 Web 重新登录并导出，或重新提交邮箱密码登录。',
  LOCAL_SERVICE_UNAVAILABLE: '本地登录服务未启动或未返回有效响应。请确认开发服务已启动，也可继续手工导入认证材料。',
  LOCAL_SERVICE_UNREACHABLE: '无法连接本地登录服务，请确认开发服务仍在运行后重试。',
  LOCAL_REQUEST_TIMEOUT: '本地登录请求超时，请稍后重新提交。',
  CSRF_REJECTED: '本地服务会话已更新，已恢复新的安全校验。请重试连接或重新提交登录。',
  LOGIN_EXPIRED: '保存的登录已过期，请重新登录一次。已保存的历史录音密钥会继续保留。',
};

export class CloudApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 0, safeMessage?: string) {
    super(messages[code] ?? safeMessage ?? '账号请求未完成，请稍后重试。');
    this.name = 'CloudApiError'; this.code = code; this.status = status;
  }
}

export function parseWebSessionJson(text: string): OfficialWebSessionInput {
  const invalid = () => new CloudApiError('INVALID_SESSION_JSON', 0, '请粘贴官方导出脚本生成的 JSON，仅包含 userToken 和 userApiDomain 两个字段。');
  if (!text.trim() || text.length > 40000) throw invalid();
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw invalid(); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
  const value = data as Record<string, unknown>, keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('userToken') || !keys.includes('userApiDomain') || typeof value.userToken !== 'string' || typeof value.userApiDomain !== 'string') throw invalid();
  const userToken = value.userToken.trim().replace(/^bearer\s+/i, '').trim(), userApiDomain = value.userApiDomain.trim();
  if (!userToken || userToken.length > 8192 || !new RegExp('^[a-z0-9._~+/-]+=*$', 'i').test(userToken) || !/^https:[/]{2}api(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?[.]plaud[.]ai[/]?$/i.test(userApiDomain)) throw invalid();
  return { userToken, userApiDomain };
}

export function parseSuccessfulRequestAuthorization(authorization: string, userApiDomain: string): OfficialWebSessionInput {
  try {
    const value = authorization.trim().replace(/^authorization:\s*/i, '');
    if (/[\r\n]/.test(value)) throw new Error();
    return parseWebSessionJson(JSON.stringify({ userToken: value, userApiDomain }));
  } catch {
    throw new CloudApiError('INVALID_BEARER_IMPORT', 0, '请复制官方成功请求中的 Authorization 值，并填写同一请求的官方 API 域名。');
  }
}

// CSRF 和登录状态只保存在当前页面内存；云端令牌由本地服务会话管理。
export class CloudClient {
  private csrfToken = '';
  private csrfGeneration = 0;
  private sessionRequest?: Promise<CloudSession>;
  private async request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), path === 'detect-device' ? 150000 : path === 'session' || body ? 90000 : 10000);
    const externalAbort = () => abort.abort();
    signal?.addEventListener('abort', externalAbort, { once: true });
    if (signal?.aborted) abort.abort();
    const csrfGeneration = this.csrfGeneration;
    try {
      const response = await localConnection.request(`/api/${path}`, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        headers: body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new CloudApiError('LOCAL_SERVICE_UNAVAILABLE', response.status); }
      const value = data && typeof data === 'object' ? data as Record<string, unknown> : {};
      if (csrfGeneration === this.csrfGeneration && typeof value.csrfToken === 'string') this.csrfToken = value.csrfToken;
      if (!response.ok) {
        const error = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : {};
        const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : response.status === 401 ? 'SESSION_EXPIRED' : response.status === 404 ? 'LOCAL_SERVICE_UNAVAILABLE' : 'REQUEST_FAILED';
        if (code === 'CSRF_REJECTED') {
          this.csrfToken = ''; this.csrfGeneration++;
          // 只恢复安全校验，绝不自动重发密码、导入令牌或可能初始化密钥的 POST。
          if (body) { this.sessionRequest = undefined; await this.session(); }
          throw new CloudApiError('CSRF_REJECTED', response.status);
        }
        // 只使用约定的结构化错误消息；不展示 HTTP 原始响应、HTML 或异常堆栈。
        const message = typeof error.message === 'string' ? error.message.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 240) : undefined;
        throw new CloudApiError(code, response.status, message);
      }
      return data as T;
    } catch (e) {
      if (signal?.aborted) throw new CloudApiError('OPERATION_CANCELLED', 409, '设备识别已取消。');
      if (e instanceof CloudApiError) throw e;
      throw new CloudApiError(abort.signal.aborted ? 'LOCAL_REQUEST_TIMEOUT' : 'LOCAL_SERVICE_UNREACHABLE');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', externalAbort); }
  }
  session(): Promise<CloudSession> {
    if (!this.sessionRequest) {
      const pending: Promise<CloudSession> = this.request<CloudSession>('session').finally(() => { if (this.sessionRequest === pending) this.sessionRequest = undefined; });
      this.sessionRequest = pending;
    }
    return this.sessionRequest;
  }
  async login(email: string, password: string, remember = true) {
    if (!this.csrfToken) await this.session();
    return this.request<CloudSession>('login', { email, password, region: 'auto', remember });
  }
  async importSession(payload: OfficialWebSessionInput, remember = true) {
    const value = parseWebSessionJson(JSON.stringify({ userToken: payload.userToken, userApiDomain: payload.userApiDomain }));
    if (!this.csrfToken) await this.session();
    return this.request<CloudSession>('import-session', { ...value, remember });
  }
  logout(forgetLocalData = false) { return this.request<CloudSession>('logout', { forgetLocalData }); }
  rememberDevice(serialNumber: string, portVersion: number, firmware?: string) {
    return this.request<CloudSession>('device-memory', { serialNumber, portVersion, firmware });
  }
  detectDevice(serialNumber: string, signal: AbortSignal) {
    return this.request<{ serialNumber: string; portVersion: number; firmware: string; source: 'native-advertisement' }>('detect-device', { serialNumber }, signal);
  }
  prepare(serialNumber: string, portVersion?: number, allowKeyInitialization = true) {
    return this.request<PreparedDevice>('prepare-device', { serialNumber, portVersion, allowKeyInitialization });
  }
}
