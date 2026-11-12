import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionBridge, mediaPath, webOrigin } from '../server/companion/bridge.ts';
import { createCloudMiddleware } from '../server/http.ts';
import { createApplication } from '../server/application.ts';
import { middlewareRequest } from './helpers/middleware.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AudioTranscript } from '../src/library/types.ts';

const origin = 'https://recdock.example';
function setup() {
  let clock = 1000;
  const bridge = new CompanionBridge([origin, 'http://localhost:4173'], () => clock);
  const cloud = createCloudMiddleware(undefined, () => clock, {
    authorizeRemote: bridge.authorize,
    store: { load: async () => ({ version: 1, accounts: {} }), update: async () => {} },
    library: async (req, res, context) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: req.url, method: req.method, csrfToken: context.csrfToken, range: req.headers.range })); },
  });
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => { if (!await bridge.handle(req, res)) await cloud(req, res, next); };
  const request = (path: string, method = 'GET', value?: unknown, extra: Record<string, string> = {}) => middlewareRequest(handler, path, method, value === undefined ? undefined : Buffer.from(JSON.stringify(value)), { origin, 'content-type': 'application/json', ...extra });
  async function pair() {
    const portal = await request('/', 'GET', undefined, { origin: '' });
    const code = /<code>(\d{8})<\/code>/.exec(portal.raw.toString())![1];
    const response = await request('/bridge/pair', 'POST', { code });
    assert.equal(response.status, 200);
    return { token: response.json.token as string, authorization: `Bearer ${response.json.token}`, code };
  }
  return { bridge, handler, request, pair, advance(ms: number) { clock += ms; } };
}

test('网页来源仅允许明确的安全 origin，媒体授权不能扩展到任意 API 或网络地址', () => {
  for (const value of [origin, 'http://localhost:4173', 'http://127.0.0.1:5173']) assert.equal(webOrigin(value), value);
  for (const value of ['https://*.example', 'http://evil.example', 'https://example.com/', 'https://user:pass@example.com', 'null', 'https://example.com/path']) assert.throws(() => webOrigin(value));
  assert.equal(mediaPath('/api/library/recordings/rec_test/audio?scope=personal'), '/api/library/recordings/rec_test/audio?scope=personal');
  for (const value of ['/api/session', '//evil.example/audio', '/api/library/recordings/../session', '/api/library/recordings/rec_test/audio?scope=personal&scope=account', '/api/library/recordings/rec_test/audio?bridge_ticket=secret', '/api/library/recordings/rec_test/audio#fragment', '/api/library/recordings/rec_test/exports/../../context']) assert.throws(() => mediaPath(value));
});

test('健康检查不泄露路径或配对码；配对页面禁止嵌入且不提供跨站读取', async () => {
  const f = setup();
  const health = await f.request('/bridge/health', 'GET', undefined, { origin: 'https://other.example' });
  assert.equal(health.status, 200); assert.equal(health.json.allowedOrigin, false);
  assert.deepEqual(Object.keys(health.json).sort(), ['allowedOrigin', 'desktopApproval', 'product', 'protocolVersion', 'version']);
  const portal = await f.request('/', 'GET', undefined, { origin: '' });
  assert.match(portal.raw.toString(), /<code>\d{8}<\/code>/); assert.equal(portal.headers.get('x-frame-options'), 'DENY');
  const cross = await f.request('/'); assert.doesNotMatch(cross.raw.toString(), /<code>/);
  const rebound = await f.request('/bridge/health', 'GET', undefined, { host: 'evil.example:43127' }); assert.equal(rebound.status, 403);
});

test('跨源预检允许必要的上传、CSRF、Range 头，未授权来源和任意头被拒绝', async () => {
  const f = setup();
  const headers = { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type,x-csrf-token' };
  const response = await f.request('/api/library/imports/imp_test/content', 'OPTIONS', undefined, headers);
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal((await f.request('/api/session', 'OPTIONS', undefined, { ...headers, origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/session', 'OPTIONS', undefined, { ...headers, 'access-control-request-headers': 'x-untrusted' })).status, 403);
});

test('一次性配对不能重放；令牌绑定网站并禁止 cookie 回退和无 CSRF 修改', async () => {
  const f = setup(), grant = await f.pair();
  assert.equal((await f.request('/bridge/pair', 'POST', { code: grant.code })).status, 401);
  const context = await f.request('/api/library/context?scope=personal', 'GET', undefined, { authorization: grant.authorization });
  assert.equal(context.status, 200); assert.equal(context.headers.get('set-cookie'), null);
  assert.equal((await f.request('/api/library/context', 'GET')).status, 401);
  assert.equal((await f.request('/api/library/context', 'GET', undefined, { authorization: grant.authorization, origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/library/context', 'GET', undefined, { authorization: grant.authorization, origin: 'http://localhost:4173' })).status, 401);
  assert.equal((await f.request('/api/library/recordings', 'POST', {}, { authorization: grant.authorization })).status, 403);
  const saved = await f.request('/api/library/recordings', 'POST', {}, { authorization: grant.authorization, 'x-csrf-token': context.json.csrfToken }); assert.equal(saved.status, 200);
  const logout = await f.request('/api/logout', 'POST', {}, { authorization: grant.authorization, 'x-csrf-token': context.json.csrfToken }); assert.equal(logout.status, 200);
  assert.notEqual(logout.json.csrfToken, context.json.csrfToken); assert.equal(logout.headers.get('set-cookie'), null);
  assert.equal((await f.request('/api/library/recordings', 'POST', {}, { authorization: grant.authorization, 'x-csrf-token': context.json.csrfToken })).status, 403);
});

test('配对码过期与暴力尝试受到限制，助手重启后旧令牌失效', async () => {
  const f = setup();
  const portal = await f.request('/', 'GET', undefined, { origin: '' }); const code = /<code>(\d{8})<\/code>/.exec(portal.raw.toString())![1];
  f.advance(300_001); assert.equal((await f.request('/bridge/pair', 'POST', { code })).status, 401);
  for (let i = 0; i < 4; i++) assert.equal((await f.request('/bridge/pair', 'POST', { code: '00000000' })).status, 401);
  assert.equal((await f.request('/bridge/pair', 'POST', { code: '00000000' })).status, 429);
  f.advance(60_001); const grant = await f.pair();
  const restarted = setup(); assert.equal((await restarted.request('/api/session', 'GET', undefined, { authorization: grant.authorization })).status, 401);
  f.advance(12 * 60 * 60_000 + 1); assert.equal((await f.request('/api/session', 'GET', undefined, { authorization: grant.authorization })).status, 401);
});

test('媒体凭据只授权单个资源的 GET/HEAD 和 Range，断开后立即撤销', async () => {
  const f = setup(), grant = await f.pair(), headers = { authorization: grant.authorization };
  await f.request('/api/library/context', 'GET', undefined, headers);
  const media = await f.request('/bridge/media', 'POST', { path: '/api/library/recordings/rec_test/audio?scope=personal' }, headers); assert.equal(media.status, 200);
  assert.ok(!media.json.url.includes(grant.token));
  const audio = await f.request(media.json.url, 'GET', undefined, { range: 'bytes=0-31', origin: '' });
  assert.equal(audio.status, 200); assert.equal(audio.json.range, 'bytes=0-31'); assert.doesNotMatch(audio.json.path, /bridge_ticket/);
  assert.equal((await f.request(media.json.url.replace('/audio?', '/original?'))).status, 401);
  assert.equal((await f.request(media.json.url, 'DELETE', {}, headers)).status, 401);
  assert.equal((await f.request(media.json.url, 'GET', undefined, { origin: 'https://evil.example' })).status, 401);
  assert.equal((await f.request('/bridge/media', 'POST', { path: '/api/session' }, headers)).status, 400);
  assert.equal((await f.request('/bridge/session', 'DELETE', undefined, headers)).status, 200);
  assert.equal((await f.request(media.json.url)).status, 401);
  assert.equal((await f.request('/api/library/context', 'GET', undefined, headers)).status, 401);
});

test('跨源真实录音库：流式导入、Range 回听、校对和完整导出，重启后保留文件与修订', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'recdock-companion-'));
  const f = setup(), options = { library: { root: join(temp, 'library'), workspace: process.cwd() }, authorizeRemote: f.bridge.authorize };
  let app = createApplication(options);
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => { if (!await f.bridge.handle(req, res)) await app.middleware(req, res, next); };
  const grant = await f.pair(); let csrf = '';
  const request = (path: string, method = 'GET', value?: unknown) => middlewareRequest(handler, path, method, value === undefined ? undefined : Buffer.from(JSON.stringify(value)), { origin, authorization: grant.authorization, 'content-type': 'application/json', 'x-csrf-token': csrf });
  try {
    await app.library.ready;
    const context = await request('/api/library/context'); assert.equal(context.status, 200); csrf = context.json.csrfToken;
    const bytes = Buffer.alloc(32044); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32000, 40);
    const upload = await request('/api/library/imports', 'POST', { filename: 'bridge-test.wav', bytes: bytes.length, language: 'zh', source: { kind: 'import', deviceId: null, sessionId: null } }); assert.equal(upload.status, 201);
    const sent = await middlewareRequest(handler, `/api/library/imports/${upload.json.uploadId}/content?scope=personal`, 'PUT', bytes, { origin, authorization: grant.authorization, 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }); assert.equal(sent.status, 200);
    const committed = await request(`/api/library/imports/${upload.json.uploadId}/commit`, 'POST', { transcribe: false }); assert.equal(committed.status, 200); assert.equal(committed.json.job, null);
    const recording = committed.json.recording, path = `/api/library/recordings/${recording.id}`;
    const transcript = JSON.parse(await readFile(new URL('../contracts/fixtures/contract-cases.json', import.meta.url), 'utf8')).bases.transcript.data as AudioTranscript;
    transcript.recordingId = recording.id; transcript.sourceSha256 = recording.sourceSha256;
    // This fixture exercises publication and review, not speech recognition quality.
    await app.library.store.installTranscript('scope_personal', recording.id, transcript);
    const revision = await request(`${path}/revisions`, 'POST', { baseRevisionId: transcript.revisionId, changes: [{ kind: 'segment_text', segmentId: transcript.segments[0].id, text: '跨源校对后的完整正文。' }] }); assert.equal(revision.status, 200);
    const exported = await request(`${path}/exports`, 'POST', { revisionId: revision.json.revision.revisionId, format: 'md' }); assert.equal(exported.status, 200);
    const ticket = await request('/bridge/media', 'POST', { path: exported.json.url }); assert.equal(ticket.status, 200);
    const file = await request(ticket.json.url); assert.match(file.raw.toString(), /跨源校对后的完整正文/);
    const original = await request('/bridge/media', 'POST', { path: `${path}/original?scope=personal` });
    const range = await middlewareRequest(handler, original.json.url, 'GET', undefined, { origin, range: 'bytes=0-31' }); assert.equal(range.status, 206); assert.deepEqual(range.raw, bytes.subarray(0, 32));
    await app.close(); app = createApplication(options); await app.library.ready;
    csrf = (await request('/api/library/context')).json.csrfToken;
    const restored = await request(`${path}/transcript`); assert.equal(restored.status, 200); assert.equal(restored.json.transcript.segments[0].text, '跨源校对后的完整正文。');
    assert.equal((await request('/api/library/recordings')).json.total, 1);
  } finally { await app.close(); await rm(temp, { recursive: true, force: true }); }
});
