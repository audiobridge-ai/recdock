import { workspaceMarkup, recordingIcon } from './view.ts';
import { LibraryClient } from './client.ts';
import type { LibraryContext, LibraryEnvironment, RecordingRow, TranscriptPage } from './client.ts';
import type { TranscriptRevision, TranscriptSegment } from './types.ts';
import type { PlayableRecording } from '../audio/ogg.ts';
import type { RecordingFile } from '../protocol/files.ts';
import type { TransferStatus } from '../ui/recordings.ts';
import { transferView } from '../ui/recordings.ts';
import { formatBytes } from '../protocol/status.ts';
import { deviceRecordingTitle, recordingTitle } from './recording-title.ts';
import { ChatGPTForwarder } from '../chatgpt/forwarder.ts';
import type { ForwardBridge } from '../chatgpt/forwarder.ts';

export interface DeviceWorkspaceState { deviceId?: string; name: string; connected: boolean; canDownload: boolean; busy: boolean; status: string; duration: string; battery?: number; files: RecordingFile[]; transfer: TransferStatus; hint: string }
export interface DownloadOptions { transcribe: boolean; language: 'zh' | 'en' }
export interface AccountWorkspaceState { authenticated: boolean; restoring: boolean; accountId?: string; email?: string; busy: boolean; connecting: boolean; error?: string }
type Scope = 'personal' | 'account';
type ScopedRecordingRow = RecordingRow & { scope: Scope };
interface WorkspaceOptions { parent: HTMLElement; onVisibility: (visible: boolean) => void; onDownload?: (sessionId: number, options: DownloadOptions) => Promise<void>; onCancelDownload?: () => void; onRefreshDevice?: () => void; onOpenSettings?: (section?: 'chatgpt') => void; onOpenDevice?: () => void; onDisconnectDevice?: () => void; onSwitchDevice?: () => void; onLogout?: () => void; onEnvironment?: (environment: LibraryEnvironment) => void; chatgptBridge?: ForwardBridge };
const menus = [['device-menu', 'device-settings'], ['account-menu', 'account-menu'], ['import-menu', 'import-menu'], ['filter-menu', 'filter-menu']] as const;

const stageNames: Record<string, string> = { preparing: '检查与解码', transcribing: '转写文字', aligning: '对齐时间', diarizing: '区分讲话人', merging: '合并全文', exporting: '生成导出' };
const stateNames: Record<string, string> = { queued: '等待处理', running: '正在处理', succeeded: '转写完成', failed: '处理失败', cancelled: '已取消', interrupted: '处理中断', paused: '等待账号恢复' };
const flagNames: Record<string, string> = { speaker_uncertain: '讲话人待确认', unaligned: '时间待核对', overlap: '可能换人或重叠', pending_alignment: '文字或时间已修改，请回听核对', user_edited: '人工修改' };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) => { const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value; };
const clock = (ms: number) => { const seconds = Math.floor(ms / 1000); return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':'); };
function precise(ms: number) { return clock(ms) + '.' + String(ms % 1000).padStart(3, '0'); }
function parseTime(value: string) { if (!/^\d{1,3}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)) return NaN; const [h, m, s] = value.split(':').map(Number); return m < 60 && s < 60 ? Math.round((h * 3600 + m * 60 + s) * 1000) : NaN; }

export class LibraryWorkspace {
  readonly client: LibraryClient;
  readonly root: HTMLElement;
  private visible = false;
  private context?: LibraryContext;
  private selected?: ScopedRecordingRow;
  private page?: TranscriptPage;
  private generation = 0;
  private pageRequest = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private importing = false;
  private saving = false;
  private editing = false;
  private query = '';
  private speaker = '';
  private mode = 'all';
  private version = '';
  private cursor = 0;
  private trash = false;
  private playEnd: number | null = null;
  private lastFollow = 0;
  private playingId: string | null = null;
  private listSignature = '';
  private onVisibility: (visible: boolean) => void;
  private entry: HTMLButtonElement;
  private deviceState?: DeviceWorkspaceState;
  private selectedDevice?: number;
  private rows: ScopedRecordingRow[] = [];
  private listFilter = 'all';
  private sourceFilter = 'all';
  private accountState?: AccountWorkspaceState;
  private importingWithTranscription = true;
  private language: 'zh' | 'en' = 'zh';
  private options: WorkspaceOptions;
  private forwarder: ChatGPTForwarder;
  constructor(options: WorkspaceOptions) {
    this.options = options;
    this.client = new LibraryClient();
    try { const source = window.localStorage.getItem('recdock.librarySource'); if (source === 'import' || source === 'ble') this.sourceFilter = source; } catch { /* In-page preferences remain available. */ }
    try { if (window.localStorage.getItem('recdock.transcriptionLanguage') === 'en') this.language = 'en'; } catch { /* Defaults also work without browser storage. */ }
    this.onVisibility = options.onVisibility;
    this.root = el('section', 'audio-library'); this.root.id = 'audio-library'; this.root.hidden = true;
    this.root.innerHTML = workspaceMarkup;
    this.field('source').value = this.sourceFilter;
    options.parent.append(this.root);
    this.forwarder = new ChatGPTForwarder(this.client, () => this.renderForward(), options.chatgptBridge);
    this.entry = el('button', 'text-button library-entry', '录音'); this.entry.id = 'open-library'; this.entry.type = 'button';
    document.querySelector('.topbar')?.insertBefore(this.entry, document.querySelector('.local-badge')); this.entry.onclick = () => { void this.open(); };
    this.bind();
    window.addEventListener('beforeunload', event => { if (this.editing) { event.preventDefault(); event.returnValue = ''; } });
    window.addEventListener('pagehide', () => { clearTimeout(this.timer); clearTimeout(this.noticeTimer); this.forwarder.select(); });
    window.addEventListener('pageshow', () => { if (this.visible) this.schedule(); });
  }
  private view<T extends HTMLElement = HTMLElement>(name: string) { return this.root.querySelector<T>(`[data-view="${name}"]`)!; }
  private field<T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(name: string) { return this.root.querySelector<T>(`[data-field="${name}"]`)!; }
  private button(name: string) { return this.root.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!; }
  private audio() { return this.root.querySelector('audio')!; }
  private notice(message: string, error = false) {
    const box = this.root.querySelector<HTMLElement>('.library-notice')!;
    clearTimeout(this.noticeTimer); box.textContent = message; box.classList.toggle('error', error);
    box.hidden = !message || ['正在读取本机录音库…', '录音、全文与已保存的修改都保存在本机。'].includes(message);
    if (!box.hidden && !error) this.noticeTimer = setTimeout(() => { box.hidden = true; }, 6000);
  }
  private failure(error: unknown) { this.notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
  private discard() { if (!this.editing) return true; if (!confirm('本段有尚未保存的修改。离开将放弃这些修改，继续吗？')) return false; this.editing = false; return true; }
  initialize() { return this.refreshContext(); }
  get transcriptionLanguage() { return this.language; }
  setTranscriptionLanguage(language: 'zh' | 'en') { this.language = language === 'en' ? 'en' : 'zh'; try { window.localStorage.setItem('recdock.transcriptionLanguage', this.language); } catch { /* The setting remains usable in this page. */ } }
  async refreshIdentity() { if (this.visible) { try { await this.refreshContext(); await this.refresh(); } catch (e) { this.failure(e); } } }
  async open() {
    if (this.visible) return;
    this.visible = true; this.root.hidden = false; this.entry.setAttribute('aria-current', 'page'); this.onVisibility(true); history.replaceState(null, '', '#library');
    this.notice('正在读取本机录音库…');
    try { await this.refreshContext(); await this.refresh(); if (!this.importing) this.notice('录音、全文与已保存的修改都保存在本机。'); }
    catch (e) { this.failure(e); } finally { this.schedule(); }
  }
  close() { if (!this.discard()) return false; this.visible = false; this.root.hidden = true; this.entry.removeAttribute('aria-current'); clearTimeout(this.timer); clearTimeout(this.noticeTimer); this.forwarder.select(); this.audio().pause(); this.onVisibility(false); return true; }
  private get accountAvailable() { return !!this.context?.accountAvailable && (!this.accountState || this.accountState.authenticated || this.accountState.restoring); }
  private async refreshContext() {
    const previousIdentity = this.context?.identity;
    this.context = await this.client.context();
    if ((previousIdentity && previousIdentity !== this.context.identity) || !this.accountAvailable) this.dropAccountView();
    this.renderList();
    this.options.onEnvironment?.(this.context.environment);
  }
  private schedule() { clearTimeout(this.timer); if (this.visible) this.timer = setTimeout(() => { void this.refresh().catch(async e => { try { await this.refreshContext(); await this.refresh(); } catch { this.failure(e); } }).finally(() => this.schedule()); }, 2500); }
  private clearSelected(clearList = true) { this.generation++; this.selected = undefined; this.selectedDevice = undefined; this.page = undefined; this.forwarder.select(); this.listSignature = ''; this.audio().pause(); this.audio().removeAttribute('src'); this.view('detail').hidden = true; this.view('device-detail').hidden = true; this.view('rename-form').hidden = true; this.view('empty').hidden = false; this.view('paragraphs').replaceChildren(); if (clearList) { this.rows = []; this.view('list').replaceChildren(); } }
  private async refresh() {
    const generation = this.generation;
    const scopes: Scope[] = this.accountAvailable ? ['personal', 'account'] : ['personal'];
    const results = await Promise.all(scopes.map(async scope => {
      try { return { scope, result: await this.client.request<{ items: RecordingRow[]; total: number }>(`recordings?limit=100&trash=${this.trash}`, undefined, 'GET', scope), failed: false }; }
      catch (error) { if (scope === 'personal') throw error; return { scope, result: { items: [] as RecordingRow[], total: 0 }, failed: true }; }
    }));
    if (generation !== this.generation) return;
    const accountFailed = results.some(result => result.failed);
    if (accountFailed && (this.selected?.scope === 'account' || this.selectedDevice !== undefined)) { this.editing = false; this.clearSelected(false); this.client.scope = 'personal'; }
    this.rows = results.flatMap(({ scope, result }) => result.items.map(row => ({ ...row, scope }))).sort((a, b) => b.recording.createdAtMs - a.recording.createdAtMs);
    this.renderList(results.reduce((sum, { result }) => sum + result.total, 0));
    if (this.selected) {
      const row = this.rows.find(r => r.scope === this.selected!.scope && r.recording.id === this.selected!.recording.id);
      if (!row) { this.clearSelected(false); return; }
      const previousJobState = this.selected.job?.state;
      const changed = row.revision?.revisionId !== this.selected.revision?.revisionId || row.job?.state !== previousJobState;
      this.selected = row; this.renderHeader();
      if (previousJobState !== row.job?.state && row.job?.state === 'succeeded') this.notice('转写已完成，全文与可读文字文件已保存在录音目录中。');
      if (previousJobState !== row.job?.state && row.job?.state === 'failed') this.notice(row.job.error?.message || '处理未完成，音频已保留，可重试。', true);
      if (row.revision && (!this.page || changed) && !this.editing && !this.saving) await this.loadTranscript();
    }
    if (accountFailed) { this.failure(new Error('PLAUD 录音暂时无法读取，本机录音仍可使用。请检查账号后重试。')); void this.refreshContext().catch(() => {}); }
  }
  private renderList(total = this.rows.length) {
    const query = this.field('list-search').value.trim().toLocaleLowerCase();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const device = this.deviceState;
    const pending = !this.trash && this.accountAvailable ? (device?.files || []).filter(file => !this.rows.some(row => row.recording.source.kind === 'ble' && row.recording.source.deviceId === device?.deviceId && row.recording.source.sessionId === file.sessionId)) : [];
    const rows = this.rows.filter(row => (this.sourceFilter === 'all' || row.recording.source.kind === this.sourceFilter) && (!query || row.recording.title.toLocaleLowerCase().includes(query) || recordingTitle(row.recording, timeZone).toLocaleLowerCase().includes(query) || row.recording.source.kind === 'ble' && String(row.recording.source.sessionId).includes(query)) && (this.trash || this.listFilter === 'all' || this.listFilter === 'local' || this.listFilter === 'processing' && ['queued', 'running', 'paused', 'interrupted'].includes(row.job?.state || '') || this.listFilter === 'ready' && !!row.revision));
    const deviceFiles = this.sourceFilter !== 'import' && ['all', 'device'].includes(this.listFilter) ? pending.filter(file => !query || String(file.sessionId).includes(query) || deviceRecordingTitle(file.sessionId, timeZone).includes(query)) : [];
    const activeFilters = Number(this.sourceFilter !== 'all') + Number(this.listFilter !== 'all');
    this.view('list-total').textContent = String(activeFilters ? rows.length + deviceFiles.length : total + pending.length);
    this.view('list-title').textContent = this.trash ? '回收站' : '录音';
    this.view('filter-count').textContent = String(activeFilters); this.view('filter-count').hidden = !activeFilters;
    this.button('filter-menu').classList.toggle('active', !!activeFilters);
    this.button('filter-menu').setAttribute('aria-label', activeFilters ? `筛选录音，已启用 ${activeFilters} 项条件` : '筛选录音');
    this.button('reset-filters').disabled = !activeFilters;
    const signature = JSON.stringify([timeZone, this.sourceFilter, this.trash, this.listFilter, query, this.selected?.scope, this.selected?.recording.id, this.selectedDevice, device?.deviceId, deviceFiles, rows.map(row => [row.scope, row.recording.id, row.recording.title, row.recording.state, row.job?.state, row.job?.stage, row.revision?.revisionId])]);
    if (signature === this.listSignature) return;
    this.listSignature = signature; this.view('list').replaceChildren();
    for (const file of deviceFiles) {
      const button = el('button', 'library-record library-device-record' + (this.selectedDevice === file.sessionId ? ' selected' : ''));
      this.decorateFile(button, deviceRecordingTitle(file.sessionId, timeZone), `${formatBytes(BigInt(file.size))} · 设备待下载`);
      button.title = `设备文件编号：${file.sessionId} · 当前时区：${timeZone}`;
      button.onclick = () => { if (!this.discard()) return; this.clearSelected(false); this.selectedDevice = file.sessionId; this.renderDeviceDetail(); this.renderList(); };
      this.view('list').append(button);
    }
    for (const row of rows) {
      const button = el('button', 'library-record' + (this.selected?.scope === row.scope && this.selected?.recording.id === row.recording.id ? ' selected' : '')); button.dataset.scope = row.scope;
      const onDevice = row.recording.source.kind === 'ble' && row.recording.source.deviceId === device?.deviceId && device?.files.some(file => file.sessionId === row.recording.source.sessionId);
      this.decorateFile(button, recordingTitle(row.recording, timeZone), `${row.recording.durationMs ? clock(row.recording.durationMs) : '待检查音频'} · ${this.status(row)} · ${row.recording.source.kind === 'ble' ? (onDevice ? 'PLAUD · 本机与设备' : 'PLAUD') : '本机导入'}`);
      if (row.recording.source.kind === 'ble') button.title = `设备文件编号：${row.recording.source.sessionId} · 当前时区：${timeZone}`;
      button.onclick = () => { if (this.discard()) void this.select(row).catch(e => this.failure(e)); }; this.view('list').append(button);
    }
    if (!rows.length && !deviceFiles.length) this.view('list').append(el('p', 'library-list-empty', this.trash ? '回收站为空' : this.sourceFilter === 'ble' || this.listFilter === 'device' ? '暂无符合条件的 PLAUD 录音。可从顶部连接设备。' : '暂无符合条件的录音。可连接设备或导入音频。'));
    if (total > this.rows.length) this.view('list').append(el('p', 'library-list-empty', `显示最近 ${this.rows.length} 条，共 ${total} 条。`));
  }
  private decorateFile(button: HTMLButtonElement, title: string, metadata: string) {
    const icon = el('span', 'library-file-icon'); icon.innerHTML = recordingIcon; icon.setAttribute('aria-hidden', 'true');
    const copy = el('span', 'library-file-copy'); copy.append(el('strong', '', title), el('small', '', metadata)); button.append(icon, copy);
  }
  private dropAccountView() {
    this.generation++;
    this.rows = this.rows.filter(row => row.scope === 'personal');
    if (this.selected?.scope === 'account' || this.selectedDevice !== undefined) { this.editing = false; this.clearSelected(false); this.client.scope = 'personal'; }
    this.listSignature = ''; this.renderList();
  }
  updateAccount(state: AccountWorkspaceState) {
    const previous = this.accountState; this.accountState = state;
    if ((!state.authenticated && !state.restoring && (!previous || previous.authenticated || previous.restoring)) || (previous?.authenticated && previous.accountId !== state.accountId)) this.dropAccountView();
    this.view('account-label').textContent = state.authenticated ? state.email || '已登录 PLAUD' : state.restoring ? '正在恢复账号信息…' : '未登录 · 本机音频功能可用';
    this.button('account-login').hidden = state.authenticated;
    this.button('account-login').disabled = state.restoring || state.busy;
    this.button('account-logout').hidden = !state.authenticated;
    this.button('account-logout').disabled = state.busy;
    this.view('account-status').textContent = state.authenticated ? '已登录' : '未登录';
    this.button('account-menu').setAttribute('aria-label', `PLAUD 账号：${state.authenticated ? '已登录' : '未登录'}`);
    this.renderDeviceBar();
  }
  private renderDeviceBar() {
    const state = this.deviceState, account = this.accountState;
    this.view('device-name').textContent = state?.connected || account?.connecting ? state?.name || 'PLAUD 设备' : '连接 PLAUD';
    this.view('device-status').textContent = state?.connected ? state.status : account?.connecting ? '连接中…' : account?.restoring ? '恢复账号…' : account?.error ? '连接异常' : '';
    this.button('device-settings').title = account?.error || (state?.connected ? '查看设备状态与操作' : '连接 PLAUD 设备');
    this.view('device-duration').textContent = state?.connected && state.duration !== '—' ? state.duration : '';
    this.view('device-battery').textContent = state?.connected && state.battery !== undefined ? `${state.battery}%` : '';
    this.view('device-battery').setAttribute('aria-label', state?.battery === undefined ? '' : `电量 ${state.battery}%`);
    this.view('battery-fill').setAttribute('width', String(11 * Math.max(0, Math.min(100, state?.battery ?? 0)) / 100));
    this.root.querySelector('.library-device-bar')!.classList.toggle('connected', !!state?.connected);
    this.root.querySelector('.library-device-bar')!.classList.toggle('connecting', !!account?.connecting);
    this.view('device-menu-status').textContent = `${state?.name || 'PLAUD'} · ${this.view('device-status').textContent}${state?.connected && state.battery !== undefined ? ` · 电量 ${state.battery}%` : ''}`;
    this.button('menu-refresh').disabled = !state?.canDownload || state.busy;
    this.button('disconnect-device').disabled = !state?.connected || !!account?.busy;
    this.button('switch-device').disabled = !!account?.busy;
  }
  private closeMenus() {
    for (const [view, action] of menus) { this.view(view).hidden = true; this.button(action).setAttribute('aria-expanded', 'false'); }
  }
  private openDevice() { this.closeMenus(); this.button('device-settings').focus(); this.options.onOpenDevice?.(); }
  private toggleMenu(view: string, action: string) { const opening = this.view(view).hidden; this.closeMenus(); this.view(view).hidden = !opening; this.button(action).setAttribute('aria-expanded', String(opening)); }
  updateDevice(state: DeviceWorkspaceState) {
    const previous = this.deviceState;
    if (previous?.deviceId !== state.deviceId && this.selectedDevice !== undefined) this.clearSelected();
    this.deviceState = state;
    this.renderDeviceBar();
    if (previous?.connected && state.connected && state.files.some(file => !previous.files.some(old => old.sessionId === file.sessionId))) this.notice('发现新的设备录音，选择后可下载或下载并转写。');
    this.renderDeviceDetail(); this.renderList();
  }
  reportDownload(message: string, error = false) { this.notice(message, error); }
  updateDeviceClock(duration: string) { if (this.deviceState?.connected) this.view('device-duration').textContent = duration === '—' ? '' : duration; }
  private renderDeviceDetail() {
    if (this.selectedDevice === undefined || !this.deviceState) return;
    const state = this.deviceState, file = state.files.find(file => file.sessionId === this.selectedDevice);
    this.view('empty').hidden = true; this.view('detail').hidden = true; this.view('device-detail').hidden = false;
    this.view('device-file-title').textContent = deviceRecordingTitle(this.selectedDevice);
    this.view('device-file-meta').textContent = `${state.name} · 文件编号 ${this.selectedDevice}${file ? ' · ' + formatBytes(BigInt(file.size)) : ''} · 默认保存 Ogg`;
    this.view('device-hint').textContent = state.hint;
    for (const action of ['download-transcribe', 'download-only']) this.button(action).disabled = !file || !state.canDownload || state.busy || file.size > 256 * 1024 * 1024;
    const transfer = transferView(state.transfer), active = state.transfer.sessionId === this.selectedDevice;
    this.view<HTMLProgressElement>('device-progress').value = active ? transfer.percent : 0;
    this.view('device-transfer').textContent = active ? `${transfer.label} · ${Math.floor(transfer.percent)}% · ${formatBytes(BigInt(transfer.received))} / ${formatBytes(BigInt(transfer.total))} ${transfer.detail}` : file && file.size > 256 * 1024 * 1024 ? '此文件超过当前 256 MiB 下载上限。' : '选择“下载并转写”会在保存后启动本地处理；“仅下载”不会启动转写。';
    this.button('cancel-transfer').hidden = !active || !transfer.canCancel;
    this.button('refresh-device').disabled = !state.canDownload || state.busy;
    this.button('download-transcribe').textContent = active && ['paused', 'cancelled', 'error'].includes(state.transfer.phase) && state.transfer.received > 0 ? '继续下载并转写' : '下载并转写';
  }
  async showRecording(recordingId: string, scope: 'personal' | 'account') {
    if (!this.discard()) { this.notice('录音已保存。完成当前编辑后，可在账号录音列表中查看。'); return; }
    this.trash = false; this.listFilter = 'all'; this.sourceFilter = 'all'; this.field('source').value = 'all'; this.field('list-filter').value = 'all'; this.field('list-search').value = ''; this.button('trash').textContent = '回收站'; this.clearSelected();
    await this.open(); await this.refreshContext(); await this.select({ ...await this.client.request<RecordingRow>(`recordings/${recordingId}`, undefined, 'GET', scope), scope });
  }
  async reuseDeviceRecording(deviceId: string, sessionId: number, options: DownloadOptions, bytes?: number) {
    await this.refreshContext();
    let cursor = 0;
    do {
      const result = await this.client.request<{ items: RecordingRow[]; nextCursor: number | null }>(`recordings?limit=100&cursor=${cursor}`, undefined, 'GET', 'account');
      const row = result.items.find(row => row.recording.state === 'stored' && row.recording.source.kind === 'ble' && row.recording.source.deviceId === deviceId && row.recording.source.sessionId === sessionId && (bytes === undefined || row.recording.assets.find(asset => asset.role === 'original')?.bytes === bytes));
      if (row) {
        if (options.transcribe) await this.client.request(`recordings/${row.recording.id}/jobs`, { language: options.language }, 'POST', 'account');
        await this.showRecording(row.recording.id, 'account'); return true;
      }
      if (result.nextCursor === null || result.nextCursor === undefined) break; cursor = result.nextCursor;
    } while (true);
    return false;
  }
  private status(row: RecordingRow) { return row.recording.state === 'deleted' ? '回收站' : row.recording.state === 'needs_recovery' ? '需要恢复音频' : row.recording.state === 'unsupported' ? '音频暂不支持' : row.job ? (row.job.state === 'running' ? stageNames[row.job.stage!] : stateNames[row.job.state]) : '已保存 · 尚未转写'; }
  private async select(row: ScopedRecordingRow) {
    const changed = row.scope !== this.selected?.scope || row.recording.id !== this.selected?.recording.id; this.client.scope = row.scope; this.selectedDevice = undefined; this.view('device-detail').hidden = true; this.view('rename-form').hidden = true; this.selected = row;
    if (changed) { this.generation++; this.page = undefined; this.forwarder.select(); this.version = ''; this.view('paragraphs').replaceChildren(); this.cursor = 0; this.query = ''; this.speaker = ''; this.mode = 'all'; this.field('search').value = ''; this.field('mode').value = 'all'; this.playEnd = null; this.audio().pause(); this.audio().src = this.client.url(`recordings/${row.recording.id}/audio`); }
    this.view('empty').hidden = true; this.view('detail').hidden = false; this.renderHeader();
    if (row.revision && row.recording.state !== 'deleted') await this.loadTranscript(); else this.view('reader').hidden = true;
    await this.refresh();
  }
  private renderHeader() {
    const row = this.selected!; this.view('title').textContent = recordingTitle(row.recording);
    this.view('title').title = row.recording.title;
    this.view('meta').textContent = `${row.recording.durationMs ? clock(row.recording.durationMs) + ' · ' : ''}${row.recording.source.kind === 'ble' ? '设备下载' : '本机导入'} · ${new Date(row.recording.createdAtMs).toLocaleString('zh-CN')}`;
    this.view('storage').textContent = row.storagePath || this.context?.environment.storageRoot || '本机录音目录'; this.view('storage').title = this.view('storage').textContent || '';
    this.view('status').textContent = this.status(row); this.view('status').dataset.state = row.job?.state || row.recording.state;
    const progress = row.runtime?.progress, job = row.job; this.view('job').dataset.state = job?.state || row.recording.state;
    this.view('job').textContent = job?.state === 'running' ? `${stageNames[job.stage!]}${progress ? ` · 已完成 ${progress.completedUnits}${progress.totalUnits === null ? '' : ' / ' + progress.totalUnits} ${progress.unit === 'chunks' ? '个音频块' : '步'}` : ' · 处理中'}${row.runtime?.resumed ? ' · 从已完成阶段恢复' : ''}` : job?.error?.message || (job?.state === 'succeeded' ? '转写已完成。全文与 Markdown、TXT 文件已保存在录音目录中。' : job?.state === 'queued' ? '已按你的选择排队。本机服务运行时，关闭页面后仍会继续处理。' : job?.state === 'paused' ? '等待对应 PLAUD 账号恢复登录后继续处理。' : row.recording.state === 'stored' ? '音频已保存。点击“开始转写”后才会启动本地处理。' : '原件已保存，尚未恢复为可播放音频。');
    const active = !!job && ['queued', 'running'].includes(job.state), deleted = row.recording.state === 'deleted';
    this.button('cancel').hidden = !active; this.button('retry').hidden = deleted || job?.state === 'succeeded'; this.button('retry').disabled = active || row.recording.state !== 'stored'; this.button('retry').textContent = job ? '重试 / 继续处理' : '开始转写';
    this.button('export-current').hidden = deleted || !row.revision; this.button('export-current').disabled = !this.page || this.page.transcript.recordingId !== row.recording.id;
    this.button('delete').hidden = deleted; this.button('restore').hidden = !deleted; this.button('original').hidden = deleted; this.button('audio').hidden = deleted || row.recording.state !== 'stored'; this.button('rename').hidden = deleted;
    this.root.querySelector<HTMLElement>('.library-player')!.hidden = deleted || row.recording.state !== 'stored'; this.view('reader').hidden = !row.revision || deleted || this.page?.transcript.recordingId !== row.recording.id;
    if (!deleted && this.page?.transcript.recordingId === row.recording.id) this.forwarder.select({ recordingId: row.recording.id, revisionId: this.page.revision.revisionId, scope: row.scope });
    else if (deleted) this.forwarder.select();
    this.renderForward();
  }
  private renderForward() {
    const ready = !!this.selected?.revision && this.selected.recording.state !== 'deleted';
    const transfer = this.forwarder.transfer, error = this.forwarder.error, busy = this.forwarder.busy;
    this.button('chatgpt-send').hidden = !ready;
    this.button('chatgpt-send').disabled = busy || this.editing || this.saving || !this.page || this.page.transcript.recordingId !== this.selected?.recording.id || this.page.revision.revisionId !== (this.version || this.selected?.revision?.revisionId);
    this.button('chatgpt-send').textContent = busy ? '正在发送…' : transfer?.state === 'submitted' ? '已提交 · 打开 ChatGPT' : transfer?.state === 'user_action_required' ? '核对发送状态' : this.version ? '发送此历史版本' : '发送到 ChatGPT';
    this.button('chatgpt-send').title = this.editing || this.saving ? '请先保存或取消当前修改' : '将当前已保存版本的完整转写作为 Markdown 附件发送到已连接的 ChatGPT 页面';
    this.view('chatgpt').hidden = !ready || !(transfer || error);
    this.view('chatgpt-status').textContent = error || (transfer?.state === 'submitted' ? '已提交到 ChatGPT。回复请在对话中查看。' : transfer?.message || '正在准备完整稿件…');
    const needsAction = !!error || transfer?.state === 'user_action_required' || transfer?.state === 'failed';
    this.view('chatgpt').classList.toggle('needs-action', needsAction);
    this.button('chatgpt-open').hidden = !transfer?.conversationUrl;
    this.button('chatgpt-settings').hidden = !needsAction;
    this.button('chatgpt-export').hidden = !needsAction || transfer?.state === 'submitted';
  }
  private async loadTranscript(at?: number) {
    if (!this.selected || this.editing) return;
    const generation = this.generation, request = ++this.pageRequest, recordingId = this.selected.recording.id;
    const params = new URLSearchParams({ cursor: String(this.cursor), limit: '60', q: this.query, mode: this.mode }); if (this.version) params.set('revision', this.version); if (this.speaker) params.set('speaker', this.speaker); if (at !== undefined) params.set('at', String(Math.floor(at)));
    const data = await this.client.request<TranscriptPage>(`recordings/${recordingId}/transcript?${params}`);
    if (generation !== this.generation || request !== this.pageRequest || recordingId !== this.selected?.recording.id || this.editing) return;
    this.page = data; this.cursor = data.cursor; if (!this.version) this.selected.revision = data.revision; this.view('reader').hidden = false;
    const version = this.field<HTMLSelectElement>('version'); version.replaceChildren(new Option('最新稿件 · 可校对', ''));
    try {
      const history = await this.client.request<{ revisions: { revisionId: string; createdAtMs: number; current: boolean; machine: boolean }[] }>(`recordings/${recordingId}/revisions`);
      if (generation !== this.generation || request !== this.pageRequest) return;
      for (const item of history.revisions) if (!item.current) version.append(new Option(`${item.machine ? '原始机器稿' : '历史校对稿'} · ${new Date(item.createdAtMs).toLocaleString('zh-CN')} · ${item.revisionId.slice(-6)}`, item.revisionId));
    } catch { /* Current transcript remains available if history enumeration fails. */ }
    version.value = this.version;
    this.view('count').textContent = `显示 ${data.total} / ${data.totalSegments} 段 · 已核对 ${data.revision.reviewedIds.length} 段`;
    this.view('revision').textContent = `版本 ${data.transcript.revisionId.slice(-8)} · ${this.version ? '历史版本，只读' : '已保存到本机录音库'}`;
    this.view('page').textContent = `${Math.floor(this.cursor / 60) + 1} / ${Math.max(1, Math.ceil(data.total / 60))}`;
    this.button('prev').disabled = this.cursor === 0; this.button('next').disabled = data.nextCursor === null;
    this.renderSpeakers(); this.renderParagraphs(); this.button('export-current').disabled = false;
    this.forwarder.select({ recordingId, revisionId: data.revision.revisionId, scope: this.selected.scope }); this.renderForward();
  }
  private speakerName(id: string | null) { return this.page?.transcript.speakers.find(s => s.id === id)?.displayName || '讲话人待确认'; }
  private renderSpeakers() {
    const speakers = this.page!.transcript.speakers, filter = this.field<HTMLSelectElement>('speaker'); filter.replaceChildren(new Option('所有讲话人', ''));
    this.view('speakers').replaceChildren();
    for (const speaker of speakers) {
      filter.append(new Option(speaker.displayName + ' · ' + speaker.id, speaker.id));
      const row = el('div', 'library-speaker-row'), input = el('input'); input.value = speaker.displayName; input.maxLength = 100; input.setAttribute('aria-label', speaker.id + '的名称');
      const save = el('button', '', '保存名称'); save.onclick = () => { void this.save([{ kind: 'speaker_name', speakerId: speaker.id, displayName: input.value }]).catch(e => this.failure(e)); };
      save.disabled = input.disabled = !!this.version;
      const preview = el('button', '', '试听'); preview.onclick = () => { void this.previewSpeaker(speaker.id).catch(e => this.failure(e)); };
      row.append(input, el('small', '', speaker.id), preview, save); this.view('speakers').append(row);
    }
    filter.append(new Option('讲话人待确认', 'unknown')); filter.value = this.speaker;
  }
  private async previewSpeaker(speakerId: string) { const preview = await this.client.request<{ startMs: number; endMs: number }>(`recordings/${this.selected!.recording.id}/speakers/${encodeURIComponent(speakerId)}/preview`); this.play(preview.startMs, preview.endMs); }
  private play(start: number, end: number) { this.audio().currentTime = Math.max(0, start / 1000 - .15); this.playEnd = end / 1000 + .2; void this.audio().play().catch(() => this.notice('请点击播放器播放。')); }
  private renderParagraphs() {
    const data = this.page!; this.view('paragraphs').replaceChildren(); const reviewed = new Set(data.revision.reviewedIds);
    for (const segment of data.transcript.segments) {
      const row = el('article', 'library-paragraph'); row.dataset.id = segment.id;
      const short = Math.floor(segment.startMs / 1000) === Math.floor(segment.endMs / 1000), format = short ? precise : clock;
      const top = el('div', 'library-paragraph-top'), name = el('strong', '', this.speakerName(segment.speakerId)), time = el('button', 'library-time', format(segment.startMs) + ' – ' + format(segment.endMs)); time.title = precise(segment.startMs) + ' – ' + precise(segment.endMs); time.onclick = () => this.play(segment.startMs, segment.endMs);
      const edit = el('button', 'library-edit', '编辑'), label = el('label', 'library-review-check'), check = el('input'); check.type = 'checkbox'; check.checked = reviewed.has(segment.id); check.setAttribute('aria-label', '本段文字、时间和讲话人均已核对'); label.append(check, document.createTextNode('已核对'));
      edit.disabled = check.disabled = !!this.version;
      check.onchange = () => { check.disabled = true; void this.save([{ kind: 'segment_reviewed', segmentId: segment.id, reviewed: check.checked }]).catch(e => { check.checked = reviewed.has(segment.id); this.failure(e); }).finally(() => { check.disabled = false; }); };
      edit.onclick = () => this.editSegment(row, segment); top.append(name, time, edit, label);
      const flags = el('div', 'library-flags'); for (const flag of segment.flags) flags.append(el('span', '', flagNames[flag]));
      row.append(top, el('p', 'library-text', segment.text.trim()), flags); this.view('paragraphs').append(row);
    }
    if (!data.transcript.segments.length) this.view('paragraphs').append(el('p', 'library-empty-results', '没有符合条件的段落。'));
  }
  private editSegment(row: HTMLElement, segment: TranscriptSegment) {
    if (this.editing) { this.notice('请先保存或取消正在编辑的段落。'); return; } this.editing = true; this.renderForward();
    const form = el('div', 'library-editor'), text = el('textarea'); text.value = segment.text; text.maxLength = 10000; text.setAttribute('aria-label', '本段转写文字');
    const speaker = el('select'); speaker.append(new Option('讲话人待确认', 'unknown')); for (const s of this.page!.transcript.speakers) speaker.append(new Option(s.displayName, s.id)); speaker.value = segment.speakerId || 'unknown'; speaker.setAttribute('aria-label', '本段讲话人');
    const start = el('input'), end = el('input'); start.value = precise(segment.startMs); end.value = precise(segment.endMs); start.setAttribute('aria-label', '本段开始时间'); end.setAttribute('aria-label', '本段结束时间');
    const controls = el('div', 'library-editor-controls');
    for (const [caption, field] of [['讲话人', speaker], ['开始时间', start], ['结束时间', end]] as const) { const label = el('label', '', caption); label.append(field); controls.append(label); }
    const save = el('button', 'library-primary', '保存本段'), cancel = el('button', '', '取消编辑'), message = el('p', 'library-editor-message');
    cancel.onclick = () => { this.editing = false; form.remove(); this.renderForward(); };
    save.onclick = () => {
      const first = parseTime(start.value), last = parseTime(end.value);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first >= last || first < 0 || last > this.page!.transcript.durationMs) { message.textContent = '请填写有效的起止时间，格式为 时:分:秒.毫秒。'; return; }
      const changes: TranscriptRevision['changes'] = [];
      if (text.value !== segment.text) changes.push({ kind: 'segment_text', segmentId: segment.id, text: text.value });
      const speakerId = speaker.value === 'unknown' ? null : speaker.value; if (speakerId !== segment.speakerId) changes.push({ kind: 'segment_speaker', segmentId: segment.id, speakerId });
      if (first !== segment.startMs || last !== segment.endMs) changes.push({ kind: 'segment_time', segmentId: segment.id, startMs: first, endMs: last });
      if (!changes.length) { this.editing = false; form.remove(); this.renderForward(); return; }
      save.disabled = true;
      void this.save(changes, true).catch(e => { message.textContent = e instanceof Error ? e.message : '保存失败，请重试。'; }).finally(() => { save.disabled = false; });
    };
    controls.append(save, cancel); form.append(text, controls, el('p', '', '修改后点击保存；原始机器稿会保留。时间为段落范围，字词时间不会沿用到修改后的文字。'), message); row.append(form); text.focus();
  }
  private async save(changes: TranscriptRevision['changes'], fromEditor = false) {
    if (this.version) throw new Error('历史稿件为只读，请切回最新稿件后校对。');
    if (this.saving || this.editing && !fromEditor) throw new Error('请先保存或取消当前段落的修改。');
    if (!this.page || !this.selected) return; this.saving = true; this.renderForward();
    try { const result = await this.client.save(this.selected.recording.id, this.page.revision.revisionId, changes); this.selected.revision = result.revision; this.editing = false; await this.loadTranscript(); this.notice('修改已保存到本机录音库。'); }
    finally { this.saving = false; this.renderForward(); }
  }
  private bind() {
    this.button('workspace-settings').onclick = () => { this.closeMenus(); this.options.onOpenSettings?.(); };
    this.button('device-settings').onclick = () => { if (this.deviceState?.connected) this.toggleMenu('device-menu', 'device-settings'); else this.openDevice(); };
    for (const action of ['empty-device', 'device-details', 'account-login']) this.button(action).onclick = () => this.openDevice();
    this.button('account-menu').onclick = () => this.toggleMenu('account-menu', 'account-menu');
    this.button('account-logout').onclick = () => { this.closeMenus(); this.options.onLogout?.(); };
    this.button('menu-refresh').onclick = () => { this.closeMenus(); this.options.onRefreshDevice?.(); };
    this.button('switch-device').onclick = () => { this.closeMenus(); this.options.onSwitchDevice?.(); };
    this.button('disconnect-device').onclick = () => { this.closeMenus(); this.options.onDisconnectDevice?.(); };
    document.addEventListener('click', event => { if (!(event.target instanceof window.Element) || !event.target.closest('[data-menu-anchor]')) this.closeMenus(); });
    document.addEventListener('keydown', event => { if (this.visible && event.key === 'Escape') { const active = menus.find(([view]) => !this.view(view).hidden); if (active) { event.preventDefault(); this.closeMenus(); this.button(active[1]).focus(); } } });
    for (const action of ['import-menu', 'filter-menu']) this.button(action).onclick = () => this.toggleMenu(action, action);
    for (const action of ['import', 'import-only']) this.button(action).onclick = () => { if (!this.importing) { this.closeMenus(); this.importingWithTranscription = action === 'import'; this.field('files').click(); } };
    this.button('reset-filters').onclick = () => { this.sourceFilter = this.listFilter = 'all'; this.field('source').value = this.field('list-filter').value = 'all'; try { window.localStorage.setItem('recdock.librarySource', 'all'); } catch { /* Preference is optional. */ } this.listSignature = ''; this.renderList(); };
    this.field('list-filter').onchange = () => { this.listFilter = this.field('list-filter').value; this.listSignature = ''; this.renderList(); };
    this.field('list-search').oninput = () => { this.listSignature = ''; this.renderList(); };
    for (const action of ['download-transcribe', 'download-only']) this.button(action).onclick = () => {
      if (this.selectedDevice !== undefined && this.deviceState?.canDownload && !this.deviceState.busy) void this.options.onDownload?.(this.selectedDevice, { transcribe: action === 'download-transcribe', language: this.language }).catch(e => this.failure(e));
    };
    this.button('cancel-transfer').onclick = () => this.options.onCancelDownload?.();
    this.button('refresh-device').onclick = () => this.options.onRefreshDevice?.();
    this.button('export-current').onclick = () => this.button('export').click();
    this.button('chatgpt-send').onclick = () => { if (this.editing || this.saving || !this.page) return; if (this.forwarder.transfer?.state === 'submitted') void this.forwarder.open(); else void this.forwarder.send(); };
    this.button('chatgpt-open').onclick = () => { void this.forwarder.open(); };
    this.button('chatgpt-settings').onclick = () => this.options.onOpenSettings?.('chatgpt');
    this.button('chatgpt-export').onclick = () => { this.field('format').value = 'md'; this.button('export').click(); };
    this.button('audio').onclick = () => { if (this.selected) this.download(this.client.url(`recordings/${this.selected.recording.id}/audio?download=1`)); };
    this.button('copy-path').onclick = () => { const path = this.selected?.storagePath; if (path) void navigator.clipboard.writeText(path).then(() => this.notice('目录路径已复制。')).catch(() => this.notice('请选中保存位置并复制目录路径。')); };
    this.button('rename').onclick = () => { if (this.selected) { this.field('title').value = recordingTitle(this.selected.recording); this.view('rename-form').hidden = false; this.field('title').focus(); } };
    this.button('cancel-rename').onclick = () => { this.view('rename-form').hidden = true; };
    this.view('rename-form').onsubmit = event => { event.preventDefault(); if (this.selected) { const selected = this.selected; void this.client.request<RecordingRow>(`recordings/${selected.recording.id}`, { title: this.field('title').value }, 'PATCH', selected.scope).then(row => { if (this.selected?.scope === selected.scope && this.selected.recording.id === selected.recording.id) this.selected = { ...row, scope: selected.scope }; this.view('rename-form').hidden = true; return this.refresh(); }).catch(e => this.failure(e)); } };
    this.field('files').onchange = () => { if (!this.discard()) { this.field('files').value = ''; return; } const files = Array.from(this.field('files').files || []); void this.importFiles(files); };
    this.field('source').onchange = () => { this.sourceFilter = this.field('source').value; try { window.localStorage.setItem('recdock.librarySource', this.sourceFilter); } catch { /* Preference is optional. */ } this.listSignature = ''; this.renderList(); };
    this.button('trash').onclick = () => { if (!this.discard()) return; this.closeMenus(); this.trash = !this.trash; this.button('trash').textContent = this.trash ? '返回录音列表' : '回收站'; this.clearSelected(); void this.refresh().catch(e => this.failure(e)); };
    this.button('retry').onclick = () => { if (!this.selected) return; void this.client.request(`recordings/${this.selected.recording.id}/jobs`, { language: this.language }).then(() => this.refresh()).catch(e => this.failure(e)); };
    this.button('cancel').onclick = () => { if (this.selected?.job) void this.client.request(`jobs/${this.selected.job.id}/cancel`, {}).then(() => this.refresh()).catch(e => this.failure(e)); };
    this.button('original').onclick = () => { if (this.selected) this.download(this.client.url(`recordings/${this.selected.recording.id}/original`)); };
    this.button('delete').onclick = () => { if (!this.selected || !this.discard() || !confirm('将这条录音移入本机回收站？正在运行的任务会取消，原音频与全文可从回收站恢复。')) return; void this.client.request(`recordings/${this.selected.recording.id}`, undefined, 'DELETE').then(() => { this.clearSelected(); return this.refresh(); }).catch(e => this.failure(e)); };
    this.button('restore').onclick = () => { if (this.selected) void this.client.request(`recordings/${this.selected.recording.id}/restore`, {}).then(() => { this.clearSelected(); return this.refresh(); }).catch(e => this.failure(e)); };
    this.button('export').onclick = () => { if (!this.page || !this.selected) return; void this.client.request<{ url: string; filename: string }>(`recordings/${this.selected.recording.id}/exports`, { revisionId: this.page.revision.revisionId, format: this.field('format').value }).then(result => { this.download(result.url, result.filename); this.notice(`已导出完整版本：${result.filename}。`); }).catch(e => this.failure(e)); };
    this.field('version').onchange = () => { if (!this.discard()) { this.field('version').value = this.version; return; } this.version = this.field('version').value; this.cursor = 0; void this.loadTranscript().catch(e => this.failure(e)); };
    const filter = () => { if (!this.discard()) return; this.cursor = 0; this.query = this.field('search').value; this.speaker = this.field('speaker').value; this.mode = this.field('mode').value; void this.loadTranscript().catch(e => this.failure(e)); };
    let searchTimer: ReturnType<typeof setTimeout>; this.field('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(filter, 200); }; this.field('speaker').onchange = filter; this.field('mode').onchange = filter;
    this.button('prev').onclick = () => { if (this.discard()) { this.cursor = Math.max(0, this.cursor - 60); void this.loadTranscript().catch(e => this.failure(e)); } }; this.button('next').onclick = () => { if (this.page?.nextCursor !== null && this.discard()) { this.cursor = this.page!.nextCursor!; void this.loadTranscript().catch(e => this.failure(e)); } };
    this.audio().ontimeupdate = () => {
      const ms = this.audio().currentTime * 1000; this.view('playtime').textContent = clock(ms) + ' / ' + clock(this.selected?.recording.durationMs || 0);
      if (this.playEnd !== null && this.audio().currentTime >= this.playEnd) { this.audio().pause(); this.playEnd = null; }
      const active = this.page?.transcript.segments.find(s => s.startMs <= ms && ms < s.endMs);
      if (active?.id !== this.playingId) { this.playingId = active?.id || null; this.root.querySelectorAll('.library-paragraph.active').forEach(p => p.classList.remove('active')); const row = [...this.view('paragraphs').children].find(p => (p as HTMLElement).dataset.id === active?.id); row?.classList.add('active'); if (row && this.field('follow').checked && !this.editing && !this.audio().paused) row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      if (!active && !this.audio().paused && !this.editing && this.field('follow').checked && !this.query && !this.speaker && this.mode === 'all' && Date.now() - this.lastFollow > 3000) { this.lastFollow = Date.now(); void this.loadTranscript(ms).catch(() => {}); }
    };
    this.audio().onerror = () => { if (this.audio().getAttribute('src')) this.notice('原音频暂时无法播放，请确认本机服务仍在运行；也可下载原件核对。', true); };
    this.field('speed').onchange = () => { this.audio().playbackRate = Number(this.field('speed').value); };
    this.button('back').onclick = () => { this.playEnd = null; this.audio().currentTime = Math.max(0, this.audio().currentTime - 5); }; this.button('forward').onclick = () => { this.playEnd = null; this.audio().currentTime = Math.min(this.audio().duration || 0, this.audio().currentTime + 5); };
  }
  private download(url: string, filename?: string) { const anchor = el('a'); anchor.href = url; if (filename) anchor.download = filename; anchor.click(); }
  private async importFiles(files: File[]) {
    if (!files.length || this.importing) return; this.importing = true; const transcribe = this.importingWithTranscription, language = this.language; this.button('import-menu').disabled = true; this.button('import').disabled = true; this.button('import-only').disabled = true;
    try {
      for (const file of files) {
        if (!file.size || file.size > 1024 ** 3) throw new Error('请选择非空且不超过 1 GiB 的文件。');
        const result = await this.client.importFile({ filename: file.name, original: file, language, transcribe, source: { kind: 'import', deviceId: null, sessionId: null } }, message => this.notice(message), 'personal');
        this.trash = false; this.sourceFilter = 'all'; this.listFilter = 'all'; this.field('source').value = 'all'; this.field('list-filter').value = 'all'; this.field('list-search').value = ''; this.button('trash').textContent = '回收站'; await this.select({ ...await this.client.request<RecordingRow>(`recordings/${result.recording.id}`, undefined, 'GET', 'personal'), scope: 'personal' });
        this.notice(result.processingError?.message || (result.duplicate ? '已找到相同原文件，复用已有录音与处理结果。' : result.recording.state === 'stored' ? (result.job ? '录音已保存，已按你的选择排队转写。本机服务运行时可关闭页面。' : '录音已保存，尚未转写。可随时点击“开始转写”。') : '原文件已保存；此文件暂时无法完整解码，尚未转写。'));
      }
    } catch (e) { this.failure(e); } finally { this.importing = false; this.button('import-menu').disabled = false; this.button('import').disabled = false; this.button('import-only').disabled = false; this.field('files').value = ''; }
  }
  async acceptDeviceDownload(recording: PlayableRecording & { originalData: Uint8Array }, deviceId: string, sessionId: number, options: DownloadOptions) {
    await this.refreshContext();
    const result = await this.client.importFile({ filename: `plaud-${sessionId}.bin`, original: new Blob([Uint8Array.from(recording.originalData).buffer]), language: options.language, transcribe: options.transcribe, source: { kind: 'ble', deviceId, sessionId }, ...(recording.format !== 'raw' ? { playable: { filename: recording.filename, file: new Blob([Uint8Array.from(recording.data).buffer], { type: recording.mimeType }) } } : {}) }, message => this.notice(message), 'account');
    return result;
  }
}
