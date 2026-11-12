import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore jsdom is used only by the DOM test harness.
import { JSDOM } from 'jsdom';
import { installCompanionPanel } from '../src/local/panel.ts';

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Companion panel condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
test('在线连接界面：初始仅检测助手健康、显示实际来源、配对后清码与断开授权', async () => {
  const dom = new JSDOM('<main></main>', { url: 'https://recdock.example/' });
  const keys = ['window', 'document', 'fetch'], previous = new Map(keys.map(key => [key, Reflect.get(globalThis, key)]));
  Reflect.set(globalThis, 'window', dom.window); Reflect.set(globalThis, 'document', dom.window.document);
  const calls: string[] = []; let starts = 0, disconnected = 0;
  Reflect.set(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input); calls.push(url.pathname);
    assert.equal(url.origin, 'http://127.0.0.1:43127'); assert.equal(init.credentials, 'omit');
    let value: unknown;
    if (url.pathname === '/bridge/health') value = { product: 'RecDock', protocolVersion: 1, allowedOrigin: true };
    else if (url.pathname === '/bridge/pair') { assert.deepEqual(JSON.parse(String(init.body)), { code: '12345678' }); value = { token: 'p'.repeat(43), protocolVersion: 1 }; }
    else { assert.equal(url.pathname, '/bridge/session'); assert.equal(init.method, 'DELETE'); assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${'p'.repeat(43)}`); value = { disconnected: true }; }
    return new Response(JSON.stringify(value));
  });
  try {
    installCompanionPanel(document.querySelector('main')!, async () => { starts++; }, () => { disconnected++; });
    const query = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
    assert.deepEqual(calls, ['/bridge/health']); assert.match(query('[data-helper-command]').textContent!, /https:\/\/recdock.example/);
    assert.equal(query<HTMLAnchorElement>('[data-helper-open]').href, 'http://127.0.0.1:43127/');
    query<HTMLInputElement>('[data-helper-code]').value = '12345678'; query<HTMLFormElement>('[data-helper-form]').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await until(() => starts === 1);
    assert.equal(query<HTMLInputElement>('[data-helper-code]').value, ''); assert.equal(query<HTMLFormElement>('[data-helper-form]').hidden, true);
    assert.match(query('[data-helper-status]').textContent!, /已连接/);
    query<HTMLButtonElement>('[data-helper-disconnect]').click(); await until(() => disconnected === 1);
    assert.equal(query<HTMLFormElement>('[data-helper-form]').hidden, false); assert.equal(dom.window.sessionStorage.length, 0);
    assert.deepEqual(calls, ['/bridge/health', '/bridge/health', '/bridge/pair', '/bridge/session']);
  } finally { dom.window.close(); for (const [key, value] of previous) Reflect.set(globalThis, key, value); }
});
