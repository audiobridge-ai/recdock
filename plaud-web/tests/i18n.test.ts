import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-ignore jsdom is a test-only dependency.
import { JSDOM } from 'jsdom';
import { getLocale, initializeLocale, readLocale, normalizeLocale, t, html, systemMessage, installLanguageSwitch } from '../src/i18n/index.ts';
import { chatgptPrompt } from '../src/chatgpt/bridge.ts';

test('English is the default, stored Chinese is explicit, and denied storage falls back safely', () => {
  assert.equal(getLocale(), 'en');
  assert.equal(readLocale(), 'en');
  assert.equal(readLocale({ getItem: () => 'zh-CN' }), 'zh-CN');
  assert.equal(readLocale({ getItem: () => 'zh' }), 'en');
  assert.equal(readLocale({ getItem: () => { throw Error('denied'); } }), 'en');
  assert.equal(normalizeLocale('fr'), 'en');
  assert.equal(t('保存标题'), 'Save title');
  assert.equal(t('电量 {0}%', 0), 'Battery 0%');
  const original = '设置 {1} <b>录音</b>';
  assert.equal(t('正在连接 {0}', original), 'Connecting to ' + original);
  assert.equal(systemMessage('命令 FE10 响应超时'), 'Command FE10 timed out');
  initializeLocale('zh-CN'); assert.equal(t('保存标题'), '保存标题');
  initializeLocale('en');
});

test('HTML localization sees authored literals before interpolation and leaves payload text opaque', () => {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost:5173' });
  const old = Reflect.get(globalThis, 'document'); Reflect.set(globalThis, 'document', dom.window.document);
  try {
    const user = '设置 &lt;script&gt;录音&lt;/script&gt;';
    dom.window.document.querySelector('main')!.innerHTML = html`<button title="设置">保存标题</button><p>${user}</p>`;
    assert.equal(dom.window.document.querySelector('button')!.textContent, 'Save title');
    assert.equal(dom.window.document.querySelector('button')!.title, 'Settings');
    assert.equal(dom.window.document.querySelector('p')!.textContent, '设置 <script>录音</script>');
    assert.equal(dom.window.document.querySelector('script'), null);
  } finally { Reflect.set(globalThis, 'document', old); dom.window.close(); }
});

test('Cancelled language changes preserve drafts and do not persist a preference', async () => {
  const dom = new JSDOM('<header></header>', { url: 'http://localhost:5173' });
  const keys = ['window', 'document', 'Event']; const previous = keys.map(key => Reflect.get(globalThis, key));
  keys.forEach(key => Reflect.set(globalThis, key, dom.window[key]));
  try {
    const button = installLanguageSwitch(dom.window.document.querySelector('header')!);
    dom.window.addEventListener('recdock:locale-changing', (event: Event) => event.preventDefault());
    button.click(); await Promise.resolve();
    assert.equal(button.textContent, '中文'); assert.equal(dom.window.localStorage.getItem('recdock.uiLanguage'), null);
    dom.window.localStorage.setItem('recdock.chatgptPrompt', '设置 — user-owned prompt');
    initializeLocale('zh-CN'); assert.equal(chatgptPrompt(), '设置 — user-owned prompt');
    initializeLocale('en'); assert.equal(chatgptPrompt(), '设置 — user-owned prompt');
  } finally { keys.forEach((key, index) => Reflect.set(globalThis, key, previous[index])); dom.window.close(); initializeLocale('en'); }
});

test('Website has English HTML and complete in-place Chinese/English switching with persisted choice', () => {
  const source = readFileSync(new URL('../../website/index.html', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../../website/locales.js', import.meta.url), 'utf8');
  const dom = new JSDOM(source, { url: 'https://recdock.example', runScripts: 'outside-only' });
  try {
    assert.equal(dom.window.document.documentElement.lang, 'en');
    assert.match(dom.window.document.querySelector('h1')!.textContent!, /Turn recordings/);
    dom.window.eval(runtime); dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    const toggle = dom.window.document.querySelector('#language-switch')!;
    const href = dom.window.document.querySelector('#download a.button')!.getAttribute('href');
    toggle.click(); assert.equal(dom.window.document.documentElement.lang, 'zh-CN');
    assert.match(dom.window.document.querySelector('h1')!.textContent!, /录音/);
    assert.equal(dom.window.localStorage.getItem('recdock.uiLanguage'), 'zh-CN');
    assert.equal(dom.window.document.querySelector('#download a.button')!.getAttribute('href'), href);
    toggle.click(); assert.equal(dom.window.document.documentElement.lang, 'en');
    const texts = Array.from(dom.window.document.querySelectorAll('body *')).filter((el: any) => !['SCRIPT','STYLE'].includes(el.tagName)).flatMap((el: any) => Array.from(el.childNodes).filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent)).join('');
    assert.deepEqual(texts.match(/[\u3400-\u9fff]+/g), ['中文']);
    assert.match(dom.window.document.title, /useful text/);
  } finally { dom.window.close(); }
});

test('English export labels preserve transcript, title, and speaker names byte-for-byte', async () => {
  const { exportTranscript } = await import('../server/library/transcript-export.ts');
  const fixture = JSON.parse(readFileSync(new URL('../contracts/fixtures/contract-cases.json', import.meta.url), 'utf8')).bases.transcript.data;
  fixture.segments[0].text = '设置 <script>原文</script>';
  fixture.speakers[0].displayName = '转写完成';
  const en = exportTranscript('录音', fixture, [], 'txt', 'en').content;
  const zh = exportTranscript('录音', fixture, [], 'txt', 'zh-CN').content;
  assert.match(en, /Recording ID:/); assert.match(zh, /录音 ID：/);
  for (const text of ['录音', '设置 <script>原文</script>', '转写完成']) { assert.ok(en.includes(text)); assert.ok(zh.includes(text)); }
  assert.equal(exportTranscript('录音', fixture, [], 'json', 'en').content, exportTranscript('录音', fixture, [], 'json', 'zh-CN').content);
});

test('Extension popup defaults to English and remembers an explicit Chinese choice', async () => {
  const base = new URL('../extensions/chatgpt-bridge/', import.meta.url);
  const dom = new JSDOM(readFileSync(new URL('popup.html', base), 'utf8'), { url: 'https://extension.example', runScripts: 'outside-only' });
  let stored: Record<string, string> = {};
  dom.window.chrome = { storage: { local: { get: async () => stored, set: async (value: Record<string, string>) => { stored = { ...stored, ...value }; } } }, runtime: { getURL: (name: string) => name, sendMessage: async () => ({ result: { bound: true } }) } };
  dom.window.fetch = async () => ({ json: async () => JSON.parse(readFileSync(new URL('ui-en.json', base), 'utf8')) });
  try {
    await dom.window.eval('(async () => {' + readFileSync(new URL('popup.js', base), 'utf8') + '})()');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(dom.window.document.documentElement.lang, 'en');
    assert.equal(dom.window.document.querySelector('#bind')!.textContent, 'Connect an existing ChatGPT tab');
    assert.match(dom.window.document.querySelector('#status')!.textContent!, /Connected/);
    dom.window.document.querySelector('#language')!.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(stored['recdock.uiLanguage'], 'zh-CN');
    assert.equal(dom.window.document.querySelector('#bind')!.textContent, '连接现有 ChatGPT 页面');
  } finally { dom.window.close(); }
});
