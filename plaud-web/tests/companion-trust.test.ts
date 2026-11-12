import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanionBridge } from '../server/companion/bridge.ts';
import { middlewareRequest } from './helpers/middleware.ts';

const origin = 'https://recdock.example', admin = 'a'.repeat(43);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'recdock-trust-'));
  const file = join(directory, 'grants.json');
  let now = Date.now();
  let bridge = new CompanionBridge([origin], () => now, { token: admin, trustFile: file });
  const request = (path: string, method = 'GET', value?: unknown, extra: Record<string, string> = {}) => middlewareRequest(async (req, res) => {
    if (!await bridge.handle(req, res)) { res.statusCode = bridge.authorize(req) ? 200 : 401; res.end('{}'); }
  }, path, method, value === undefined ? undefined : Buffer.from(JSON.stringify(value)), { origin, 'content-type': 'application/json', ...extra });
  const desktop = (path: string, value?: unknown, extra: Record<string, string> = {}) => request('/desktop/' + path, value ? 'POST' : 'GET', value, { origin: '', 'x-recdock-control': admin, ...extra });
  async function pending() {
    const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
    const response = await request('/bridge/authorization', 'POST', { challenge });
    assert.equal(response.status, 201);
    return { id: response.json.id, verifier };
  }
  async function approve() {
    const body = await pending();
    assert.equal((await desktop('decision', { id: body.id, approve: true })).status, 200);
    const result = await request('/bridge/authorization/exchange', 'POST', body);
    assert.equal(result.status, 200); assert.equal(result.json.persistent, true);
    return { ...body, token: result.json.token as string };
  }
  return { file, directory, request, desktop, pending, approve,
    restart: () => { bridge = new CompanionBridge([origin], () => now, { token: admin, trustFile: file }); },
    advance: (ms: number) => { now += ms; },
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('持久授权先经本机确认和 PKCE 校验，令牌仅以摘要落盘，重启后可恢复并撤销', async () => {
  const f = await fixture();
  try {
    const health = await f.request('/bridge/health'); assert.equal(health.json.desktopApproval, true);
    const pending = await f.pending();
    assert.equal((await f.request('/bridge/authorization/exchange', 'POST', pending)).status, 202);
    assert.equal((await f.desktop('status')).json.pending[0].origin, origin);
    assert.equal((await f.desktop('decision', { id: pending.id, approve: true })).status, 200);
    const exchange = await f.request('/bridge/authorization/exchange', 'POST', pending); assert.equal(exchange.status, 200);
    const token = exchange.json.token as string, headers = { authorization: `Bearer ${token}` };
    const saved = await readFile(f.file, 'utf8'); assert.ok(!saved.includes(token)); assert.ok(saved.includes(createHash('sha256').update(token).digest('hex')));
    assert.equal((await f.request('/api/test', 'GET', undefined, headers)).status, 200);
    assert.equal((await f.request('/bridge/authorization/exchange', 'POST', pending)).status, 401);
    f.restart(); assert.equal((await f.request('/api/test', 'GET', undefined, headers)).status, 200);
    const status = await f.desktop('status'); assert.equal(status.json.grants.length, 1); assert.ok(!JSON.stringify(status.json).includes(token));
    await f.desktop('revoke', { id: status.json.grants[0].id });
    assert.equal((await f.request('/api/test', 'GET', undefined, headers)).status, 401);
    f.restart(); assert.equal((await f.request('/api/test', 'GET', undefined, headers)).status, 401);
  } finally { await f.cleanup(); }
});

test('网站不能伪造本机批准，错误 verifier、其它来源、拒绝和超时不会获得授权', async () => {
  const f = await fixture();
  try {
    const pending = await f.pending();
    assert.equal((await f.desktop('decision', { id: pending.id, approve: true }, { origin })).status, 403);
    assert.equal((await f.desktop('status', undefined, { 'x-recdock-control': '' })).status, 403);
    assert.equal((await f.desktop('status', undefined, { 'x-recdock-control': '汉'.repeat(43) })).status, 403);
    assert.equal((await f.request('/bridge/authorization/exchange', 'POST', { ...pending, verifier: 'x'.repeat(43) })).status, 401);
    assert.equal((await f.request('/bridge/authorization/exchange', 'POST', pending, { origin: 'https://evil.example' })).status, 403);
    await f.desktop('decision', { id: pending.id, approve: false });
    assert.equal((await f.request('/bridge/authorization/exchange', 'POST', pending)).json.error.code, 'AUTHORIZATION_DENIED');
    const expired = await f.pending(); f.advance(120_001);
    assert.equal((await f.desktop('decision', { id: expired.id, approve: true })).status, 404);
    assert.equal((await f.request('/bridge/authorization/exchange', 'POST', expired)).status, 401);
  } finally { await f.cleanup(); }
});

test('持久授权有固定有效期，断开撤销跨重启有效且旧媒体凭据立即失效', async () => {
  const f = await fixture();
  try {
    const grant = await f.approve(), headers = { authorization: `Bearer ${grant.token}` };
    const media = await f.request('/bridge/media', 'POST', { path: '/api/library/recordings/rec_test/audio' }, headers);
    assert.equal(media.status, 200);
    assert.equal((await f.request('/bridge/session', 'DELETE', undefined, headers)).status, 200);
    assert.equal((await f.request(media.json.url, 'GET', undefined, { origin: '' })).status, 401);
    f.restart(); assert.equal((await f.request('/api/test', 'GET', undefined, headers)).status, 401);
    const next = await f.approve(); f.advance(30 * 24 * 60 * 60_000 + 1);
    assert.equal((await f.request('/api/test', 'GET', undefined, { authorization: `Bearer ${next.token}` })).status, 401);
  } finally { await f.cleanup(); }
});

test('授权存储权限异常或格式损坏时拒绝启动授权，不退化为自动信任', async () => {
  const f = await fixture();
  try {
    await f.approve(); await chmod(f.file, 0o644); f.restart();
    assert.equal((await f.request('/bridge/health')).status, 500);
    await chmod(f.file, 0o600); await writeFile(f.file, '{invalid'); f.restart();
    assert.equal((await f.request('/bridge/health')).status, 500);
  } finally { await f.cleanup(); }
});
