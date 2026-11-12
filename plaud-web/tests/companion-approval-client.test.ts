import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
// @ts-ignore test-only DOM
import { JSDOM } from 'jsdom';
import { LocalConnection } from '../src/local/connection.ts';

test('桌面确认使用 PKCE，授权保存在当前网站并跨标签页恢复，断开后清理持久凭据', async () => {
  const before = { window: Reflect.get(globalThis, 'window'), fetch: globalThis.fetch };
  const dom = new JSDOM('', { url: 'https://recdock.example' }); Reflect.set(globalThis, 'window', dom.window);
  let challenge = '', pending = 0, tokens = 0;
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === '/bridge/health') return new Response(JSON.stringify({ product: 'RecDock', protocolVersion: 1, desktopApproval: true, allowedOrigin: true }));
    if (path === '/bridge/authorization') { challenge = JSON.parse(String(init.body)).challenge; return new Response(JSON.stringify({ id: 'request-id' }), { status: 201 }); }
    if (path === '/bridge/authorization/exchange') {
      const body = JSON.parse(String(init.body)); assert.equal(body.id, 'request-id');
      assert.equal(createHash('sha256').update(body.verifier).digest('base64url'), challenge); tokens++;
      return new Response(JSON.stringify({ token: 'p'.repeat(43), persistent: true, protocolVersion: 1 }));
    }
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${'p'.repeat(43)}`);
    return new Response('{}');
  };
  try {
    const connection = new LocalConnection({ remote: true });
    await connection.approve(new AbortController().signal, () => pending++);
    assert.equal(pending, 1); assert.equal(tokens, 1); assert.equal(dom.window.sessionStorage.length, 0); assert.equal(dom.window.localStorage.length, 1);
    const restored = new LocalConnection({ remote: true }); assert.equal(restored.paired, true);
    await restored.request('/api/library/context'); await restored.disconnect();
    assert.equal(dom.window.localStorage.length, 0); assert.equal(new LocalConnection({ remote: true }).paired, false);
  } finally { dom.window.close(); Reflect.set(globalThis, 'window', before.window); globalThis.fetch = before.fetch; }
});

test('用户取消桌面授权后不会在浏览器保存凭据', async () => {
  const before = { window: Reflect.get(globalThis, 'window'), fetch: globalThis.fetch };
  const dom = new JSDOM('', { url: 'https://recdock.example' }); Reflect.set(globalThis, 'window', dom.window);
  const controller = new AbortController();
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/bridge/health') return new Response(JSON.stringify({ product: 'RecDock', protocolVersion: 1, desktopApproval: true, allowedOrigin: true }));
    controller.abort(); return new Response(JSON.stringify({ id: 'request-id' }));
  };
  try {
    const connection = new LocalConnection({ remote: true }); await assert.rejects(connection.approve(controller.signal));
    assert.equal(connection.paired, false); assert.equal(dom.window.localStorage.length, 0);
  } finally { dom.window.close(); Reflect.set(globalThis, 'window', before.window); globalThis.fetch = before.fetch; }
});
