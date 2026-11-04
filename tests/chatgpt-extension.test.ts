import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
// @ts-ignore Product extension modules run directly in the browser.
import { inspectPage, submitMessage, attachFile } from '../extensions/chatgpt-bridge/page-adapter.mjs';
// @ts-ignore DOM harness only.
import { JSDOM } from 'jsdom';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const content = '# 合成测试\n这是测试全文。', prompt = '请总结合成测试。';
const packetFor = (targetId: string, id = 'fwd_test') => ({ transfer: { id, targetId, sha256: hash(content), promptHash: hash(prompt), filename: '合成测试-rev-12345678.md' }, content, prompt });
async function until(check: () => boolean, timeout = 6000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw Error('extension condition timed out'); await new Promise(r => setTimeout(r, 10)); } }

async function extension() {
  const previous = Reflect.get(globalThis, 'chrome'), local: Record<string, any> = {}, session: Record<string, any> = {};
  let listener: (message: any, sender: any, callback: (result: any) => void) => boolean;
  const calls: string[] = [], tab = { id: 7, url: 'https://chatgpt.com/', windowId: 1, active: true };
  const page = { ready: true, text: '', hasAttachments: false, attached: false, uploadBusy: false, canSend: false, generating: false, submitted: false, url: tab.url };
  const storage = (object: Record<string, any>) => ({ get: async (key: string) => structuredClone({ [key]: object[key] }), set: async (value: object) => { Object.assign(object, structuredClone(value)); }, remove: async (key: string) => { delete object[key]; } });
  Reflect.set(globalThis, 'chrome', {
    storage: { local: storage(local), session: storage(session) },
    runtime: { id: 'test', getURL: (p: string) => 'chrome-extension://test/' + p, onMessage: { addListener: (l: typeof listener) => { listener = l; } } },
    tabs: { get: async (id: number) => { assert.equal(id, 7); return { ...tab }; }, query: async () => [{ id: 99, url: 'https://chatgpt.com/', active: true }, { ...tab }], update: async (id: number, patch: { url?: string }) => { assert.equal(id, 7, 'all operations reuse bound tab'); if (patch.url) { calls.push('navigate'); tab.url = patch.url; page.url = patch.url; } else calls.push('activate'); return tab; } },
    windows: { update: async () => {} },
    scripting: { executeScript: async (input: { target: { tabId: number }; func: { name: string }; args?: any[] }) => {
      assert.equal(input.target.tabId, 7); const name = input.func.name; calls.push(name);
      if (name === 'inspectPage') return [{ result: { ...page } }];
      if (name === 'attachFile') { page.text = input.args![0].message; page.hasAttachments = page.attached = page.canSend = true; return [{ result: { attached: true } }]; }
      if (name === 'submitMessage') { page.submitted = true; page.text = ''; page.hasAttachments = false; tab.url = page.url = 'https://chatgpt.com/c/test-conversation'; return [{ result: { clicked: true } }]; }
      throw Error('unexpected page function');
    } },
  });
  const moduleUrl = new URL('../extensions/chatgpt-bridge/background.js', import.meta.url); moduleUrl.searchParams.set('test', crypto.randomUUID()); await import(moduleUrl.href);
  const request = (action: string, payload?: unknown) => new Promise<any>((resolve, reject) => { const accepted = listener!({ source: 'recdock-workspace', action, payload }, { frameId: 0, url: 'http://localhost:5173/', id: 'test', tab: { id: 1 } }, response => response.error ? reject(Error(response.error)) : resolve(response.result)); if (!accepted) reject(Error('rejected sender')); });
  // Simulate an already bound tab, as if the user explicitly connected it.
  await request('info'); local.config.tabId = 7;
  return { request, local, page, calls, session, listener: () => listener!, close: () => Reflect.set(globalThis, 'chrome', previous) };
}

test('扩展真实状态机串行发送一次，复用固定标签页，重复点击与打开结果不重复上传', async () => {
  const f = await extension();
  try {
    const info = await f.request('info'), packet = packetFor(info.targetId);
    await f.request('start', packet);
    await assert.rejects(() => f.request('start', packetFor(info.targetId, 'fwd_other')), /另一个任务/);
    await until(() => f.local.tasks?.fwd_test?.state === 'submitted');
    assert.equal(f.calls.filter(c => c === 'attachFile').length, 1); assert.equal(f.calls.filter(c => c === 'submitMessage').length, 1);
    assert.equal((await f.request('start', packet)).state, 'submitted');
    f.page.text = '用户正在写的追问';
    await f.request('open', { conversationUrl: 'https://chatgpt.com/c/test-conversation' });
    assert.equal(f.page.text, '用户正在写的追问'); assert.equal(f.calls.filter(c => c === 'navigate').length, 0, 'opening current result only focuses the tab, preserving drafts');
    await assert.rejects(() => f.request('open', { conversationUrl: 'https://chatgpt.com/c/other-conversation' }), /草稿/);
    assert.equal(f.calls.filter(c => c === 'submitMessage').length, 1); assert.equal(f.session.fwd_test, undefined, 'full file is removed from temporary extension storage');
    const accepted = f.listener()({ action: 'start', payload: packet }, { frameId: 0, url: 'https://evil.test/', tab: {} }, () => {}); assert.equal(accepted, false);
  } finally { f.close(); }
});

test('浏览器中断后只核对可见结果，绝不为提交状态未知的任务重发', async () => {
  const f = await extension();
  try {
    const info = await f.request('info'), packet = packetFor(info.targetId);
    f.local.tasks = { fwd_test: { id: 'fwd_test', targetId: info.targetId, sha256: packet.transfer.sha256, promptHash: packet.transfer.promptHash, filename: packet.transfer.filename, messageText: 'known message', touchedPage: true, attemptedSubmit: true, state: 'submitting' } };
    assert.equal((await f.request('start', packet)).state, 'user_action_required');
    assert.equal(f.calls.includes('attachFile'), false); assert.equal(f.calls.includes('submitMessage'), false);
    f.page.submitted = true; f.page.url = 'https://chatgpt.com/c/recovered-result';
    assert.equal((await f.request('status', { id: 'fwd_test' })).state, 'submitted');
  } finally { f.close(); }
});

test('扩展回执丢失仍尊重服务端可能已提交的记录，不创建新的上传', async () => {
  const f = await extension();
  try {
    const info = await f.request('info'), packet = { ...packetFor(info.targetId), transfer: { ...packetFor(info.targetId).transfer, state: 'user_action_required', submissionAttempted: true } };
    assert.equal((await f.request('start', packet)).state, 'user_action_required');
    assert.equal(f.calls.includes('attachFile'), false); assert.equal(f.calls.includes('submitMessage'), false);
    assert.equal((await f.request('start', packet)).state, 'user_action_required');
  } finally { f.close(); }
});

test('ChatGPT 页面有用户草稿时停止；未触碰页面的任务在处理草稿后可以再试', async () => {
  const f = await extension();
  try {
    const info = await f.request('info'), packet = packetFor(info.targetId); f.page.text = '用户尚未发送的内容';
    await f.request('start', packet); await until(() => f.local.tasks?.fwd_test?.state === 'user_action_required');
    assert.equal(f.page.text, '用户尚未发送的内容'); assert.equal(f.calls.includes('attachFile'), false);
    f.page.text = ''; await f.request('start', packet); await until(() => f.local.tasks?.fwd_test?.state === 'submitted');
    assert.equal(f.calls.filter(c => c === 'submitMessage').length, 1);
  } finally { f.close(); }
});

test('DOM 适配器需要真实附件卡与用户消息证据，附件未就绪、草稿变化时不会点击发送', () => {
  const filename = 'synthetic.md', message = '请使用附件 synthetic.md，进行总结。';
  const dom = new JSDOM(`<form><div role="textbox" contenteditable="true"></div><div class="attachment-card" title="${filename}">${filename}</div><button data-testid="send-button" disabled>发送</button></form>`, { url: 'https://chatgpt.com/c/test' });
  const keys = ['document', 'window', 'location', 'getComputedStyle'], previous = keys.map(k => Reflect.get(globalThis, k));
  try {
    for (const key of keys) Reflect.set(globalThis, key, key === 'window' ? dom.window : dom.window[key]);
    dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 20 }] as any;
    const composer = document.querySelector('[role=textbox]')!, send = document.querySelector('button')!; composer.textContent = message;
    assert.equal(inspectPage().ready, true, 'opening an existing result checks the page without a task');
    assert.equal(inspectPage({ filename: 'different.md' }).hasAttachments, true, 'another file must also block a new task');
    let clicks = 0; send.onclick = event => { event.preventDefault(); clicks++; };
    assert.equal(inspectPage({ filename, message }).submitted, false);
    assert.throws(() => submitMessage({ filename, message }), /附件尚未完成/); assert.equal(clicks, 0);
    send.disabled = false; composer.textContent = 'user draft'; assert.throws(() => submitMessage({ filename, message }), /草稿已变化/);
    assert.throws(() => attachFile({ filename, content, message }), /未发送的草稿/); assert.equal(composer.textContent, 'user draft');
    composer.textContent = message; submitMessage({ filename, message }); assert.equal(clicks, 1);
    const article = document.createElement('article'); article.dataset.testid = 'conversation-turn-1'; article.innerHTML = `<div class="attachment-card"><button>${filename}</button></div><div data-message-author-role="user"></div>`; article.querySelector('[data-message-author-role]')!.textContent = message; document.body.append(article);
    assert.equal(inspectPage({ filename, message }).submitted, true);
    article.querySelector('.attachment-card')!.remove(); assert.equal(inspectPage({ filename, message }).submitted, false, 'filename in plain prompt is insufficient evidence');
    article.remove();
    const modern = document.createElement('div'); modern.setAttribute('data-content-search-turn-key', 'fallback-turn-0'); modern.innerHTML = `<div data-chatgpt-search-unit-key="fallback-turn-0:0:user"><span class="group/resource-card"><span title="${filename}">${filename}</span></span></div><div data-user-message-bubble="true"></div>`; modern.querySelector('[data-user-message-bubble]')!.textContent = message; document.body.append(modern);
    assert.equal(inspectPage({ filename, message }).submitted, true, 'current ChatGPT user bubble and resource card');
    modern.querySelector('[data-chatgpt-search-unit-key]')!.remove(); assert.equal(inspectPage({ filename, message }).submitted, false);
  } finally { keys.forEach((k, i) => Reflect.set(globalThis, k, previous[i])); dom.window.close(); }
});
