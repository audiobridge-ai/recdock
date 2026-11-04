import type { LibraryClient } from '../library/client.ts';
import { ChatGPTBridge, chatgptPrompt } from './bridge.ts';
import type { BridgeTask, ForwardPacket, ForwardTransfer } from './types.ts';

export type ForwardBridge = Pick<ChatGPTBridge, 'info' | 'bind' | 'start' | 'status' | 'open'>;
export interface ForwardSelection { recordingId: string; revisionId: string; scope: 'personal' | 'account' }
/** Selection changes stop local polling, never repeat or cancel a remote submission. */
export class ChatGPTForwarder {
  transfer?: ForwardTransfer;
  busy = false;
  error = '';
  private selection?: ForwardSelection;
  private generation = 0;
  private operation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private client: LibraryClient;
  readonly bridge: ForwardBridge;
  private changed: () => void;
  constructor(client: LibraryClient, changed: () => void, bridge: ForwardBridge = new ChatGPTBridge()) { this.client = client; this.changed = changed; this.bridge = bridge; }
  stop() { this.generation++; this.operation++; clearTimeout(this.timer); this.busy = false; }
  select(selection?: ForwardSelection) {
    if (JSON.stringify(selection) === JSON.stringify(this.selection)) return;
    this.stop(); this.selection = selection; this.transfer = undefined; this.error = ''; this.changed();
    if (selection) void this.restore(this.generation, this.operation, selection);
  }
  private current(generation: number, operation: number) { return generation === this.generation && operation === this.operation; }
  private async restore(generation: number, operation: number, selection: ForwardSelection) {
    try {
      const info = await this.bridge.info(); if (!this.current(generation, operation)) return;
      const result = await this.client.request<{ transfers: ForwardTransfer[] }>(`recordings/${selection.recordingId}/chatgpt?targetId=${info.targetId}`, undefined, 'GET', selection.scope);
      if (!this.current(generation, operation)) return;
      this.transfer = result.transfers.find(t => t.revisionId === selection.revisionId); this.changed();
      if (this.transfer && this.transfer.state !== 'submitted') await this.poll(generation, operation, selection, this.transfer);
    } catch { /* An optional bridge must not prevent local reading or editing. */ }
  }
  private async update(selection: ForwardSelection, transfer: ForwardTransfer, task: BridgeTask) {
    if (task.id !== transfer.id) throw Error('扩展回执与当前发送任务不一致，请检查连接。');
    const result = await this.client.request<{ transfer: ForwardTransfer }>(`recordings/${selection.recordingId}/chatgpt/${transfer.id}`, { targetId: transfer.targetId, state: task.state, message: task.message || '', ...(task.conversationUrl ? { conversationUrl: task.conversationUrl } : {}) }, 'PATCH', selection.scope);
    return result.transfer;
  }
  private async poll(generation: number, operation: number, selection: ForwardSelection, transfer: ForwardTransfer) {
    if (!this.current(generation, operation)) return;
    try {
      const task = await this.bridge.status(transfer.id); if (!this.current(generation, operation)) return;
      if (!task) { this.busy = false; this.error = '扩展中没有此任务。点击发送可重新准备；已有提交不会重复发送。'; this.changed(); return; }
      const updated = await this.update(selection, transfer, task); if (!this.current(generation, operation)) return; this.transfer = updated;
      this.busy = ['prepared', 'attaching', 'attached', 'submitting'].includes(task.state); this.changed();
      if (this.busy) this.timer = setTimeout(() => { void this.poll(generation, operation, selection, this.transfer!); }, 1500);
    } catch (error) { if (this.current(generation, operation)) { this.busy = false; this.error = error instanceof Error ? error.message : '请核对 ChatGPT 页面。'; this.changed(); } }
  }
  async send() {
    if (!this.selection || this.busy) return;
    const selection = { ...this.selection }, generation = this.generation, operation = ++this.operation; clearTimeout(this.timer);
    this.busy = true; this.error = ''; this.changed();
    try {
      const info = await this.bridge.info(); if (!this.current(generation, operation)) return;
      if (!info.bound) throw Error('请在设置中连接已登录的 ChatGPT 页面。');
      const packet = await this.client.request<ForwardPacket>(`recordings/${selection.recordingId}/chatgpt`, { targetId: info.targetId, revisionId: selection.revisionId, prompt: chatgptPrompt(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, 'POST', selection.scope);
      if (!this.current(generation, operation)) return;
      this.transfer = packet.transfer;
      if (packet.transfer.state === 'submitted' && packet.transfer.conversationUrl) { this.busy = false; await this.bridge.open(packet.transfer.conversationUrl); this.changed(); return; }
      const task = await this.bridge.start(packet); if (!this.current(generation, operation)) return;
      const updated = await this.update(selection, packet.transfer, task); if (!this.current(generation, operation)) return; this.transfer = updated;
      await this.poll(generation, operation, selection, this.transfer);
    } catch (error) { if (this.current(generation, operation)) { this.busy = false; this.error = error instanceof Error ? error.message : '发送未完成。'; this.changed(); } }
  }
  async open() {
    if (!this.transfer?.conversationUrl) return;
    const generation = this.generation, operation = this.operation;
    try { await this.bridge.open(this.transfer.conversationUrl); if (this.current(generation, operation)) { this.error = ''; this.changed(); } }
    catch (error) { if (this.current(generation, operation)) { this.error = '已提交到 ChatGPT。打开对话失败：' + (error instanceof Error ? error.message : '请检查已连接的页面。'); this.changed(); } }
  }
}
