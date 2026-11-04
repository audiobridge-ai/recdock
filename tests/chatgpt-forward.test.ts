import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGPTTransfers, chatgptConversationUrl } from '../server/library/chatgpt.ts';
import { LibraryService } from '../server/library/service.ts';
import { atomicJson, scopeFor } from '../server/library/common.ts';
import { saveRevision } from '../server/library/revisions.ts';
import { createLibraryHandler } from '../server/library/http.ts';
import { createCloudMiddleware } from '../server/http.ts';
import { middlewareRequest } from './helpers/middleware.ts';
import type { AudioTranscript, LibraryRecording } from '../src/library/types.ts';
// @ts-ignore Plain browser modules are also exercised by Node; no bundler dependency.
import { selectTarget, validatePacket, conversationUrl, workspaceSender } from '../extensions/chatgpt-bridge/shared.mjs';

const targetId = 'a8b44f96-3a4c-4b0a-a526-b0c8e3f92e91';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'recdock-chatgpt-')), service = new LibraryService({ root, workspace: process.cwd() }); await service.ready;
  const bases = JSON.parse(await readFile(new URL('../contracts/fixtures/contract-cases.json', import.meta.url), 'utf8')).bases;
  const transcript = structuredClone(bases.transcript.data) as AudioTranscript, scope = scopeFor();
  const recording = { ...bases.recording.data, id: transcript.recordingId, sourceSha256: transcript.sourceSha256, scopeId: scope, title: '合成转发测试', durationMs: transcript.durationMs, state: 'stored', source: { kind: 'import', deviceId: null, sessionId: null } } as LibraryRecording;
  await service.store.prepareScope(scope); await atomicJson(join(service.store.recordingDir(scope, recording.id), 'recording.json'), recording); await service.store.installTranscript(scope, recording.id, transcript);
  const transfers = new ChatGPTTransfers(service.store);
  return { service, transcript, recording, scope, transfers, prepare: () => transfers.prepare(scope, recording.id, { targetId, revisionId: transcript.revisionId, prompt: '请总结合成测试稿。' }), close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); } };
}

test('ChatGPT 转发始终导出指定完整版本，哈希校验、并发查重、人工修改与历史版本独立', async () => {
  const f = await fixture();
  try {
    const [one, two] = await Promise.all([f.prepare(), f.prepare()]); assert.equal(one.transfer.id, two.transfer.id);
    for (const segment of f.transcript.segments) assert.ok(one.content.includes(segment.text.trim()), 'full transcript includes every paragraph');
    assert.equal(one.transfer.sha256, sha(one.content)); assert.equal(one.transfer.promptHash, sha(one.prompt));
    assert.equal((await validatePacket(one)).transfer.id, one.transfer.id);
    await assert.rejects(() => validatePacket({ ...one, content: one.content + 'changed' }), /完整性/);
    const saved = await saveRevision(f.service.store, f.scope, f.recording.id, f.transcript.revisionId, [{ kind: 'segment_text', segmentId: f.transcript.segments[0].id, text: '已保存的人工作品。' }]);
    const newer = await f.transfers.prepare(f.scope, f.recording.id, { targetId, revisionId: saved.revisionId });
    assert.notEqual(newer.transfer.id, one.transfer.id); assert.match(newer.content, /已保存的人工作品/);
    assert.equal((await f.prepare()).content, one.content, 'historical version remains immutable');
    assert.equal((await f.transfers.list(f.scope, f.recording.id, targetId)).length, 2);
    assert.equal((await f.transfers.list(f.scope, f.recording.id, 'bbbbbbbbbbbbbbbb')).length, 0);
  } finally { await f.close(); }
});

test('未确认对话不标记成功，已提交不可降级，不接受外站链接或越界参数', async () => {
  const f = await fixture();
  try {
    const packet = await f.prepare(), update = (data: object) => f.transfers.update(f.scope, f.recording.id, packet.transfer.id, { targetId, ...data });
    await assert.rejects(() => update({ state: 'submitted' }), /尚未确认/);
    await assert.rejects(() => update({ state: 'submitted', conversationUrl: 'https://chatgpt.com.evil.test/c/a' }), /尚未确认/);
    await update({ state: 'user_action_required' }); assert.equal((await update({ state: 'attaching' })).state, 'attaching', 'a pre-submission task can be explicitly retried');
    await update({ state: 'submitting' }); assert.equal((await update({ state: 'attaching' })).state, 'submitting');
    await update({ state: 'user_action_required' }); assert.equal((await update({ state: 'prepared' })).state, 'user_action_required');
    const url = 'https://chatgpt.com/c/aabb-1234'; await update({ state: 'submitted', conversationUrl: url });
    assert.equal((await update({ state: 'failed' })).state, 'submitted');
    await assert.rejects(() => f.transfers.prepare(f.scope, f.recording.id, { targetId, revisionId: f.transcript.revisionId, prompt: 42 }), /提示词/);
    await assert.rejects(() => f.transfers.prepare(f.scope, f.recording.id, { targetId, revisionId: '../recording' }));
    assert.equal(chatgptConversationUrl(url), url);
    for (const u of ['http://chatgpt.com/c/a', 'https://chatgpt.com/c/a?token=x', 'https://chatgpt.com/c/a#x', 'https://user@chatgpt.com/c/a', 'javascript:alert(1)']) { assert.equal(chatgptConversationUrl(u), undefined); assert.equal(conversationUrl(u), null); }
  } finally { await f.close(); }
});

test('转发 HTTP 继承本地会话 CSRF 和账号隔离，不泄露稿件到其他资料范围', async () => {
  const f = await fixture();
  try {
    const library = createLibraryHandler(f.service), handler = createCloudMiddleware(undefined, Date.now, { library });
    const session = await middlewareRequest(handler, '/api/session', 'GET', undefined, {}), cookie = session.headers.get('set-cookie')!.split(';')[0], csrf = session.json.csrfToken;
    const path = `/api/library/recordings/${f.recording.id}/chatgpt`, input = Buffer.from(JSON.stringify({ targetId, revisionId: f.transcript.revisionId }));
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    assert.equal((await middlewareRequest(handler, path, 'POST', input, headers)).status, 403);
    assert.equal((await middlewareRequest(handler, path + '?scope=account', 'POST', input, { ...headers, 'X-CSRF-Token': csrf })).status, 401);
    const prepared = await middlewareRequest(handler, path, 'POST', input, { ...headers, 'X-CSRF-Token': csrf }); assert.equal(prepared.status, 200); assert.match(prepared.json.content, /合成转发测试/);
    const list = await middlewareRequest(handler, path + '?targetId=' + targetId, 'GET', undefined, headers); assert.equal(list.json.transfers.length, 1); assert.equal(list.json.transfers[0].content, undefined);
    await atomicJson(join(f.service.store.recordingDir(f.scope, f.recording.id), 'recording.json'), { ...f.recording, state: 'deleted' });
    assert.equal((await middlewareRequest(handler, path, 'POST', input, { ...headers, 'X-CSRF-Token': csrf })).status, 404);
  } finally { await f.close(); }
});

test('扩展只选取已存在的固定标签页，只接受工作台顶层来源', () => {
  const tabs = [{ id: 1, url: 'https://chatgpt.com/', active: true }, { id: 2, url: 'https://chatgpt.com/c/a', active: false }, { id: 3, url: 'https://chatgpt.com.evil.test/', active: true }];
  assert.equal(selectTarget(tabs, 2).id, 2); assert.equal(selectTarget(tabs, undefined).id, 1); assert.equal(selectTarget([], 2), null);
  assert.equal(workspaceSender({ frameId: 0, url: 'http://localhost:5173/#library' }), true);
  for (const sender of [{ frameId: 1, url: 'http://localhost:5173/' }, { frameId: 0, url: 'http://localhost:8888/' }, { frameId: 0, url: 'https://chatgpt.com/' }]) assert.equal(workspaceSender(sender), false);
});

test('超过 8 MiB 的完整稿件明确拒绝，不保存截断文件或创建发送任务', async () => {
  const f = await fixture();
  try {
    const transcript = structuredClone(f.transcript); transcript.revisionId = 'rev_large'; transcript.speakerTurns = [];
    transcript.chunks = [{ ...transcript.chunks[0], id: 'chunk_large', startMs: 0, endMs: 6000, paddingLeftMs: 0, paddingRightMs: 0 }];
    transcript.segments = Array.from({ length: 340 }, (_, i) => ({ ...transcript.segments[0], id: `seg_large_${i}`, startMs: i * 10, endMs: i * 10 + 10, text: '合'.repeat(9000), words: [], sourceChunkIds: ['chunk_large'] }));
    await f.service.store.installTranscript(f.scope, f.recording.id, transcript);
    await assert.rejects(() => f.transfers.prepare(f.scope, f.recording.id, { targetId, revisionId: transcript.revisionId }), /超过当前自动转发上限/);
    assert.equal((await f.transfers.list(f.scope, f.recording.id, targetId)).length, 0);
    assert.equal((await f.service.store.transcript(f.scope, f.recording.id)).transcript.segments.length, 340, 'original full transcript is retained');
  } finally { await f.close(); }
});
