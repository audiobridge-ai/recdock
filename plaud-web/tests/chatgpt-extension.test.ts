import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
// @ts-ignore Product extension modules run directly in the browser.
import { inspectPage, submitMessage, attachFile, beginNewChat, clearSubmittedDraft } from '../extensions/chatgpt-bridge/page-adapter.mjs';
// @ts-ignore The extension shares only pure draft matching with this harness.
import { messageFor, submittedDraftFor } from '../extensions/chatgpt-bridge/shared.mjs';
// @ts-ignore DOM harness only.
import { JSDOM } from 'jsdom';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const content = '# 合成测试\n这是测试全文。', prompt = '请总结合成测试。';
const packetFor = (targetId: string, id = 'fwd_test') => ({ transfer: { id, targetId, sha256: hash(content), promptHash: hash(prompt), filename: '合成测试-rev-12345678.md' }, content, prompt });
async function until(check: () => boolean, timeout = 6000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw Error('extension condition timed out'); await new Promise(r => setTimeout(r, 10)); } }

async function extension() {
  const previous = Reflect.get(globalThis, 'chrome'), local: Record<string, any> = {}, session: Record<string, any> = {};
  let listener: (message: any, sender: any, callback: (result: any) => void) => boolean;
  let onNavigate: (() => void) | undefined, inspectHook: (() => Promise<unknown> | unknown) | undefined;
  let onUpdated: (id: number, change: object, tab: object) => void;
  const calls: string[] = [], tab = { id: 7, url: 'https://chatgpt.com/', windowId: 1, active: true };
  const page = { ready: true, text: '', hasAttachments: false, attached: false, attachmentCount: 0, attachmentFilename: '', unrelatedAttachments: false, uploadBusy: false, canSend: false, generating: false, submitted: false, url: tab.url };
  const storage = (object: Record<string, any>) => ({ get: async (key: string) => structuredClone({ [key]: object[key] }), set: async (value: object) => { Object.assign(object, structuredClone(value)); }, remove: async (key: string) => { delete object[key]; } });
  Reflect.set(globalThis, 'chrome', {
    storage: { local: storage(local), session: storage(session) },
    runtime: { id: 'test', getURL: (p: string) => 'chrome-extension://test/' + p, onMessage: { addListener: (l: typeof listener) => { listener = l; } } },
    tabs: { onUpdated: { addListener: (callback: typeof onUpdated) => { onUpdated = callback; } }, get: async (id: number) => { assert.equal(id, 7); return { ...tab }; }, query: async () => [{ id: 99, url: 'https://chatgpt.com/', active: true }, { ...tab }], update: async (id: number, patch: { url?: string }) => { assert.equal(id, 7, 'all operations reuse bound tab'); if (patch.url) { calls.push('navigate'); tab.url = patch.url; page.url = patch.url; onNavigate?.(); } else calls.push('activate'); return tab; } },
    windows: { update: async () => {} },
    scripting: { executeScript: async (input: { target: { tabId: number }; func: { name: string }; args?: any[]; injectImmediately?: boolean }) => {
      assert.equal(input.target.tabId, 7); const name = input.func.name; calls.push(name);
      if (name === 'inspectPage') { assert.equal(input.injectImmediately, true, 'readiness inspection must not wait for document_idle'); return [{ result: inspectHook ? await inspectHook() : { ...page } }]; }
      if (name === 'beginNewChat') return [{ result: { clicked: false } }];
      if (name === 'clearSubmittedDraft') { if (page.text.replace(/\s+/g, ' ').trim() !== input.args![0].message.replace(/\s+/g, ' ').trim()) return [{ result: { cleared: false } }]; page.text = ''; page.hasAttachments = false; return [{ result: { cleared: true } }]; }
      if (name === 'attachFile') { page.text = input.args![0].message; page.hasAttachments = page.attached = page.canSend = true; page.attachmentCount = 1; page.attachmentFilename = input.args![0].filename; return [{ result: { attached: true } }]; }
      if (name === 'submitMessage') { page.submitted = true; page.text = ''; page.hasAttachments = page.attached = false; page.attachmentCount = 0; tab.url = page.url = 'https://chatgpt.com/c/test-conversation'; return [{ result: { clicked: true } }]; }
      throw Error('unexpected page function');
    } },
  });
  const moduleUrl = new URL('../extensions/chatgpt-bridge/background.js', import.meta.url); moduleUrl.searchParams.set('test', crypto.randomUUID()); await import(moduleUrl.href);
  const request = (action: string, payload?: unknown) => new Promise<any>((resolve, reject) => { const accepted = listener!({ source: 'recdock-workspace', action, payload }, { frameId: 0, url: 'http://localhost:5173/', id: 'test', tab: { id: 1 } }, response => response.error ? reject(Error(response.error)) : resolve(response.result)); if (!accepted) reject(Error('rejected sender')); });
  // Simulate an already bound tab, as if the user explicitly connected it.
  await request('info'); local.config.tabId = 7;
  return { request, local, page, tab, calls, session, updated: (id: number, change: object, value = tab) => onUpdated!(id, change, value), set onNavigate(hook: () => void) { onNavigate = hook; }, set inspectHook(hook: () => Promise<unknown> | unknown) { inspectHook = hook; }, listener: () => listener!, close: () => Reflect.set(globalThis, 'chrome', previous) };
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

test('切换首页恢复旧草稿时保留草稿，报告明确原因，不上传另一条录音', async () => {
  const f = await extension();
  try {
    f.tab.url = f.page.url = 'https://chatgpt.com/c/existing';
    f.onNavigate = () => { f.page.text = '上一条 PLAUD 录音的未发送草稿'; f.page.hasAttachments = true; };
    const info = await f.request('info'); await f.request('start', packetFor(info.targetId));
    await until(() => f.local.tasks?.fwd_test?.state === 'user_action_required');
    const status = await f.request('status', { id: 'fwd_test' }); assert.match(status.message, /首页恢复了未发送的草稿或附件/);
    const retry = await f.request('start', packetFor(info.targetId)); assert.match(retry.message, /检查并处理草稿/); assert.equal(retry.state, 'user_action_required');
    assert.equal(f.page.text, '上一条 PLAUD 录音的未发送草稿'); assert.equal(f.calls.filter(c => c === 'navigate').length, 1);
    assert.equal(f.calls.includes('attachFile'), false); assert.equal(f.calls.includes('submitMessage'), false);
  } finally { f.close(); }
});

test('新对话的 DOM 检查等待期间，状态和连接查询仍立即返回，不堵塞工作台轮询', async () => {
  const f = await extension(); let resolve!: (value: unknown) => void, waiting = false;
  const navigation = new Promise(done => { resolve = done; });
  try {
    f.tab.url = f.page.url = 'https://chatgpt.com/c/existing';
    f.onNavigate = () => { f.page.ready = false; };
    f.inspectHook = () => { if (!f.page.ready) { waiting = true; return navigation; } return { ...f.page }; };
    const info = await f.request('info'); await f.request('start', packetFor(info.targetId)); await until(() => waiting);
    const status = await Promise.race([f.request('status', { id: 'fwd_test' }), new Promise<never>((_, reject) => setTimeout(() => reject(Error('status was blocked by navigation')), 500))]);
    assert.equal(status.state, 'prepared'); assert.match(status.message, /准备新对话/); assert.equal((await f.request('info')).bound, true);
    f.page.ready = true; f.page.text = '恢复的草稿'; resolve({ ...f.page }); await until(() => f.local.tasks.fwd_test.state === 'user_action_required');
    assert.equal(f.calls.includes('attachFile'), false);
  } finally { resolve({ ...f.page, ready: true, text: '保留草稿' }); f.close(); }
});

test('连续发送两份稿件时自动清理已经确认提交的残留，保持同一个标签页', async () => {
  const f = await extension();
  try {
    const info = await f.request('info'), first = packetFor(info.targetId);
    await f.request('start', first); await until(() => f.local.tasks.fwd_test.state === 'submitted');
    const previousText = f.local.tasks.fwd_test.messageText;
    f.onNavigate = () => { f.page.text = previousText; f.page.hasAttachments = false; f.page.submitted = false; };
    const second = { ...packetFor(info.targetId, 'fwd_second'), transfer: { ...packetFor(info.targetId, 'fwd_second').transfer, filename: '第二份合成稿.md' } };
    await f.request('start', second); await until(() => f.local.tasks.fwd_second.state === 'submitted');
    assert.equal(f.calls.filter(c => c === 'attachFile').length, 2); assert.equal(f.calls.filter(c => c === 'submitMessage').length, 2);
    assert.equal(f.calls.filter(c => c === 'clearSubmittedDraft').length, 1); assert.equal(f.calls.filter(c => c === 'beginNewChat').length, 1);
    assert.equal(f.local.config.tabId, 7); assert.equal(f.local.tasks.fwd_test.state, 'submitted');
  } finally { f.close(); }
});

test('用户打开新聊天时清理已提交残留，额外编辑和其他标签页保持原样', async () => {
  const f = await extension();
  try {
    const info = await f.request('info'), packet = packetFor(info.targetId), text = messageFor(packet);
    f.local.tasks = { fwd_test: { ...packet.transfer, state: 'submitted', conversationUrl: 'https://chatgpt.com/c/confirmed', messageText: text } };
    f.page.text = text; f.updated(7, { url: 'https://chatgpt.com/' }); await until(() => !f.page.text);
    assert.equal(f.calls.filter(c => c === 'clearSubmittedDraft').length, 1);
    f.page.text = text + '\n这是用户新增的问题。'; f.updated(7, { url: 'https://chatgpt.com/' }); await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.page.text.endsWith('这是用户新增的问题。')); assert.equal(f.calls.filter(c => c === 'clearSubmittedDraft').length, 1);
    f.page.text = text; f.updated(99, { url: 'https://chatgpt.com/' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.page.text, text);
  } finally { f.close(); }
});

test('仅当前连接、已确认提交且全文一致的首页草稿可被识别为残留', () => {
  const targetId = 'a'.repeat(32), packet = packetFor(targetId), text = messageFor(packet);
  const known = { ...packet.transfer, state: 'submitted', conversationUrl: 'https://chatgpt.com/c/confirmed', messageText: text };
  const page = { ready: true, generating: false, text, url: 'https://chatgpt.com/' };
  assert.equal(submittedDraftFor([known], targetId, page)?.id, packet.transfer.id);
  assert.equal(submittedDraftFor([{ ...known, state: 'submitting' }], targetId, page), null);
  assert.equal(submittedDraftFor([known], 'b'.repeat(32), page), null);
  assert.equal(submittedDraftFor([known], targetId, { ...page, text: text + '新增内容' }), null);
  assert.equal(submittedDraftFor([known], targetId, { ...page, url: 'https://chatgpt.com/c/another' }), null);
});

test('编辑器清理通过原生输入事件，只清空完全匹配且没有附件的已提交文本', () => {
  const message = '已经确认提交的合成提示词', filename = 'synthetic.md';
  const dom = new JSDOM('<form><textarea data-id="root"></textarea></form><button aria-label="新聊天" type="button"></button>', { url: 'https://chatgpt.com/' });
  const keys = ['document', 'window', 'location', 'getComputedStyle', 'HTMLTextAreaElement', 'Event'], previous = keys.map(k => Reflect.get(globalThis, k));
  try {
    for (const key of keys) Reflect.set(globalThis, key, key === 'window' ? dom.window : dom.window[key]);
    dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 20 }] as any;
    const field = document.querySelector('textarea')!; let inputs = 0, newChats = 0; field.oninput = () => { inputs++; }; document.querySelector('button')!.onclick = () => { newChats++; };
    field.value = message + '（用户补充）'; assert.equal(clearSubmittedDraft({ message, filename }).cleared, false); assert.ok(field.value.includes('用户补充')); assert.throws(() => beginNewChat(), /未发送/);
    field.value = message; const attachment = document.createElement('div'); attachment.className = 'attachment-card'; document.querySelector('form')!.append(attachment);
    assert.equal(clearSubmittedDraft({ message, filename }).cleared, false); assert.equal(field.value, message);
    attachment.remove(); assert.equal(clearSubmittedDraft({ message, filename }).cleared, true); assert.equal(field.value, ''); assert.equal(inputs, 1);
    assert.equal(beginNewChat().clicked, true); assert.equal(newChats, 1);
    field.value = message; dom.window.history.replaceState(null, '', '/c/another'); assert.throws(() => clearSubmittedDraft({ message, filename }), /页面已变化/); assert.equal(field.value, message);
  } finally { keys.forEach((key, i) => Reflect.set(globalThis, key, previous[i])); dom.window.close(); }
});

test('页面同时存在旧隐藏编辑器和新编辑器时，只向可见编辑器的通用文件入口上传', () => {
  const dom = new JSDOM('<form id="old"><div contenteditable="true" role="textbox"></div><input id="old-image" type="file" accept="image/*"><input id="old-file" type="file"></form><form id="current"><div contenteditable="true" role="textbox"></div><input id="current-image" type="file" accept="image/*"><input id="current-file" type="file"></form>', { url: 'https://chatgpt.com/' });
  const keys = ['document', 'window', 'location', 'getComputedStyle', 'Event', 'File', 'DataTransfer'], previous = keys.map(k => Reflect.get(globalThis, k));
  try {
    for (const key of keys.filter(k => k !== 'DataTransfer')) Reflect.set(globalThis, key, key === 'window' ? dom.window : dom.window[key]);
    class Transfer { files: File[] = []; items = { add: (file: File) => { this.files.push(file); } }; }
    Reflect.set(globalThis, 'DataTransfer', Transfer);
    dom.window.HTMLElement.prototype.getClientRects = function(this: HTMLElement) { return this.closest('#old') ? [] : [{ width: 100, height: 20 }]; } as any;
    const current = document.querySelector('#current [role=textbox]')!;
    dom.window.document.execCommand = (_command: string, _ui = false, text = '') => { current.textContent = text; return true; };
    const changed: string[] = [];
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type=file]')) { let files: File[] = input.id === 'old-file' ? [new File(['previous'], 'previous.md')] : []; Object.defineProperty(input, 'files', { get: () => files, set: value => { files = value; } }); input.onchange = () => { changed.push(input.id); }; }
    assert.equal(inspectPage().hasAttachments, false, 'a hidden old input cannot block the current composer');
    attachFile({ filename: 'current.md', content, message: '当前稿件的提示词' });
    assert.deepEqual(changed, ['current-file']); assert.equal(document.querySelector<HTMLInputElement>('#current-file')!.files![0].name, 'current.md');
    assert.equal(document.querySelector('#old [role=textbox]')!.textContent, ''); assert.equal(current.textContent, '当前稿件的提示词');
  } finally { keys.forEach((key, i) => Reflect.set(globalThis, key, previous[i])); dom.window.close(); }
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
    const hidden = document.createElement('div'); hidden.setAttribute('data-user-message-bubble', 'true'); hidden.textContent = message; hidden.getClientRects = () => [] as any; document.body.prepend(hidden);
    assert.equal(inspectPage({ filename, message }).submitted, true, 'current ChatGPT user bubble and resource card');
    modern.querySelector('[data-chatgpt-search-unit-key]')!.remove(); assert.equal(inspectPage({ filename, message }).submitted, false);
  } finally { keys.forEach((k, i) => Reflect.set(globalThis, k, previous[i])); dom.window.close(); }
});

test('ChatGPT 自动添加重名编号后仍识别同一哈希文件，提交和回执使用同一规则', () => {
  const filename = 'Remove file-1234abcd.md', message = '请阅读这个合成附件。';
  const dom = new JSDOM('<form><div role="textbox" contenteditable="true"></div><button data-file type="button"></button><button data-remove type="button"></button><button data-testid="send-button" type="button">发送</button></form>', { url: 'https://chatgpt.com/' });
  const keys = ['document', 'window', 'location', 'getComputedStyle'], previous = keys.map(k => Reflect.get(globalThis, k));
  try {
    for (const key of keys) Reflect.set(globalThis, key, key === 'window' ? dom.window : dom.window[key]);
    dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 20 }] as any;
    document.querySelector('[role=textbox]')!.textContent = message;
    let clicks = 0; document.querySelector<HTMLButtonElement>('[data-testid=send-button]')!.onclick = () => { clicks++; };
    for (const actual of [filename, 'Remove file-1234abcd(1).md', 'Remove file-1234abcd (24).md']) {
      document.querySelector('[data-file]')!.textContent = actual; document.querySelector('[data-remove]')!.setAttribute('aria-label', '移除 ' + actual);
      const page = inspectPage({ filename, message }); assert.equal(page.attached, true); assert.equal(page.attachmentFilename, actual); assert.equal(page.attachmentCount, 1); assert.equal(page.unrelatedAttachments, false);
      submitMessage({ filename, message });
    }
    assert.equal(clicks, 3);
    document.querySelector('[data-file]')!.textContent = 'Remove file-deadbeef(1).md'; document.querySelector('[data-remove]')!.setAttribute('aria-label', '移除 Remove file-deadbeef(1).md');
    assert.equal(inspectPage({ filename, message }).attached, false); assert.throws(() => submitMessage({ filename, message }), /附件与当前稿件不一致/);
    const article = document.createElement('article'); article.dataset.testid = 'conversation-turn-0'; article.innerHTML = '<button data-receipt-file></button><div data-message-author-role="user"></div>'; article.querySelector('[data-receipt-file]')!.textContent = 'Remove file-1234abcd(1).md'; article.querySelector('[data-message-author-role]')!.textContent = message; document.body.append(article);
    assert.equal(inspectPage({ filename, message }).submitted, true);
  } finally { keys.forEach((key, i) => Reflect.set(globalThis, key, previous[i])); dom.window.close(); }
});

test('重名附件已经就绪时恢复同一未提交任务，直接提交且不重复上传', async () => {
  const f = await extension();
  try {
    const info = await f.request('info'), packet = packetFor(info.targetId), text = messageFor(packet);
    f.local.tasks = { fwd_test: { ...packet.transfer, state: 'attaching', messageText: text, touchedPage: true } };
    Object.assign(f.page, { text, hasAttachments: true, attached: true, attachmentFilename: packet.transfer.filename.replace('.md', '(1).md'), attachmentCount: 1, canSend: true });
    await f.request('start', packet); await until(() => f.local.tasks.fwd_test.state === 'submitted');
    assert.equal(f.calls.filter(c => c === 'attachFile').length, 0); assert.equal(f.calls.filter(c => c === 'submitMessage').length, 1); assert.ok(f.local.tasks.fwd_test.attachmentFilename.endsWith('(1).md'));
    await f.request('start', packet); assert.equal(f.calls.filter(c => c === 'submitMessage').length, 1);
  } finally { f.close(); }
});

test('已有草稿混入其他附件时不恢复自动提交', async () => {
  const f = await extension();
  try {
    const info = await f.request('info'), packet = packetFor(info.targetId), text = messageFor(packet);
    f.local.tasks = { fwd_test: { ...packet.transfer, state: 'attaching', messageText: text, touchedPage: true } };
    Object.assign(f.page, { text, hasAttachments: true, attached: true, attachmentCount: 2, unrelatedAttachments: true, canSend: true });
    assert.equal((await f.request('start', packet)).state, 'user_action_required'); assert.equal(f.calls.includes('submitMessage'), false); assert.equal(f.calls.includes('attachFile'), false); assert.equal(f.page.text, text);
  } finally { f.close(); }
});

test('附件等待按真实时间截止，慢检查不会把循环次数放大成长期发送中', async t => {
  const f = await extension(); let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  try {
    const info = await f.request('info');
    f.inspectHook = () => { if (f.page.hasAttachments) { clock += 95000; f.page.attached = false; f.page.attachmentCount = 0; } return { ...f.page }; };
    await f.request('start', packetFor(info.targetId)); await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(f.local.tasks.fwd_test.state, 'user_action_required'); assert.match(f.local.tasks.fwd_test.message, /超时.*已暂停/); assert.equal(f.calls.includes('submitMessage'), false);
  } finally { t.mock.restoreAll(); f.close(); }
});
