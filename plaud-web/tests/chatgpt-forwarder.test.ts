import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore DOM preferences only.
import { JSDOM } from 'jsdom';
import { ChatGPTForwarder } from '../src/chatgpt/forwarder.ts';
import { ChatGPTBridgeTimeout } from '../src/chatgpt/bridge.ts';
import type { LibraryClient } from '../src/library/client.ts';
import type { ForwardPacket, ForwardTransfer } from '../src/chatgpt/types.ts';

const targetId = 'a'.repeat(32), selection = { recordingId: 'rec_one', revisionId: 'rev_one', scope: 'personal' as const };
const transfer: ForwardTransfer = { id: 'fwd_one', ...selection, targetId, filename: 'synthetic.md', sha256: 'b'.repeat(64), promptHash: 'c'.repeat(64), state: 'prepared', createdAtMs: 1, updatedAtMs: 1 };
const packet: ForwardPacket = { transfer, content: '# 合成稿', prompt: '总结' };
const submitted = { id: transfer.id, state: 'submitted' as const, conversationUrl: 'https://chatgpt.com/c/one' };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) throw Error('forwarder condition timed out'); await new Promise(r => setTimeout(r, 5)); } }
function environment() { const previous = Reflect.get(globalThis, 'window'), dom = new JSDOM('', { url: 'http://localhost:5173/' }); Reflect.set(globalThis, 'window', dom.window); return () => { Reflect.set(globalThis, 'window', previous); dom.window.close(); }; }
const bridge = { info: async () => ({ version: 1, targetId, bound: true, targetLabel: 'ChatGPT' }), bind: async () => { throw Error('unused'); }, start: async () => submitted, status: async () => submitted, open: async () => {} };

test('较慢的历史状态恢复不能覆盖用户刚完成的发送结果', async () => {
  const close = environment(), restored = deferred<{ transfers: ForwardTransfer[] }>(); let reading = false;
  const client = { request: async (_path: string, data: any, method = 'POST') => { if (method === 'GET') { reading = true; return restored.promise; } if (method === 'PATCH') return { transfer: { ...transfer, ...data } }; return packet; } } as unknown as LibraryClient;
  const forwarder = new ChatGPTForwarder(client, () => {}, bridge);
  try { forwarder.select(selection); await until(() => reading); await forwarder.send(); assert.equal(forwarder.transfer?.state, 'submitted'); restored.resolve({ transfers: [] }); await new Promise(r => setTimeout(r, 10)); assert.equal(forwarder.transfer?.state, 'submitted'); assert.equal(forwarder.busy, false); }
  finally { forwarder.select(); close(); }
});

test('准备文件期间切换录音或账号资料，不会将旧稿交给扩展', async () => {
  const close = environment(), prepared = deferred<ForwardPacket>(); let preparing = false, starts = 0;
  const client = { request: async (_path: string, _data: unknown, method = 'POST') => { if (method === 'GET') return { transfers: [] }; preparing = true; return prepared.promise; } } as unknown as LibraryClient;
  const forwarder = new ChatGPTForwarder(client, () => {}, { ...bridge, start: async () => { starts++; return submitted; } });
  try {
    forwarder.select(selection); const sending = forwarder.send(); await until(() => preparing);
    forwarder.select({ recordingId: 'rec_two', revisionId: 'rev_two', scope: 'account' }); prepared.resolve(packet); await sending;
    assert.equal(starts, 0); assert.equal(forwarder.transfer, undefined); assert.equal(forwarder.busy, false);
  } finally { forwarder.select(); close(); }
});

test('已发出的旧任务回执保持明确资料范围，不能覆盖新录音的界面状态', async () => {
  const close = environment(), updated = deferred<{ transfer: ForwardTransfer }>(); let updating = false, updateScope = '';
  const client = { request: async (_path: string, _data: unknown, method = 'POST', scope: string) => { if (method === 'GET') return { transfers: [] }; if (method === 'PATCH') { updating = true; updateScope = scope; return updated.promise; } return packet; } } as unknown as LibraryClient;
  const forwarder = new ChatGPTForwarder(client, () => {}, bridge);
  try {
    forwarder.select(selection); const sending = forwarder.send(); await until(() => updating);
    forwarder.select({ recordingId: 'rec_two', revisionId: 'rev_two', scope: 'account' }); updated.resolve({ transfer: { ...transfer, ...submitted } }); await sending;
    assert.equal(updateScope, 'personal'); assert.equal(forwarder.transfer, undefined); assert.equal(forwarder.error, '');
  } finally { forwarder.select(); close(); }
});

test('状态回执暂时超时后继续只查询原任务，不误报未安装或重复发送', async () => {
  const close = environment(); let starts = 0, statuses = 0;
  const client = { request: async (_path: string, data: any, method = 'POST') => method === 'GET' ? { transfers: [] } : method === 'PATCH' ? { transfer: { ...transfer, ...data } } : packet } as unknown as LibraryClient;
  const forwarder = new ChatGPTForwarder(client, () => {}, { ...bridge, start: async () => { starts++; return { id: transfer.id, state: 'prepared' as const }; }, status: async () => { statuses++; if (statuses === 1) throw new ChatGPTBridgeTimeout('status'); return submitted; } });
  try {
    forwarder.select(selection); await forwarder.send(); assert.equal(forwarder.busy, true); assert.match(forwarder.error, /回执超时/); assert.doesNotMatch(forwarder.error, /未连接|未安装/);
    await until(() => forwarder.transfer?.state === 'submitted'); assert.equal(forwarder.error, ''); assert.equal(forwarder.busy, false); assert.equal(starts, 1); assert.equal(statuses, 2);
  } finally { forwarder.select(); close(); }
});
