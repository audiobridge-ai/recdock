const storageKey = 'recdock.companion.v1';
const defaultEndpoint = 'http://127.0.0.1:43127';
const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
export class CompanionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function companionEndpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !loopback(url.hostname) || url.username || url.password || url.origin !== value) throw new CompanionError('ENDPOINT_INVALID', '助手地址必须是本机 HTTP 地址，不包含路径。');
  return url.origin;
}
export class LocalConnection {
  private token = '';
  private saved = false;
  private persistent = false;
  private address = defaultEndpoint;
  private forceRemote?: boolean;
  constructor(options: { remote?: boolean; endpoint?: string } = {}) { this.forceRemote = options.remote; if (options.endpoint) this.address = companionEndpoint(options.endpoint); }
  get remote() { return this.forceRemote ?? (typeof window !== 'undefined' && (!loopback(window.location.hostname) || new URLSearchParams(window.location.search).get('localHelper') === '1')); }
  get endpoint() { this.restore(); return this.address; }
  get paired() { this.restore(); return !!this.token; }
  private restore() {
    if (this.saved || !this.remote) return; this.saved = true;
    try {
      const value = JSON.parse(window.sessionStorage.getItem(storageKey) || window.localStorage?.getItem(storageKey) || 'null');
      if (value?.protocolVersion === 1 && /^[A-Za-z0-9_-]{43}$/.test(value.token)) { this.address = companionEndpoint(value.endpoint); this.token = value.token; this.persistent = value.persistent === true; }
    } catch { /* Private browser sessions can still pair for this page. */ }
  }
  private save() {
    try {
      window.sessionStorage.removeItem(storageKey); window.localStorage?.removeItem(storageKey);
      if (this.token) (this.persistent ? window.localStorage : window.sessionStorage)?.setItem(storageKey, JSON.stringify({ endpoint: this.address, token: this.token, protocolVersion: 1, persistent: this.persistent }));
    } catch { /* Memory-only connection remains usable. */ }
  }
  setEndpoint(value: string) { const address = companionEndpoint(value); this.restore(); if (this.address !== address) { this.token = ''; this.address = address; this.save(); } }
  apiUrl(path: string) {
    if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#')) throw new CompanionError('PATH_INVALID', '本机接口路径不正确。');
    return this.remote ? new URL(path, this.endpoint).href : path;
  }
  private authorization() {
    this.restore();
    if (!this.token) throw new CompanionError('BRIDGE_AUTH_REQUIRED', '请先连接并配对本地助手。');
    return `Bearer ${this.token}`;
  }
  async request(path: string, init: RequestInit = {}) {
    const url = this.apiUrl(path);
    if (!this.remote) return fetch(url, { ...init, credentials: 'same-origin' });
    const headers = new Headers(init.headers); headers.set('Authorization', this.authorization());
    const response = await fetch(url, { ...init, headers, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (response.status === 401) {
      const value = await response.clone().json().catch(() => undefined);
      if (value?.error?.code === 'BRIDGE_AUTH_REQUIRED') { this.token = ''; this.save(); window.dispatchEvent(new window.Event('recdock:companion-expired')); }
    }
    return response;
  }
  authorizeUpload(request: XMLHttpRequest) { if (this.remote) request.setRequestHeader('Authorization', this.authorization()); }
  private async bridge<T>(path: string, init: RequestInit = {}, authenticated = false): Promise<T> {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set('Authorization', this.authorization());
    let response: Response;
    try { response = await fetch(`${this.endpoint}/bridge/${path}`, { ...init, headers, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000) }); }
    catch { throw new CompanionError('COMPANION_UNREACHABLE', '无法连接本地助手。请确认助手已启动，并允许浏览器访问本机网络；权限被拒绝时可在网站设置中恢复。'); }
    const value = await response.json();
    if (!response.ok) throw new CompanionError(value.error?.code || 'BRIDGE_UNAVAILABLE', value.error?.message || '本地助手连接未完成。');
    return value as T;
  }
  async health() {
    const value = await this.bridge<{ product: string; protocolVersion: number; allowedOrigin: boolean; desktopApproval?: boolean }>('health');
    if (value.product !== 'RecDock' || value.protocolVersion !== 1) throw new CompanionError('COMPANION_VERSION', '本地助手版本不兼容，请更新助手。');
    if (!value.allowedOrigin) throw new CompanionError('ORIGIN_REJECTED', '助手尚未允许当前网站。请按连接说明，将当前网站 origin 加入 RECDOCK_WEB_ORIGINS 后重启助手。');
    return value;
  }
  async pair(code: string) {
    await this.health();
    const result = await this.bridge<{ token: string; protocolVersion: number }>('pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (result.protocolVersion !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(result.token)) throw new CompanionError('COMPANION_VERSION', '助手返回了不兼容的连接信息。');
    this.token = result.token; this.persistent = false; this.save();
  }
  async approve(signal: AbortSignal, onPending: () => void = () => {}) {
    const health = await this.health();
    if (!health.desktopApproval) throw new CompanionError('DESKTOP_REQUIRED', '请先安装并启动 RecDock Mac 助手，或使用备用配对码。');
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const verifier = encode(bytes), challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    signal.throwIfAborted();
    const request = await this.bridge<{ id: string }>('authorization', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge }) });
    onPending();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const result = await this.bridge<{ pending?: boolean; token?: string; protocolVersion?: number }>('authorization/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: request.id, verifier }) });
      signal.throwIfAborted();
      if (!result.pending) {
        if (result.protocolVersion !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(result.token || '')) throw new CompanionError('COMPANION_VERSION', '助手返回了不兼容的授权信息。');
        this.token = result.token!; this.persistent = true; this.save(); return;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new CompanionError('AUTHORIZATION_EXPIRED', '等待授权已超时，请重新连接。');
  }
  async disconnect() {
    // Keep the grant when revocation fails; never report an unconfirmed disconnect.
    if (this.paired) await this.bridge('session', { method: 'DELETE' }, true);
    this.token = ''; this.save();
  }
  async mediaUrl(path: string) {
    if (!this.remote) return this.apiUrl(path);
    this.apiUrl(path);
    const value = await this.bridge<{ url: string }>('media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }, true);
    return this.apiUrl(value.url);
  }
}
export const localConnection = new LocalConnection();
