import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RemoteSessionBinding } from '../http.ts';
import { TrustStore } from './trust.ts';

const minute = 60_000;
const sessionLifetime = 12 * 60 * minute;
const trustedLifetime = 30 * 24 * 60 * minute;
const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface Grant extends RemoteSessionBinding { origin: string; expires: number; createdAt: number; persistent?: boolean }
interface Ticket { grant: Grant; path: string; expires: number }
interface Pending { id: string; origin: string; challenge: string; expires: number; state: 'pending' | 'approved' | 'denied' }
interface DesktopOptions { token: string; trustFile: string; status?: () => Promise<unknown> }
class BridgeError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, message: string, status = 403) { super(message); this.code = code; this.status = status; }
}
const fail = (code: string, message: string, status = 403): never => { throw new BridgeError(code, message, status); };
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function webOrigin(value: string) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== value || url.hostname.includes('*') || url.username || url.password || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) throw new Error('网页来源必须是完整的 HTTPS origin；本机测试可使用 HTTP loopback，不包含路径或通配符。');
  return url.origin;
}
export function mediaPath(value: unknown) {
  if (typeof value !== 'string' || value.length > 1000 || !value.startsWith('/api/library/recordings/') || /[\\#]/.test(value)) fail('MEDIA_PATH_INVALID', '只能授权当前录音的音频、原件或导出文件。', 400);
  const url = new URL(value as string, 'http://localhost');
  if (!/^\/api\/library\/recordings\/[A-Za-z0-9_-]{1,100}\/(?:audio|original|exports\/[A-Za-z0-9_-]{1,100})$/.test(url.pathname)) fail('MEDIA_PATH_INVALID', '文件路径不受支持。', 400);
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !['scope', 'download'].includes(key)) || !['personal', 'account'].includes(url.searchParams.get('scope') || 'personal') || (url.searchParams.has('download') && url.searchParams.get('download') !== '1')) fail('MEDIA_PATH_INVALID', '文件参数不受支持。', 400);
  return url.pathname + url.search;
}
async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail('JSON_REQUIRED', '请求必须使用 JSON。', 415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4096) fail('REQUEST_TOO_LARGE', '请求内容过大。', 413); chunks.push(Buffer.from(chunk)); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* Never echo input. */ }
  return fail('INVALID_JSON', '请求格式不正确。', 400);
}
function json(res: ServerResponse, status: number, value: unknown) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); }

/** No network listeners, filesystem state or application cookies are exposed by this gate. */
export class CompanionBridge {
  readonly origins: Set<string>;
  private grants = new Map<string, Grant>();
  private tickets = new Map<string, Ticket>();
  private verified = new WeakMap<IncomingMessage, Grant>();
  private code = '';
  private codeExpires = 0;
  private attempts = 0;
  private attemptsUntil = 0;
  private now: () => number;
  private pending = new Map<string, Pending>();
  private desktop?: DesktopOptions;
  private trust?: TrustStore;
  private ready: Promise<void>;
  constructor(origins: string[], now = Date.now, desktop?: DesktopOptions) {
    this.now = now;
    this.origins = new Set(origins.map(webOrigin));
    if (desktop && !/^[A-Za-z0-9_-]{43}$/.test(desktop.token)) throw new Error('DESKTOP_CONTROL_INVALID');
    this.desktop = desktop;
    this.trust = desktop ? new TrustStore(desktop.trustFile) : undefined;
    this.ready = this.restore();
    void this.ready.catch(() => {});
    this.renewCode();
  }
  private async restore() {
    for (const saved of await this.trust?.load() || []) {
      if (saved.expires > this.now() && saved.expires <= this.now() + trustedLifetime && this.origins.has(webOrigin(saved.origin))) this.grants.set(saved.tokenHash, { origin: saved.origin, createdAt: saved.createdAt, expires: saved.expires, persistent: true });
    }
  }
  private persist() {
    return this.trust?.save([...this.grants].filter(([, g]) => g.persistent && g.expires > this.now()).map(([tokenHash, g]) => ({ tokenHash, origin: g.origin, createdAt: g.createdAt, expires: g.expires })));
  }
  private async issue(origin: string, persistent: boolean) {
    if (this.grants.size >= 32) fail('PAIR_LIMIT', '连接数量已达上限，请在助手中撤销不用的授权。', 429);
    const token = secret(), key = hash(token), lifetime = persistent ? trustedLifetime : sessionLifetime;
    this.grants.set(key, { origin, createdAt: this.now(), expires: this.now() + lifetime, persistent });
    try { await this.persist(); } catch (error) { this.grants.delete(key); throw error; }
    return { token, protocolVersion: 1, expiresInSeconds: lifetime / 1000, persistent };
  }
  private renewCode() { this.code = String(randomInt(10_000_000, 100_000_000)); this.codeExpires = this.now() + 5 * minute; }
  authorize = (req: IncomingMessage): RemoteSessionBinding | undefined => this.verified.get(req);
  private grant(req: IncomingMessage, origin: string) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization || ''))?.[1];
    const grant = token ? this.grants.get(hash(token)) : undefined;
    if (!grant || grant.origin !== origin || grant.expires <= this.now()) fail('BRIDGE_AUTH_REQUIRED', '本地助手连接已过期，请重新配对。', 401);
    if (!grant!.persistent) grant!.expires = this.now() + sessionLifetime;
    return { token: hash(token!), grant: grant! };
  }
  private prune() {
    for (const [token, grant] of this.grants) if (grant.expires <= this.now()) this.grants.delete(token);
    const active = new Set(this.grants.values());
    for (const [token, ticket] of this.tickets) if (ticket.expires <= this.now() || !active.has(ticket.grant)) this.tickets.delete(token);
    for (const [id, request] of this.pending) if (request.expires <= this.now()) this.pending.delete(id);
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await this.ready;
      const host = req.headers.host || '', remote = req.socket.remoteAddress;
      if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote || '')) fail('LOCAL_ONLY', '助手仅接受本机连接。');
      const url = new URL(req.url || '/', `http://${host}`), origin = req.headers.origin;
      if (origin && (typeof origin !== 'string' || origin === 'null')) fail('ORIGIN_REJECTED', '不接受此网页来源。');
      const external = !!origin && origin !== `http://${host}`;
      const allowed = !!origin && this.origins.has(origin);
      this.prune();
      if (url.pathname.startsWith('/desktop/')) {
        if (!this.desktop || origin || !equal(String(req.headers['x-recdock-control'] || ''), this.desktop.token)) fail('DESKTOP_FORBIDDEN', '此入口仅供本机助手管理。');
        if (url.pathname === '/desktop/status' && req.method === 'GET') {
          json(res, 200, { product: 'RecDock', pending: [...this.pending.values()].filter(p => p.state === 'pending').map(p => ({ id: p.id, origin: p.origin, expires: p.expires })), grants: [...this.grants].filter(([, g]) => g.persistent).map(([id, g]) => ({ id, origin: g.origin, createdAt: g.createdAt, expires: g.expires })), environment: await this.desktop!.status?.() }); return true;
        }
        const value = await body(req);
        if (url.pathname === '/desktop/decision' && req.method === 'POST') {
          const request = this.pending.get(String(value.id));
          if (!request || request.state !== 'pending' || typeof value.approve !== 'boolean') fail('AUTHORIZATION_EXPIRED', '授权请求已失效。', 404);
          request!.state = value.approve ? 'approved' : 'denied'; json(res, 200, { ok: true }); return true;
        }
        if (url.pathname === '/desktop/revoke' && req.method === 'POST') {
          const key = String(value.id), removed = this.grants.get(key);
          this.grants.delete(key);
          try { await this.persist(); } catch (error) { if (removed) this.grants.set(key, removed); throw error; }
          this.prune(); json(res, 200, { ok: true }); return true;
        }
        fail('NOT_FOUND', '未找到此管理入口。', 404);
      }
      if (origin && (allowed || url.pathname === '/bridge/health' && (() => { try { return !!webOrigin(origin); } catch { return false; } })())) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        if (!allowed || !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/bridge/')) fail('ORIGIN_REJECTED', '此网页尚未获得本地助手授权。');
        const headers = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
        if (headers.some(h => !['authorization', 'content-type', 'x-csrf-token', 'range'].includes(h)) || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.headers['access-control-request-method']))) fail('PREFLIGHT_REJECTED', '请求方式不受支持。');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-CSRF-Token, Range');
        res.setHeader('Access-Control-Max-Age', '300');
        res.statusCode = 204; res.end(); return true;
      }
      if (url.pathname === '/bridge/health' && req.method === 'GET') {
        json(res, 200, { product: 'RecDock', protocolVersion: 1, version: '0.2.0', allowedOrigin: !external || allowed, desktopApproval: !!this.desktop }); return true;
      }
      if (url.pathname === '/bridge/authorization' && req.method === 'POST') {
        if (!allowed || !this.desktop) fail('ORIGIN_REJECTED', '请使用助手允许的工作台来源。');
        if (this.pending.size >= 16) fail('AUTHORIZATION_LIMIT', '授权请求过多，请稍后再试。', 429);
        const value = await body(req);
        if (typeof value.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.challenge)) fail('AUTHORIZATION_INVALID', '授权请求格式无效。', 400);
        const request: Pending = { id: secret(), origin: origin!, challenge: value.challenge as string, expires: this.now() + 2 * minute, state: 'pending' };
        this.pending.set(request.id, request); json(res, 201, { id: request.id, expiresInSeconds: 120 }); return true;
      }
      if (url.pathname === '/bridge/authorization/exchange' && req.method === 'POST') {
        if (!allowed || !this.desktop) fail('ORIGIN_REJECTED', '此网页尚未获得本地助手授权。');
        const value = await body(req), request = this.pending.get(String(value.id));
        if (!request || request.origin !== origin) fail('AUTHORIZATION_EXPIRED', '授权请求已过期，请重新连接。', 401);
        if (typeof value.verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.verifier) || !equal(createHash('sha256').update(value.verifier as string).digest('base64url'), request!.challenge)) fail('AUTHORIZATION_INVALID', '授权校验失败。', 401);
        if (request!.state === 'denied') { this.pending.delete(request!.id); fail('AUTHORIZATION_DENIED', '已在本机助手中拒绝此网站。', 403); }
        if (request!.state === 'pending') { json(res, 202, { pending: true }); return true; }
        this.pending.delete(request!.id); json(res, 200, await this.issue(origin!, true)); return true;
      }
      if (url.pathname === '/' && req.method === 'GET' && (!origin || !external)) {
        if (!this.code || this.codeExpires <= this.now()) this.renewCode();
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RecDock 本地助手</title><style>body{font:16px system-ui;margin:64px auto;padding:24px;max-width:680px;color:#263329;background:#f5f6f2}h1{font-size:28px}code{display:block;font:40px monospace;letter-spacing:8px;margin:28px 0;padding:24px;background:white;border-radius:16px}li{overflow-wrap:anywhere;line-height:1.8}p{line-height:1.7}a{color:#276347}</style><h1>RecDock 本地助手正在运行</h1><p>确认下方是你要使用的网站，再将一次性配对码填写到该网站。配对将允许它读取和管理本机录音、转写与设备账号。配对码五分钟内有效，使用后失效。</p><code>${this.code}</code><p>已允许的网页：</p><ul>${[...this.origins].map(o => `<li>${escapeHtml(o)}</li>`).join('') || '<li>尚未配置。启动时设置 RECDOCK_WEB_ORIGINS 为实际网页 origin。</li>'}</ul><p>音频与转写在这台电脑处理和保存。关闭网页不会停止处理；退出助手会暂停任务。</p><a href="/">刷新配对码状态</a></html>`); return true;
      }
      if (url.pathname === '/bridge/pair' && req.method === 'POST') {
        if (!allowed) fail('ORIGIN_REJECTED', '此网页尚未获得本地助手授权。');
        if (this.attemptsUntil <= this.now()) { this.attempts = 0; this.attemptsUntil = this.now() + minute; }
        if (++this.attempts > 5) fail('PAIR_RATE_LIMITED', '配对尝试过多，请一分钟后再试。', 429);
        const value = await body(req);
        if (typeof value.code !== 'string' || !/^\d{8}$/.test(value.code) || !this.code || this.codeExpires <= this.now() || !equal(value.code, this.code)) fail('PAIR_CODE_INVALID', '配对码无效或已过期，请打开助手页面查看。', 401);
        const result = await this.issue(origin!, false); this.code = '';
        json(res, 200, result); return true;
      }
      if (url.pathname === '/bridge/session' && req.method === 'DELETE' || url.pathname === '/bridge/media' && req.method === 'POST') {
        if (!allowed) fail('ORIGIN_REJECTED', '此网页尚未获得本地助手授权。');
        const { token, grant } = this.grant(req, origin!);
        if (url.pathname === '/bridge/session') {
          this.grants.delete(token);
          try { await this.persist(); } catch (error) { this.grants.set(token, grant); throw error; }
          this.prune(); json(res, 200, { disconnected: true }); return true;
        }
        const path = mediaPath((await body(req)).path);
        if (this.tickets.size >= 4096) fail('MEDIA_LIMIT', '文件访问次数过多，请稍后重试。', 429);
        const ticket = secret(); this.tickets.set(ticket, { grant, path, expires: this.now() + sessionLifetime });
        json(res, 200, { url: `${path}${path.includes('?') ? '&' : '?'}bridge_ticket=${ticket}` }); return true;
      }
      if (url.pathname.startsWith('/api/')) {
        if (url.searchParams.has('bridge_ticket')) {
          const ticket = this.tickets.get(url.searchParams.get('bridge_ticket')!);
          url.searchParams.delete('bridge_ticket');
          if (!['GET', 'HEAD'].includes(req.method || '') || !ticket || ticket.path !== url.pathname + url.search || ticket.expires <= this.now() || ticket.grant.expires <= this.now() || origin && origin !== ticket.grant.origin) fail('MEDIA_AUTH_REQUIRED', '文件授权无效或已过期，请重新选择录音。', 401);
          this.verified.set(req, ticket!.grant); req.url = url.pathname + url.search;
        } else if (external) {
          if (!allowed) fail('ORIGIN_REJECTED', '此网页尚未获得本地助手授权。');
          this.verified.set(req, this.grant(req, origin!).grant);
        }
        return false;
      }
      json(res, 404, { error: { code: 'NOT_FOUND', message: '未找到此助手入口。' } }); return true;
    } catch (error) {
      const safe = error instanceof BridgeError ? error : new BridgeError('BRIDGE_UNAVAILABLE', '本地助手请求未完成，请重试。', 500);
      json(res, safe.status, { error: { code: safe.code, message: safe.message } }); return true;
    }
  }
}
