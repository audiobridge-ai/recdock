import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicJson, id, isMissing, jsonFile, LibraryError, validId } from './common.ts';
import type { LibraryStore } from './store.ts';
import { exportTranscript } from './transcript-export.ts';
import { recordingTitle } from '../../src/library/recording-title.ts';
import { DEFAULT_CHATGPT_PROMPT } from '../../src/chatgpt/types.ts';
import type { ForwardPacket, ForwardState } from '../../src/chatgpt/types.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const states: ForwardState[] = ['prepared', 'attaching', 'attached', 'submitting', 'submitted', 'user_action_required', 'failed'];
export function chatgptConversationUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try { const url = new URL(value); if (url.origin === 'https://chatgpt.com' && /^\/c\/[A-Za-z0-9-]{1,160}$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash) return url.href; } catch { /* Not a conversation URL. */ }
}
function target(value: unknown) { if (typeof value !== 'string' || !/^[a-f0-9-]{16,100}$/.test(value)) throw new LibraryError('CHATGPT_TARGET_REQUIRED', '请先连接 ChatGPT 浏览器扩展。'); return value; }

/** Scoped, immutable send packets; never exposes arbitrary paths or audio assets. */
export class ChatGPTTransfers {
  private queue: Promise<unknown> = Promise.resolve();
  private store: LibraryStore;
  constructor(store: LibraryStore) { this.store = store; }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation, operation); this.queue = next.catch(() => {}); return next; }
  private path(scope: string, recordingId: string) { return join(this.store.recordingDir(scope, recordingId), 'chatgpt', 'transfers.json'); }
  private async records(scope: string, recordingId: string): Promise<ForwardPacket[]> { try { return await jsonFile(this.path(scope, recordingId)); } catch (error) { if (isMissing(error)) return []; throw error; } }
  async list(scope: string, recordingId: string, targetId: unknown) { const value = target(targetId); return (await this.records(scope, recordingId)).filter(p => p.transfer.targetId === value).map(p => p.transfer).slice(-30).reverse(); }
  async prepare(scope: string, recordingId: string, data: Record<string, unknown>): Promise<ForwardPacket> {
    return this.serial(async () => {
      const targetId = target(data.targetId), revisionId = validId(String(data.revisionId || ''));
      if (data.prompt !== undefined && typeof data.prompt !== 'string') throw new LibraryError('CHATGPT_PROMPT_INVALID', '发送提示词格式不正确。');
      const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : DEFAULT_CHATGPT_PROMPT;
      if (!prompt || prompt.length > 6000) throw new LibraryError('CHATGPT_PROMPT_INVALID', '发送提示词需要 1–6000 个字符。');
      if (data.timeZone !== undefined && (typeof data.timeZone !== 'string' || data.timeZone.length > 100)) throw new LibraryError('TIMEZONE_INVALID', '当前时区不正确。');
      const recording = await this.store.get(scope, recordingId);
      if (recording.state === 'deleted') throw new LibraryError('RECORDING_DELETED', '请先恢复此录音。', 404);
      const { transcript, state } = await this.store.transcript(scope, recordingId, revisionId);
      if (transcript.sourceSha256 !== recording.sourceSha256) throw new LibraryError('SOURCE_MISMATCH', '稿件来源不一致，请重新读取录音。', 409);
      let title: string;
      try { title = recordingTitle(recording, data.timeZone as string | undefined); } catch { throw new LibraryError('TIMEZONE_INVALID', '当前时区不正确。'); }
      const content = exportTranscript(title, transcript, state.reviewedIds, 'md').content;
      if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024) throw new LibraryError('CHATGPT_FILE_TOO_LARGE', '全文超过当前自动转发上限，请导出后手动上传。', 413);
      const sha256 = sha(content), promptHash = sha(prompt), previous = await this.records(scope, recordingId);
      const existing = previous.find(p => p.transfer.targetId === targetId && p.transfer.revisionId === revisionId && p.transfer.sha256 === sha256 && p.transfer.promptHash === promptHash);
      if (existing) return existing;
      const filename = `${title.slice(0, 60).replace(/[\\/\u0000-\u001f]/g, '_')}-${recordingId.slice(-6)}-${revisionId.slice(-6)}-${sha256.slice(0, 8)}.md`;
      const now = Date.now();
      const packet: ForwardPacket = { transfer: { id: id('fwd'), recordingId, revisionId, targetId, sha256, promptHash, filename, state: 'prepared', createdAtMs: now, updatedAtMs: now }, content, prompt };
      previous.push(packet); await atomicJson(this.path(scope, recordingId), previous); return packet;
    });
  }
  async update(scope: string, recordingId: string, transferId: string, data: Record<string, unknown>) {
    return this.serial(async () => {
      const packets = await this.records(scope, recordingId), packet = packets.find(p => p.transfer.id === validId(transferId) && p.transfer.targetId === target(data.targetId));
      if (!packet) throw new LibraryError('CHATGPT_TRANSFER_NOT_FOUND', '未找到此发送任务。', 404);
      const state = data.state as ForwardState;
      if (!states.includes(state)) throw new LibraryError('CHATGPT_STATE_INVALID', '发送状态不正确。');
      const url = chatgptConversationUrl(data.conversationUrl);
      if (data.conversationUrl !== undefined && !url || state === 'submitted' && !url) throw new LibraryError('CHATGPT_URL_INVALID', '尚未确认 ChatGPT 对话链接。');
      const current = packet.transfer;
      if (current.state === 'submitted') return current;
      const rank = ['prepared', 'attaching', 'attached', 'submitting'];
      if (rank.includes(current.state) && rank.includes(state) && rank.indexOf(state) < rank.indexOf(current.state)) return current;
      // A possibly submitted task must be inspected, never reset into an automatic retry.
      if ((current.state === 'submitting' || current.submissionAttempted) && ['prepared', 'attaching', 'attached'].includes(state)) return current;
      packet.transfer = { ...current, state, ...(state === 'submitting' ? { submissionAttempted: true } : {}), updatedAtMs: Date.now(), ...(url ? { conversationUrl: url } : {}), ...(typeof data.message === 'string' ? { message: data.message.slice(0, 600) } : {}) };
      await atomicJson(this.path(scope, recordingId), packets); return packet.transfer;
    });
  }
}
