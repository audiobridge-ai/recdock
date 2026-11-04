import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-ignore jsdom is used only by the DOM test harness, never by the product bundle.
import { JSDOM } from 'jsdom';
import { LibraryWorkspace } from '../src/library/workspace.ts';
import type { DeviceWorkspaceState } from '../src/library/workspace.ts';
import type { AudioTranscript, TranscriptRevision, LibraryRecording } from '../src/library/types.ts';
import { deviceRecordingTitle } from '../src/library/recording-title.ts';

const fixture = JSON.parse(readFileSync(new URL('../contracts/fixtures/contract-cases.json', import.meta.url), 'utf8')).bases.transcript.data as AudioTranscript;
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw Error('DOM condition timed out'); await new Promise(r => setTimeout(r, 5)); }
}
function setup(options: Partial<ConstructorParameters<typeof LibraryWorkspace>[0]> = {}, initialLanguage?: string) {
  const dom = new JSDOM('<header class="topbar"><span class="local-badge"></span></header><main></main>', { url: 'http://localhost:5173/' });
  const keys = ['window', 'document', 'Option', 'location', 'history', 'confirm', 'fetch']; const previous = new Map(keys.map(k => [k, Reflect.get(globalThis, k)]));
  for (const key of ['window', 'document', 'Option', 'location', 'history']) Reflect.set(globalThis, key, key === 'window' ? dom.window : dom.window[key]);
  Reflect.set(globalThis, 'confirm', () => true);
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const downloads: string[] = []; dom.window.HTMLAnchorElement.prototype.click = function(this: HTMLAnchorElement) { downloads.push(this.href); };
  let current = structuredClone(fixture), reviewedIds: string[] = [], conflict = false, accountEmpty = true, personalEmpty = false, accountAvailable = true, accountFailure = false, identity = 'scope_testaccount';
  let source: LibraryRecording['source'] = { kind: 'import', deviceId: null, sessionId: null }, accountTitle = '账号录音';
  const history = new Map([[current.revisionId, structuredClone(current)]]);
  const calls: { path: string; method: string; scope: string | null; data: Record<string, unknown> | undefined }[] = [];
  const row = (scope = 'personal') => ({ recording: { schemaVersion: 1, id: current.recordingId, scopeId: scope === 'personal' ? 'scope_personal' : identity, title: scope === 'personal' ? '合成界面测试' : accountTitle, source: scope === 'personal' || source.kind === 'ble' ? source : { kind: 'ble', deviceId: 'test-device', sessionId: 42 }, sourceSha256: current.sourceSha256, durationMs: current.durationMs, createdAtMs: 1, state: 'stored', assets: [] },
    job: { id: 'job_test', state: 'succeeded', stage: null, error: null }, runtime: null, revision: { revisionId: current.revisionId, machineRevisionId: fixture.revisionId, reviewedIds }, language: 'zh' });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  Reflect.set(globalThis, 'fetch', async (input: string, options: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost:5173'), path = url.pathname, method = options.method || 'GET', data = options.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method, scope: url.searchParams.get('scope'), data });
    if (path.endsWith('/context')) return json({ csrfToken: 'test', accountAvailable, identity: accountAvailable ? identity : 'scope_personal', environment: { available: true, missing: [], maxBytes: 1024 ** 3 } });
    if (path === '/api/library/recordings' && url.searchParams.get('scope') === 'account' && accountFailure) return json({ error: { code: 'ACCOUNT_REQUIRED', message: '请重新登录' } }, 401);
    if (path === '/api/library/recordings') { const scope = url.searchParams.get('scope') || 'personal'; const empty = scope === 'account' ? accountEmpty : personalEmpty; return json({ items: empty ? [] : [row(scope)], total: empty ? 0 : 1 }); }
    if (path.endsWith('/transcript')) {
      const transcript = history.get(url.searchParams.get('revision') || current.revisionId)!;
      const segments = transcript.segments.filter(s => !url.searchParams.get('q') || s.text.includes(url.searchParams.get('q')!));
      return json({ transcript: { ...transcript, segments }, revision: { revisionId: transcript.revisionId, machineRevisionId: fixture.revisionId, reviewedIds: transcript.revisionId === current.revisionId ? reviewedIds : [] }, total: segments.length, totalSegments: transcript.segments.length, cursor: 0, nextCursor: null });
    }
    if (path.endsWith('/revisions') && method === 'GET') return json({ revisions: [...history.values()].map(t => ({ revisionId: t.revisionId, createdAtMs: 1, machine: t.revisionId === fixture.revisionId, current: t.revisionId === current.revisionId })) });
    if (path.endsWith('/revisions') && method === 'POST') {
      if (conflict || data?.baseRevisionId !== current.revisionId) return json({ error: { code: 'REVISION_CONFLICT', message: '稿件已在其他页面更新，请保留当前输入并重新核对。' } }, 409);
      current = structuredClone(current); current.revisionId = 'rev_saved';
      for (const change of data!.changes as TranscriptRevision['changes']) {
        if (change.kind === 'segment_text') current.segments.find(s => s.id === change.segmentId)!.text = change.text;
        if (change.kind === 'segment_reviewed') reviewedIds = change.reviewed ? [...reviewedIds, change.segmentId] : reviewedIds.filter(x => x !== change.segmentId);
      }
      history.set(current.revisionId, structuredClone(current));
      return json({ revision: { revisionId: current.revisionId, machineRevisionId: fixture.revisionId, reviewedIds } });
    }
    if (path === `/api/library/recordings/${current.recordingId}`) return json(row(url.searchParams.get('scope') || 'personal'));
    if (path.endsWith('/jobs') && method === 'POST') return json({ job: { id: 'job_requested', state: 'queued' } });
    if (path.endsWith('/exports')) return json({ url: '/api/library/exports/exp_test', filename: 'test.md' });
    throw Error('Unexpected test API: ' + path);
  });
  if (initialLanguage) dom.window.localStorage.setItem('recdock.transcriptionLanguage', initialLanguage);
  const workspace = new LibraryWorkspace({ parent: document.querySelector('main')!, onVisibility: () => {}, ...options });
  const query = <T extends Element = HTMLElement>(value: string) => workspace.root.querySelector<T>(value)!;
  return { workspace, dom, query, calls, downloads, set source(value: LibraryRecording['source']) { source = value; if (source.kind === 'ble') { personalEmpty = true; accountEmpty = false; } }, set accountAvailable(value: boolean) { accountAvailable = value; }, set accountFailure(value: boolean) { accountFailure = value; }, set identity(value: string) { identity = value; }, set accountTitle(value: string) { accountTitle = value; }, set conflict(value: boolean) { conflict = value; }, set accountEmpty(value: boolean) { accountEmpty = value; },
    async select() { await workspace.open(); query<HTMLButtonElement>('.library-record').click(); await until(() => !!query('.library-paragraph')); },
    async close() { workspace.close(); dom.window.close(); for (const [key, value] of previous) Reflect.set(globalThis, key, value); } };
}

test('录音库界面保存正文后读取服务端版本，纯文本呈现输入，并按完整版本导出', async () => {
  const f = setup();
  try {
    await f.select(); f.query<HTMLButtonElement>('.library-edit').click();
    const text = f.query<HTMLTextAreaElement>('.library-editor textarea'); const updated = '界面测试修改 <img src=x onerror="window.bad=true">'; text.value = updated;
    f.query<HTMLButtonElement>('.library-editor .library-primary').click();
    await until(() => f.query('.library-text').textContent === updated);
    assert.equal(f.query('.library-text').querySelector('img'), null);
    const save = f.calls.find(c => c.method === 'POST' && c.path.endsWith('/revisions'))!;
    assert.equal(save.data!.baseRevisionId, fixture.revisionId);
    assert.deepEqual(save.data!.changes, [{ kind: 'segment_text', segmentId: fixture.segments[0].id, text: updated }]);
    const search = f.query<HTMLInputElement>('[data-field="search"]'); search.value = '没有匹配项'; search.dispatchEvent(new f.dom.window.Event('input'));
    await until(() => !!f.query('.library-empty-results'));
    f.query<HTMLButtonElement>('[data-action="export"]').click(); await until(() => f.downloads.length === 1);
    assert.equal(f.calls.find(c => c.path.endsWith('/exports'))!.data!.revisionId, 'rev_saved');
  } finally { await f.close(); }
});

test('版本冲突保留编辑框与输入，来源筛选不打断当前校对', async () => {
  const f = setup();
  try {
    await f.select(); f.conflict = true; f.query<HTMLButtonElement>('.library-edit').click();
    f.query<HTMLTextAreaElement>('.library-editor textarea').value = '不能丢失的本地输入'; f.query<HTMLButtonElement>('.library-editor .library-primary').click();
    await until(() => f.query('.library-editor-message').textContent!.includes('其他页面'));
    assert.equal(f.query<HTMLTextAreaElement>('.library-editor textarea').value, '不能丢失的本地输入');
    const audio = f.query<HTMLAudioElement>('audio'), src = audio.getAttribute('src');
    const source = f.query<HTMLSelectElement>('[data-field="source"]'); source.value = 'ble'; source.dispatchEvent(new f.dom.window.Event('change'));
    assert.equal(audio.getAttribute('src'), src);
    assert.equal(f.query<HTMLTextAreaElement>('.library-editor textarea').value, '不能丢失的本地输入');
    assert.equal(f.query('[data-view="detail"]').hasAttribute('hidden'), false);
  } finally { await f.close(); }
});

test('历史机器稿可读取和导出，但不能被编辑或误标记为当前校对稿', async () => {
  const f = setup();
  try {
    await f.select(); f.query<HTMLButtonElement>('.library-edit').click(); f.query<HTMLTextAreaElement>('.library-editor textarea').value = '新的校对稿'; f.query<HTMLButtonElement>('.library-editor .library-primary').click();
    await until(() => f.query('.library-text').textContent === '新的校对稿');
    const version = f.query<HTMLSelectElement>('[data-field="version"]'); version.value = fixture.revisionId; version.dispatchEvent(new f.dom.window.Event('change'));
    await until(() => f.query('.library-text').textContent === fixture.segments[0].text.trim());
    assert.equal(f.query<HTMLButtonElement>('.library-edit').disabled, true);
    assert.equal(f.query<HTMLInputElement>('.library-review-check input').disabled, true);
    f.query<HTMLButtonElement>('[data-action="export"]').click(); await until(() => f.downloads.length === 1);
    assert.equal(f.calls.find(c => c.path.endsWith('/exports'))!.data!.revisionId, fixture.revisionId);
  } finally { await f.close(); }
});

const deviceState = (): DeviceWorkspaceState => ({ deviceId: 'test-device', name: '测试 PLAUD', connected: true, canDownload: true, busy: false, status: '空闲', duration: '—', battery: 80, hint: '设备已就绪', files: [{ sessionId: 42, size: 4000 }], transfer: { phase: 'idle', received: 0, total: 0 } });

test('发现与选择设备录音不触发下载；两种操作明确传递语言和转写选择', async () => {
  const downloads: unknown[] = [], f = setup({ onDownload: async (sessionId, options) => { downloads.push({ sessionId, ...options }); } });
  try {
    await f.workspace.open(); f.workspace.updateDevice(deviceState());
    assert.equal(downloads.length, 0);
    f.query<HTMLButtonElement>('.library-device-record').click();
    assert.equal(downloads.length, 0); assert.equal(f.query<HTMLElement>('[data-view="device-detail"]').hidden, false);
    f.workspace.setTranscriptionLanguage('en');
    f.query<HTMLButtonElement>('[data-action="download-only"]').click();
    f.query<HTMLButtonElement>('[data-action="download-transcribe"]').click();
    assert.deepEqual(downloads, [{ sessionId: 42, language: 'en', transcribe: false }, { sessionId: 42, language: 'en', transcribe: true }]);
    const recording = deviceState(); recording.canDownload = false; recording.status = '正在录音'; f.workspace.updateDevice(recording);
    assert.equal(f.query<HTMLButtonElement>('[data-action="download-transcribe"]').disabled, true);
    assert.equal(f.query<HTMLButtonElement>('[data-action="download-only"]').disabled, true);
    assert.equal(f.query('[data-view="device-status"]').textContent, '正在录音');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  } finally { await f.close(); }
});

test('导入和仅导入使用各自的明确选择，默认不会因展示页面而转写', async () => {
  const f = setup(), inputs: { transcribe: boolean; language: string }[] = [], scopes: string[] = [];
  try {
    await f.workspace.open();
    f.workspace.client.scope = 'account';
    f.workspace.client.importFile = async (input, _progress, scope) => { inputs.push(input); scopes.push(scope!); return { recording: { id: fixture.recordingId, state: 'stored' } as any, job: null, duplicate: false, processingError: null }; };
    const files = f.query<HTMLInputElement>('[data-field="files"]');
    Object.defineProperty(files, 'files', { configurable: true, value: [new f.dom.window.File(['audio'], 'test.ogg')] });
    f.query<HTMLButtonElement>('[data-action="import-only"]').click(); files.dispatchEvent(new f.dom.window.Event('change'));
    await until(() => inputs.length === 1 && !f.query<HTMLButtonElement>('[data-action="import"]').disabled);
    assert.equal(inputs[0].transcribe, false);
    f.workspace.setTranscriptionLanguage('en');
    f.query<HTMLButtonElement>('[data-action="import"]').click(); files.dispatchEvent(new f.dom.window.Event('change'));
    await until(() => inputs.length === 2 && !f.query<HTMLButtonElement>('[data-action="import"]').disabled);
    assert.equal(inputs[1].transcribe, true); assert.equal(inputs[1].language, 'en');
    assert.deepEqual(scopes, ['personal', 'personal']);
  } finally { await f.close(); }
});

test('设备断开不清除本地全文；筛选与搜索不改变当前导出版本', async () => {
  const f = setup();
  try {
    await f.select();
    f.workspace.updateDevice(deviceState());
    f.workspace.updateDevice({ ...deviceState(), connected: false, canDownload: false, files: [], hint: '设备已断开' });
    assert.ok(f.query('.library-paragraph')); assert.equal(f.query<HTMLElement>('[data-view="detail"]').hidden, false);
    f.query<HTMLInputElement>('[data-field="list-search"]').value = '不匹配标题'; f.query('[data-field="list-search"]').dispatchEvent(new f.dom.window.Event('input'));
    assert.equal(f.workspace.root.querySelector('.library-record'), null);
    f.query<HTMLButtonElement>('[data-action="export"]').click(); await until(() => f.downloads.length === 1);
    assert.equal(f.calls.find(call => call.path.endsWith('/exports'))!.data!.revisionId, fixture.revisionId);
  } finally { await f.close(); }
});

test('已保存设备录音只显示一条，后续转写复用本地文件并保留用户选择的语言', async () => {
  const f = setup({ onDownload: async () => { throw Error('不应再次下载'); } });
  try {
    f.source = { kind: 'ble', deviceId: 'test-device', sessionId: 42 };
    await f.workspace.open(); f.workspace.updateDevice(deviceState());
    assert.equal(f.workspace.root.querySelectorAll('.library-device-record').length, 0);
    assert.equal(f.workspace.root.querySelectorAll('.library-record').length, 1);
    assert.equal(await f.workspace.reuseDeviceRecording('test-device', 42, { transcribe: false, language: 'en' }), true);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(await f.workspace.reuseDeviceRecording('test-device', 42, { transcribe: true, language: 'en' }), true);
    assert.deepEqual(f.calls.find(call => call.path.endsWith('/jobs'))?.data, { language: 'en' });
  } finally { await f.close(); }
});

test('未登录可使用工作台；设备与设置入口保持音频、正文位置和未保存输入', async () => {
  let deviceOpens = 0, settingsOpens = 0;
  const f = setup({ onOpenDevice: () => { deviceOpens++; }, onOpenSettings: () => { settingsOpens++; } });
  try {
    f.accountAvailable = false; await f.select();
    const audio = f.query<HTMLAudioElement>('audio'), src = audio.src;
    audio.currentTime = 1.5;
    f.query<HTMLButtonElement>('.library-edit').click();
    const editor = f.query<HTMLTextAreaElement>('.library-editor textarea'); editor.value = '尚未保存的校对';
    const reader = f.query<HTMLElement>('[data-view="reader"]'); reader.scrollTop = 120;
    f.query<HTMLButtonElement>('[data-action="device-settings"]').click();
    f.query<HTMLButtonElement>('[data-action="workspace-settings"]').click();
    assert.equal(deviceOpens, 1); assert.equal(settingsOpens, 1);
    assert.equal(f.workspace.root.hidden, false); assert.equal(location.hash, '#library');
    assert.equal(f.query('.library-editor textarea'), editor); assert.equal(editor.value, '尚未保存的校对');
    assert.equal(audio.src, src); assert.equal(audio.currentTime, 1.5); assert.equal(reader.scrollTop, 120);
    assert.equal(f.calls.filter(c => c.scope === 'account').length, 0);
  } finally { await f.close(); }
});

test('恢复登录与退出账号不影响本机校对；账号失效立即移除账号音频与正文', async () => {
  const f = setup();
  try {
    f.accountAvailable = false; await f.select();
    f.query<HTMLButtonElement>('.library-edit').click();
    const editor = f.query<HTMLTextAreaElement>('.library-editor textarea'); editor.value = '本机草稿';
    const audio = f.query<HTMLAudioElement>('audio'), src = audio.src;
    f.accountAvailable = true; f.accountEmpty = false;
    f.workspace.updateAccount({ authenticated: true, restoring: false, busy: false, connecting: false });
    await f.workspace.refreshIdentity();
    assert.equal(f.query('.library-editor textarea'), editor); assert.equal(editor.value, '本机草稿'); assert.equal(audio.src, src);
    assert.equal(f.workspace.root.querySelectorAll('.library-record').length, 2);
    f.workspace.updateAccount({ authenticated: false, restoring: false, busy: false, connecting: false });
    assert.equal(f.query('.library-editor textarea'), editor); assert.equal(audio.src, src);
    assert.equal(f.workspace.root.querySelectorAll('[data-scope="account"]').length, 0);
    // Re-enter the account list, then revoke access while its transcript is selected.
    f.workspace.updateAccount({ authenticated: true, restoring: false, busy: false, connecting: false });
    await f.workspace.refreshIdentity();
    f.query<HTMLButtonElement>('.library-editor button:not(.library-primary)').click();
    f.query<HTMLButtonElement>('[data-scope="account"]').click();
    await until(() => audio.src.includes('scope=account') && !f.query('[data-view="reader"]').hasAttribute('hidden'));
    f.workspace.updateAccount({ authenticated: false, restoring: false, busy: false, connecting: false });
    assert.equal(audio.getAttribute('src'), null);
    assert.equal(f.query('[data-view="paragraphs"]').children.length, 0);
    assert.equal(f.query('[data-view="detail"]').hasAttribute('hidden'), true);
    f.accountAvailable = false; await f.workspace.refreshIdentity();
    assert.equal(f.workspace.root.querySelectorAll('.library-record').length, 1);
  } finally { await f.close(); }
});

test('统一列表按来源筛选；账号录音的播放与导出始终使用账号范围', async () => {
  const f = setup();
  try {
    f.accountEmpty = false; await f.workspace.open();
    assert.equal(f.workspace.root.querySelectorAll('.library-record').length, 2);
    const source = f.query<HTMLSelectElement>('[data-field="source"]');
    source.value = 'ble'; source.dispatchEvent(new f.dom.window.Event('change'));
    assert.equal(f.workspace.root.querySelectorAll('.library-record').length, 1);
    f.query<HTMLButtonElement>('.library-record').click();
    await until(() => !!f.query('.library-paragraph'));
    assert.match(f.query<HTMLAudioElement>('audio').src, /scope=account/);
    source.value = 'import'; source.dispatchEvent(new f.dom.window.Event('change'));
    assert.equal(f.workspace.root.querySelectorAll('.library-record').length, 1);
    assert.equal(f.query('.library-record').getAttribute('data-scope'), 'personal');
    f.query<HTMLButtonElement>('[data-action="export"]').click(); await until(() => f.downloads.length === 1);
    assert.equal(f.calls.find(c => c.path.endsWith('/exports'))!.scope, 'account');
  } finally { await f.close(); }
});

test('已连接设备菜单提供原地操作，退出账号只通过明确点击触发', async () => {
  const actions: string[] = [], f = setup({ onOpenDevice: () => { actions.push('details'); }, onRefreshDevice: () => { actions.push('refresh'); }, onSwitchDevice: () => { actions.push('switch'); }, onDisconnectDevice: () => { actions.push('disconnect'); }, onLogout: () => { actions.push('logout'); } });
  try {
    await f.select();
    f.workspace.updateAccount({ authenticated: true, restoring: false, busy: false, connecting: false, email: 'test@example.invalid' });
    f.workspace.updateDevice(deviceState());
    f.query<HTMLButtonElement>('[data-action="device-settings"]').click();
    assert.equal(f.query('[data-view="device-menu"]').hasAttribute('hidden'), false);
    assert.deepEqual(actions, []);
    f.query<HTMLButtonElement>('[data-action="menu-refresh"]').click();
    assert.equal(f.query('[data-view="device-menu"]').hasAttribute('hidden'), true);
    for (const action of ['device-details', 'switch-device', 'disconnect-device']) {
      f.query<HTMLButtonElement>('[data-action="device-settings"]').click();
      f.query<HTMLButtonElement>(`[data-action="${action}"]`).click();
    }
    f.query<HTMLButtonElement>('[data-action="account-menu"]').click();
    assert.equal(f.query('[data-view="account-label"]').textContent, 'test@example.invalid');
    f.query<HTMLButtonElement>('[data-action="account-logout"]').click();
    assert.deepEqual(actions, ['refresh', 'details', 'switch', 'disconnect', 'logout']);
    assert.equal(f.workspace.root.hidden, false); assert.ok(f.query('.library-paragraph'));
  } finally { await f.close(); }
});

test('账号列表授权失败不阻塞本机录音与正文', async () => {
  const f = setup();
  try {
    f.accountFailure = true; await f.select();
    assert.ok(f.query('.library-paragraph'));
    assert.equal(f.query<HTMLAudioElement>('audio').src.includes('scope=personal'), true);
    assert.equal(f.workspace.root.querySelectorAll('.library-record').length, 1);
    assert.match(f.query('.library-notice').textContent!, /本机录音仍可使用/);
  } finally { await f.close(); }
});

test('直接切换账号立即移除旧账号详情，等待新身份校验后再展示', async () => {
  const f = setup();
  try {
    f.accountEmpty = false;
    f.workspace.updateAccount({ authenticated: true, accountId: 'account-a', restoring: false, busy: false, connecting: false });
    await f.workspace.open(); f.query<HTMLButtonElement>('[data-scope="account"]').click();
    await until(() => !!f.query('.library-paragraph'));
    f.workspace.updateAccount({ authenticated: true, accountId: 'account-b', restoring: false, busy: false, connecting: false });
    assert.equal(f.query<HTMLAudioElement>('audio').getAttribute('src'), null);
    assert.equal(f.query('[data-view="paragraphs"]').children.length, 0);
    assert.equal(f.workspace.root.querySelectorAll('[data-scope="account"]').length, 0);
    f.identity = 'scope_account_b'; await f.workspace.refreshIdentity();
    assert.equal(f.workspace.root.querySelectorAll('[data-scope="account"]').length, 1);
    assert.equal(f.query('[data-view="detail"]').hasAttribute('hidden'), true);
  } finally { await f.close(); }
});

test('导入与筛选按需展开，菜单互斥、筛选重置和 Escape 不打断校对与播放', async () => {
  const f = setup();
  try {
    await f.select();
    const audio = f.query<HTMLAudioElement>('audio'), src = audio.src; audio.currentTime = 1.2;
    f.query<HTMLButtonElement>('.library-edit').click();
    const editor = f.query<HTMLTextAreaElement>('.library-editor textarea'); editor.value = '菜单不能丢失的草稿';
    let fileChoosers = 0; f.query<HTMLInputElement>('[data-field="files"]').click = () => { fileChoosers++; };
    assert.equal(f.query<HTMLElement>('[data-view="import-menu"]').hidden, true);
    assert.equal(f.query<HTMLElement>('[data-view="filter-menu"]').hidden, true);
    f.query<HTMLButtonElement>('[data-action="import-menu"]').click();
    assert.equal(f.query<HTMLElement>('[data-view="import-menu"]').hidden, false);
    assert.equal(fileChoosers, 0);
    f.query<HTMLButtonElement>('[data-action="import-only"]').click();
    assert.equal(fileChoosers, 1); assert.equal(f.query<HTMLElement>('[data-view="import-menu"]').hidden, true);
    f.query<HTMLButtonElement>('[data-action="import-menu"]').click();
    f.query<HTMLButtonElement>('[data-action="filter-menu"]').click();
    assert.equal(f.query<HTMLElement>('[data-view="import-menu"]').hidden, true);
    for (const [name, value] of [['source', 'ble'], ['list-filter', 'processing']]) { const select = f.query<HTMLSelectElement>(`[data-field="${name}"]`); select.value = value; select.dispatchEvent(new f.dom.window.Event('change')); }
    assert.equal(f.query('[data-view="filter-count"]').textContent, '2');
    assert.equal(f.workspace.root.querySelectorAll('.library-record').length, 0);
    f.query<HTMLButtonElement>('[data-action="reset-filters"]').click();
    assert.equal(f.query<HTMLElement>('[data-view="filter-count"]').hidden, true);
    assert.equal(f.workspace.root.querySelectorAll('.library-record').length, 1);
    f.dom.window.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(f.query<HTMLElement>('[data-view="filter-menu"]').hidden, true);
    assert.equal(f.dom.window.document.activeElement, f.query('[data-action="filter-menu"]'));
    assert.equal(f.query('.library-editor textarea'), editor); assert.equal(editor.value, '菜单不能丢失的草稿');
    assert.equal(audio.src, src); assert.equal(audio.currentTime, 1.2);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  } finally { await f.close(); }
});

test('统一语言偏好可恢复和保存，选择已有录音不会覆盖设置', async () => {
  const f = setup({}, 'en');
  try {
    assert.equal(f.workspace.transcriptionLanguage, 'en');
    await f.select(); // The existing recording's language is zh.
    assert.equal(f.workspace.transcriptionLanguage, 'en');
    assert.equal(f.workspace.root.querySelector('[data-field="language"]'), null);
    f.workspace.setTranscriptionLanguage('zh');
    assert.equal(f.workspace.transcriptionLanguage, 'zh');
    assert.equal(f.dom.window.localStorage.getItem('recdock.transcriptionLanguage'), 'zh');
  } finally { await f.close(); }
});

test('精简设备栏显示真实录音状态和零电量，断开后清空过期数据', async () => {
  const f = setup();
  try {
    await f.workspace.open();
    f.workspace.updateDevice({ ...deviceState(), battery: 0, status: '正在录音', duration: '00:01:23' });
    assert.equal(f.query('[data-view="device-battery"]').textContent, '0%');
    assert.equal(f.query('[data-view="battery-fill"]').getAttribute('width'), '0');
    assert.equal(f.query('[data-view="device-status"]').textContent, '正在录音');
    assert.equal(f.query('[data-view="device-duration"]').textContent, '00:01:23');
    f.workspace.updateDevice({ ...deviceState(), connected: false, canDownload: false, files: [] });
    assert.equal(f.query('[data-view="device-name"]').textContent, '连接 PLAUD');
    assert.equal(f.query('[data-view="device-battery"]').textContent, '');
    assert.equal(f.query('[data-view="device-duration"]').textContent, '');
    assert.equal(f.workspace.root.querySelector('[data-action="connect-device"]'), null);
  } finally { await f.close(); }
});

test('已下载设备默认标题显示本地日期，按日期或原始编号搜索，自定义名不覆盖', async () => {
  const f = setup(), sessionId = 1793762511;
  try {
    f.source = { kind: 'ble', deviceId: 'test-device', sessionId }; f.accountTitle = `plaud-${sessionId}`;
    await f.select();
    const expected = deviceRecordingTitle(sessionId);
    assert.equal(f.query('.library-record strong').textContent, expected);
    assert.equal(f.query('[data-view="title"]').textContent, expected);
    assert.match(f.query<HTMLButtonElement>('.library-record').title, /1793762511/);
    const search = f.query<HTMLInputElement>('[data-field="list-search"]');
    for (const query of [expected.slice(0, 10), String(sessionId)]) { search.value = query; search.dispatchEvent(new f.dom.window.Event('input')); assert.equal(f.workspace.root.querySelectorAll('.library-record').length, 1); }
    search.value = ''; search.dispatchEvent(new f.dom.window.Event('input'));
    f.accountTitle = '项目例会'; await f.workspace.refreshIdentity();
    assert.equal(f.query('.library-record strong').textContent, '项目例会');
    assert.equal(f.query('[data-view="title"]').textContent, '项目例会');
    assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
  } finally { await f.close(); }
});

test('待下载设备录音使用相同日期标题，文件编号继续用于选择与下载', async () => {
  const calls: number[] = [], f = setup({ onDownload: async sessionId => { calls.push(sessionId); } }), sessionId = 1793762511;
  try {
    await f.workspace.open(); f.workspace.updateDevice({ ...deviceState(), files: [{ sessionId, size: 4000 }] });
    const file = f.query<HTMLButtonElement>('.library-device-record');
    assert.equal(file.querySelector('strong')!.textContent, deviceRecordingTitle(sessionId));
    file.click(); assert.equal(f.query('[data-view="device-file-title"]').textContent, deviceRecordingTitle(sessionId));
    f.query<HTMLButtonElement>('[data-action="download-only"]').click();
    assert.deepEqual(calls, [sessionId]);
  } finally { await f.close(); }
});
