import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalConnection, companionEndpoint } from '../src/local/connection.ts';
// @ts-ignore jsdom is used only by the DOM test harness.
import { JSDOM } from 'jsdom';

test('助手地址不能配置为外网或携带凭据，避免音频和本机授权外发', () => {
  assert.equal(companionEndpoint('http://127.0.0.1:43127'), 'http://127.0.0.1:43127');
  for (const value of ['https://evil.example', 'http://192.168.1.5', 'http://localhost:43127/path', 'http://user:pass@localhost:43127', 'http://localhost.evil.example']) assert.throws(() => companionEndpoint(value));
});

test('远程配对、JSON、上传及媒体走本机端点，token 不进入媒体 URL，刷新可恢复', async () => {
  const previous = globalThis.fetch, previousWindow = Reflect.get(globalThis, 'window'), token = 'x'.repeat(43), calls: { url: string; init: RequestInit }[] = [];
  const storage = new Map<string, string>();
  Reflect.set(globalThis, 'window', { sessionStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const path = new URL(String(input)).pathname;
    const value = path === '/bridge/health' ? { product: 'RecDock', protocolVersion: 1, allowedOrigin: true } : path === '/bridge/pair' ? { token, protocolVersion: 1 } : path === '/bridge/media' ? { url: '/api/library/recordings/rec_test/audio?bridge_ticket=ticket' } : { ok: true };
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const connection = new LocalConnection({ remote: true });
    await assert.rejects(connection.request('/api/session'), /配对/);
    await connection.pair('12345678'); await connection.request('/api/session');
    assert.equal(new Headers(calls.at(-1)!.init.headers).get('authorization'), `Bearer ${token}`); assert.equal(calls.at(-1)!.init.credentials, 'omit');
    const upload: Record<string, string> = {}; connection.authorizeUpload({ setRequestHeader: (k: string, v: string) => { upload[k] = v; } } as unknown as XMLHttpRequest); assert.equal(upload.Authorization, `Bearer ${token}`);
    const media = await connection.mediaUrl('/api/library/recordings/rec_test/audio'); assert.ok(media.startsWith('http://127.0.0.1:43127/api/')); assert.ok(!media.includes(token));
    const restored = new LocalConnection({ remote: true }); assert.equal(restored.paired, true); await restored.request('/api/session'); assert.equal(new Headers(calls.at(-1)!.init.headers).get('authorization'), `Bearer ${token}`);
    assert.ok(calls.every(call => new URL(call.url).hostname === '127.0.0.1'));
    await connection.disconnect(); assert.equal(connection.paired, false);
  } finally { globalThis.fetch = previous; Reflect.set(globalThis, 'window', previousWindow); }
});

test('网页检查助手身份与协议，不兼容或未允许的网站不能继续配对', async () => {
  const previous = globalThis.fetch; let value = { product: 'Other', protocolVersion: 1, allowedOrigin: true };
  globalThis.fetch = async () => new Response(JSON.stringify(value));
  try {
    const connection = new LocalConnection({ remote: true });
    await assert.rejects(connection.health(), /不兼容/);
    value = { product: 'RecDock', protocolVersion: 2, allowedOrigin: true }; await assert.rejects(connection.health(), /不兼容/);
    value = { product: 'RecDock', protocolVersion: 1, allowedOrigin: false }; await assert.rejects(connection.pair('12345678'), /RECDOCK_WEB_ORIGINS/);
  } finally { globalThis.fetch = previous; }
});

test('助手重启导致授权失效时清除标签页凭据并通知界面，不自动重发业务请求', async () => {
  const previous = globalThis.fetch, previousWindow = Reflect.get(globalThis, 'window');
  const dom = new JSDOM('', { url: 'https://recdock.example' }); Reflect.set(globalThis, 'window', dom.window);
  let expired = 0, requests = 0;
  dom.window.addEventListener('recdock:companion-expired', () => { expired++; });
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/bridge/health') return new Response(JSON.stringify({ product: 'RecDock', protocolVersion: 1, allowedOrigin: true }));
    if (path === '/bridge/pair') return new Response(JSON.stringify({ token: 's'.repeat(43), protocolVersion: 1 }));
    requests++; return new Response(JSON.stringify({ error: { code: 'BRIDGE_AUTH_REQUIRED' } }), { status: 401 });
  };
  try {
    const connection = new LocalConnection({ remote: true }); await connection.pair('12345678');
    const response = await connection.request('/api/library/recordings', { method: 'POST', body: '{}' });
    assert.equal(response.status, 401); assert.equal(requests, 1); assert.equal(expired, 1); assert.equal(connection.paired, false); assert.equal(dom.window.sessionStorage.length, 0);
    await assert.rejects(connection.request('/api/library/recordings', { method: 'POST', body: '{}' }), /配对/); assert.equal(requests, 1);
  } finally { dom.window.close(); globalThis.fetch = previous; Reflect.set(globalThis, 'window', previousWindow); }
});
