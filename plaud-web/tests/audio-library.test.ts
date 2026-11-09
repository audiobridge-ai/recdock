import { middlewareRequest } from './helpers/middleware.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { LibraryService } from '../server/library/service.ts';
import { createLibraryHandler } from '../server/library/http.ts';
import { createCloudMiddleware } from '../server/http.ts';
import { scopeFor } from '../server/library/common.ts';
import type { CloudSession } from '../server/cloud-client.ts';
import type { VaultData } from '../server/vault.ts';
import type { RecordingRow } from '../server/library/store.ts';

function wav() {
  const data = Buffer.alloc(32044); data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(32000, 40);
  for (let i = 0; i < 16000; i++) data.writeInt16LE(Math.round(Math.sin(i * .1) * 2000), 44 + i * 2);
  return data;
}
const worker = `#!/usr/bin/env python3
import argparse,json,pathlib,sys,time,hashlib,subprocess
p=argparse.ArgumentParser();p.add_argument('--recording-dir');a,_=p.parse_known_args()
c=json.loads(sys.stdin.readline());r=pathlib.Path(a.recording_dir);meta=json.loads((r/'recording.json').read_text());w=r/'work'/c['payload']['pipelineFingerprint'];w.mkdir(parents=True,exist_ok=True);seq=0
def event(name,payload,stage=None):
 global seq
 seq+=1;print(json.dumps({'protocolVersion':1,'event':name,'sequence':seq,'jobId':None if name=='ready' else c['jobId'],'stage':stage,'payload':payload}),flush=True)
event('ready',{'workerVersion':'synthetic-test','capabilities':['preparing','transcribing','aligning','diarizing','merging']})
if meta['title']=='bad-protocol':
 print('THIS IS NOT JSON',flush=True);time.sleep(10);sys.exit(1)
stages=[('preparing','prepare.json'),('transcribing','asr.json'),('aligning','align.json'),('diarizing','diarize.json'),('merging','transcript.json')]
for stage,name in stages:
 event('stage_started',{'inputFingerprint':c['payload']['pipelineFingerprint']},stage)
 if stage=='transcribing' and meta['title']=='slow' and not (w/'started-once').exists():
  (w/'started-once').write_text(str(__import__('os').getpid()));time.sleep(8)
 if stage=='transcribing' and meta['title']=='fail-once' and not (w/'failed-once').exists():
  (w/'failed-once').write_text('yes');event('failed',{'code':'TEST_FAILURE','message':'test only','retryable':True});sys.exit(0)
 if stage=='merging':
  value={'schemaVersion':1,'recordingId':meta['id'],'sourceSha256':meta['sourceSha256'],'durationMs':1000,'revisionId':'rev_machine_'+c['payload']['pipelineFingerprint'][:32],'language':'zh','provenance':{'pipelineVersion':'synthetic-test','asr':None,'aligner':None,'diarizer':None},'speakers':[{'id':'SPEAKER_00','displayName':'讲话人 1','nameSource':'default'}],'segments':[{'id':'seg_a','startMs':0,'endMs':500,'speakerId':'SPEAKER_00','text':'合成测试第一段。','timingSource':'asr_segment','overlap':False,'flags':[],'sourceChunkIds':['chunk_a'],'words':[],'scores':None},{'id':'seg_b','startMs':500,'endMs':1000,'speakerId':None,'text':'合成测试最后一段。','timingSource':'asr_segment','overlap':False,'flags':['speaker_uncertain'],'sourceChunkIds':['chunk_a'],'words':[],'scores':None}],'speakerTurns':[],'chunks':[{'id':'chunk_a','startMs':0,'endMs':1000,'paddingLeftMs':0,'paddingRightMs':0,'status':'ready','errorCode':None}]}
 else:value={'testStage':stage}
 (w/name).write_text(json.dumps(value));sha=hashlib.sha256((w/name).read_bytes()).hexdigest();event('artifact',{'kind':stage,'relativePath':name,'sha256':sha},stage)
event('completed',{'transcriptRelativePath':'transcript.json','sha256':hashlib.sha256((w/'transcript.json').read_bytes()).hexdigest()})
`;
async function setup() {
  const temp = await mkdtemp(join(tmpdir(), 'recdock-library-')); const models = join(temp, 'models'), python = join(temp, 'worker');
  await mkdir(models); await writeFile(join(models, 'models.lock.json'), JSON.stringify({ models: {} })); await writeFile(python, worker, { mode: 0o700 });
  const options = { root: join(temp, 'library'), workspace: process.cwd(), models, python };
  let service = new LibraryService(options); await service.ready;
  let memory: VaultData = { version: 1, accounts: {} };
  const cloudSession = (account: string): CloudSession => ({ userToken: 'TEST_ONLY', userBaseUrl: 'https://api.plaud.ai', account: { accountId: account, email: account }, devices: [{ serialNumber: 'device-' + account, name: '测试设备' }] });
  const client = { async login(email: string) { return cloudSession(email); }, async importSession() { return cloudSession('import@example.com'); }, async devices(s: CloudSession) { return s.devices; }, async restore(s: CloudSession) { return s; }, async prepare(): Promise<never> { throw Error('unused'); } };
  const store = { async load() { return structuredClone(memory); }, async update(fn: (data: VaultData) => void | Promise<void>) { const next = structuredClone(memory); await fn(next); memory = next; } };
  const handler = createCloudMiddleware(client, Date.now, { store, library: async (req, res, context) => createLibraryHandler(service)(req, res, context), onAccountGranted: account => service.grantAccount(account), onAccountRevoked: account => service.revokeAccount(account) });
  async function browser() {
    let cookie = '', csrf = '';
    async function request(path: string, data?: unknown, method = data === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) {
      const bytes = Buffer.isBuffer(data) ? data : data === undefined ? undefined : JSON.stringify(data);
      const result = await middlewareRequest(handler, path, method, bytes === undefined ? undefined : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(data === undefined ? {} : { 'Content-Type': Buffer.isBuffer(data) ? 'application/octet-stream' : 'application/json' }), ...extra });
      if (result.headers.get('set-cookie')) cookie = result.headers.get('set-cookie')!.split(';')[0];
      const { json } = result;
      if (json?.csrfToken) csrf = json.csrfToken;
      return result;
    }
    await request('/api/session');
    return { request, async login(email: string) { return request('/api/login', { email, password: 'TEST_ONLY', remember: false }); } };
  }
  const guest = await browser();
  async function importAudio(name = 'test.wav', caller = guest, scope = 'personal', source = { kind: 'import', deviceId: null, sessionId: null } as object, transcribe: boolean | null = true) {
    const data = wav(), created = await caller.request(`/api/library/imports?scope=${scope}`, { filename: name, bytes: data.length, language: 'zh', source }); assert.equal(created.status, 201);
    const uploadId = created.json.uploadId; assert.equal((await caller.request(`/api/library/imports/${uploadId}/content?scope=${scope}`, data, 'PUT')).status, 200);
    const committed = await caller.request(`/api/library/imports/${uploadId}/commit?scope=${scope}`, { transcribe: transcribe ?? undefined }); assert.equal(committed.status, 200, JSON.stringify(committed.json)); return committed.json;
  }
  async function waitJob(scope: string, jobId: string, state: string, max = 10000) {
    const until = Date.now() + max;
    while (Date.now() < until) { const value = await service.job(scope, jobId); if (value.job.state === state) return value.job; await new Promise(r => setTimeout(r, 30)); }
    throw Error(`job did not reach ${state}: ${JSON.stringify(await service.job(scope, jobId))}`);
  }
  return { temp, options, browser, guest, importAudio, waitJob, get service() { return service; }, async restart() { await service.close(); service = new LibraryService(options); await service.ready; }, async close() { await service.close(); await rm(temp, { recursive: true, force: true }); } };
}

test('录音流式入库自动排队，重复导入幂等，音频 Range 只读取指定字节', async () => {
  const f = await setup();
  try {
    const first = await f.importAudio(); await f.waitJob(scopeFor(), first.job.id, 'succeeded');
    const second = await f.importAudio(); assert.equal(second.recording.id, first.recording.id); assert.equal(second.job.id, first.job.id); assert.equal(second.duplicate, true);
    const range = await f.guest.request(`/api/library/recordings/${first.recording.id}/audio`, undefined, 'GET', { Range: 'bytes=2-9' }); assert.equal(range.status, 206); assert.deepEqual(range.raw, wav().subarray(2, 10));
    const invalid = await f.guest.request(`/api/library/recordings/${first.recording.id}/audio`, undefined, 'GET', { Range: 'bytes=999999-' }); assert.equal(invalid.status, 416);
    assert.equal((await f.guest.request('/api/library/recordings')).json.items.length, 1);
  } finally { await f.close(); }
});

test('仅保存与缺省请求不启动转写，重启仍不启动；主动开始后生成可读全文', async () => {
  const f = await setup();
  try {
    const saved = await f.importAudio('only-save.wav', f.guest, 'personal', { kind: 'import', deviceId: null, sessionId: null }, false);
    assert.equal(saved.job, null);
    const repeated = await f.importAudio('only-save.wav', f.guest, 'personal', { kind: 'import', deviceId: null, sessionId: null }, null);
    assert.equal(repeated.job, null);
    assert.equal(repeated.recording.id, saved.recording.id);
    const directory = f.service.store.recordingDir(scopeFor(), saved.recording.id);
    assert.equal((await f.guest.request(`/api/library/recordings/${saved.recording.id}`)).json.job, null);
    await f.restart();
    assert.equal((await f.guest.request(`/api/library/recordings/${saved.recording.id}`)).json.job, null);
    const started = await f.guest.request(`/api/library/recordings/${saved.recording.id}/jobs`, { language: 'en' });
    await f.waitJob(scopeFor(), started.json.job.id, 'succeeded');
    const latest = JSON.parse(await readFile(join(directory, 'exports', 'latest.json'), 'utf8'));
    const markdown = await readFile(join(directory, 'exports', 'latest.md'), 'utf8');
    assert.match(markdown, /合成测试第一段/); assert.match(markdown, /合成测试最后一段/);
    assert.match(markdown, new RegExp(latest.transcript.revisionId));
    const rename = await f.guest.request(`/api/library/recordings/${saved.recording.id}`, { title: '我的会议录音' }, 'PATCH');
    assert.equal(rename.status, 200); assert.equal(rename.json.storagePath, directory);
    assert.match(await readFile(join(directory, 'exports', 'latest.md'), 'utf8'), /我的会议录音/);
  } finally { await f.close(); }
});

test('设备 Ogg 与原件同目录保存，仅下载不启动 Worker，后续转写复用同一录音', async () => {
  const f = await setup();
  try {
    const account = await f.browser(); await account.login('ogg@example.com');
    const encoded = spawnSync('ffmpeg', ['-v', 'error', '-f', 'wav', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1'], { input: wav() });
    assert.equal(encoded.status, 0, encoded.stderr?.toString()); const ogg = encoded.stdout, original = Buffer.from('synthetic encrypted device bytes');
    const input = { filename: 'plaud-42.bin', bytes: original.length, language: 'en', source: { kind: 'ble', deviceId: 'device-ogg@example.com', sessionId: 42 }, playable: { filename: 'plaud-42.ogg', bytes: ogg.length } };
    async function save(transcribe: boolean) {
      const upload = await account.request('/api/library/imports?scope=account', input);
      const path = `/api/library/imports/${upload.json.uploadId}`;
      assert.equal((await account.request(path + '/content?scope=account', original, 'PUT')).status, 200);
      assert.equal((await account.request(path + '/content?scope=account&role=playable', ogg, 'PUT')).status, 200);
      return account.request(path + '/commit?scope=account', { transcribe });
    }
    const saved = await save(false); assert.equal(saved.status, 200); assert.equal(saved.json.job, null);
    const directory = f.service.store.recordingDir(scopeFor('ogg@example.com'), saved.json.recording.id);
    assert.deepEqual(await readFile(join(directory, 'original', 'source.bin')), original);
    assert.deepEqual(await readFile(join(directory, 'playable', 'audio.ogg')), ogg);
    const audio = await account.request(`/api/library/recordings/${saved.json.recording.id}/audio?scope=account&download=1`);
    assert.deepEqual(audio.raw, ogg); assert.match(audio.headers.get('content-disposition')!, /attachment/);
    const queued = await save(true); assert.equal(queued.json.recording.id, saved.json.recording.id); assert.equal(queued.json.duplicate, true);
    await f.waitJob(scopeFor('ogg@example.com'), queued.json.job.id, 'succeeded');
    assert.match(await readFile(join(directory, 'exports', 'latest.md'), 'utf8'), /合成测试最后一段/);
    assert.equal((await account.request(`/api/library/recordings/${saved.json.recording.id}?scope=account`)).json.language, 'en');
  } finally { await f.close(); }
});

test('未完整上传不进入录音列表，其他网站和缺少 CSRF 不能导入，源路径不由客户端选择', async () => {
  const f = await setup();
  try {
    const input = { filename: '../../escape.wav', bytes: wav().length + 20, language: 'zh', source: { kind: 'import', deviceId: null, sessionId: null } };
    const created = await f.guest.request('/api/library/imports', input); assert.equal(created.status, 201);
    assert.equal((await f.guest.request(`/api/library/imports/${created.json.uploadId}/content`, wav(), 'PUT')).status, 400);
    assert.equal((await f.guest.request(`/api/library/imports/${created.json.uploadId}/commit`, {})).status, 400);
    assert.equal((await f.guest.request('/api/library/recordings')).json.items.length, 0);
    assert.equal((await f.guest.request('/api/library/imports', input, 'POST', { Origin: 'https://example.com' })).status, 403);
    assert.equal((await f.guest.request('/api/library/imports', input, 'POST', { 'X-CSRF-Token': 'wrong' })).status, 403);
    assert.equal((await f.guest.request('/api/library/recordings?scope=scope_arbitrary')).status, 401);
  } finally { await f.close(); }
});

test('账号与个人资料隔离，其他账号不能读音频或改稿，退出账号暂停任务', async () => {
  const f = await setup();
  try {
    const a = await f.browser(), b = await f.browser(); await a.login('a@example.com'); await b.login('b@example.com');
    const record = await f.importAudio('slow.wav', a, 'account', { kind: 'ble', deviceId: 'device-a@example.com', sessionId: 1 });
    await f.waitJob(scopeFor('a@example.com'), record.job.id, 'running');
    assert.equal((await b.request(`/api/library/recordings/${record.recording.id}/audio?scope=account`)).status, 404);
    assert.equal((await f.guest.request(`/api/library/recordings/${record.recording.id}`)).status, 404);
    assert.equal((await b.request(`/api/library/recordings/${record.recording.id}/revisions?scope=account`, { baseRevisionId: 'rev_x', changes: [] })).status, 404);
    assert.equal((await a.request('/api/logout', {})).status, 200);
    assert.equal((await f.service.job(scopeFor('a@example.com'), record.job.id)).job.state, 'paused');
    assert.equal((await a.request(`/api/library/recordings?scope=account`)).status, 401);
  } finally { await f.close(); }
});

test('校对修改持久保存、清空旧词时间、检测冲突，完整导出与历史版本绑定', async () => {
  const f = await setup();
  try {
    const record = await f.importAudio(); await f.waitJob(scopeFor(), record.job.id, 'succeeded'); const path = `/api/library/recordings/${record.recording.id}`;
    const page = await f.guest.request(path + '/transcript?limit=1'); const base = page.json.transcript.revisionId;
    const edited = await f.guest.request(path + '/revisions', { baseRevisionId: base, changes: [{ kind: 'segment_text', segmentId: 'seg_a', text: '已人工修改的第一段。' }, { kind: 'speaker_name', speakerId: 'SPEAKER_00', displayName: '主持人' }, { kind: 'segment_reviewed', segmentId: 'seg_a', reviewed: true }] }); assert.equal(edited.status, 200);
    assert.equal((await f.guest.request(path + '/revisions', { baseRevisionId: base, changes: [{ kind: 'segment_text', segmentId: 'seg_a', text: '不能覆盖' }] })).status, 409);
    const latest = await f.guest.request(path + '/transcript'); assert.equal(latest.json.transcript.segments[0].text, '已人工修改的第一段。'); assert.deepEqual(latest.json.transcript.segments[0].words, []); assert.equal(latest.json.transcript.segments[0].timingSource, 'user_pending');
    const directory = f.service.store.recordingDir(scopeFor(), record.recording.id);
    assert.match(await readFile(join(directory, 'exports', 'latest.md'), 'utf8'), /已人工修改的第一段/);
    assert.match(await readFile(join(directory, 'exports', base, 'transcript.md'), 'utf8'), /合成测试第一段/);
    const old = await f.guest.request(path + `/transcript?revision=${base}`); assert.equal(old.json.transcript.segments[0].text, '合成测试第一段。'); assert.deepEqual(old.json.revision.reviewedIds, []);
    const exported = await f.guest.request(path + '/exports', { revisionId: edited.json.revision.revisionId, format: 'md' }); assert.equal(exported.status, 200);
    const download = await f.guest.request(exported.json.url); assert.match(download.raw.toString(), /已人工修改的第一段/); assert.match(download.raw.toString(), /合成测试最后一段/); assert.match(download.raw.toString(), /主持人/); assert.match(download.raw.toString(), /1\/2 段/); assert.equal(createHash('sha256').update(download.raw).digest('hex'), exported.json.sha256);
    await f.restart(); const restored = await f.guest.request(path + '/transcript'); assert.equal(restored.json.transcript.revisionId, edited.json.revision.revisionId);
    const history = await f.guest.request(path + '/revisions'); assert.equal(history.json.revisions.length, 2);
  } finally { await f.close(); }
});

test('失败重试复用目录，账号任务重启后等待授权恢复，非法 Worker 消息拒绝发布', async () => {
  const f = await setup();
  try {
    const first = await f.importAudio('fail-once.wav'); await f.waitJob(scopeFor(), first.job.id, 'failed');
    const retry = await f.guest.request(`/api/library/recordings/${first.recording.id}/jobs`, { language: 'zh' }); assert.notEqual(retry.json.job.id, first.job.id); await f.waitJob(scopeFor(), retry.json.job.id, 'succeeded');
    // Same bytes are a duplicate; a separate scope supplies an independent record.
    const a = await f.browser(); await a.login('restart@example.com');
    const slow = await f.importAudio('slow.wav', a, 'account', { kind: 'ble', deviceId: 'device-restart@example.com', sessionId: 4 }); await f.waitJob(scopeFor('restart@example.com'), slow.job.id, 'running');
    await f.restart(); assert.equal((await f.service.job(scopeFor('restart@example.com'), slow.job.id)).job.state, 'paused'); await f.service.grantAccount('restart@example.com');
    await f.waitJob(scopeFor('restart@example.com'), slow.job.id, 'succeeded');
    const bad = await f.browser(); await bad.login('bad@example.com'); const protocol = await f.importAudio('bad-protocol.wav', bad, 'account', { kind: 'ble', deviceId: 'device-bad@example.com', sessionId: 5 }); const failed = await f.waitJob(scopeFor('bad@example.com'), protocol.job.id, 'failed'); assert.equal(failed.error?.code, 'WORKER_PROTOCOL_INVALID');
  } finally { await f.close(); }
});

async function waitCheckpoint(f: Awaited<ReturnType<typeof setup>>, recordingId: string, fingerprint: string) {
  const file = join(f.options.root, 'scopes', scopeFor(), 'recordings', recordingId, 'work', fingerprint, 'started-once');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(file, 'utf8')); } catch { await new Promise(r => setTimeout(r, 25)); }
  }
  throw Error('worker did not enter the interruptible checkpoint');
}

test('个人任务在服务重启后自动恢复，保留阶段与同一任务身份', async () => {
  const f = await setup();
  try {
    const imported = await f.importAudio('slow.wav');
    const running = await f.waitJob(scopeFor(), imported.job.id, 'running');
    const pid = await waitCheckpoint(f, imported.recording.id, running.pipelineFingerprint);
    await f.restart();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    const finished = await f.waitJob(scopeFor(), imported.job.id, 'succeeded');
    assert.equal(finished.pipelineFingerprint, running.pipelineFingerprint);
    assert.equal(finished.completedStages.length, 5);
    const { runtime } = await f.service.job(scopeFor(), imported.job.id);
    assert.equal(runtime?.resumed, true); assert.equal(runtime?.attempt, 2);
    assert.equal((await f.guest.request(`/api/library/recordings/${imported.recording.id}/transcript`)).status, 200);
  } finally { await f.close(); }
});

test('用户取消会终止活动 Worker，重启不自动重跑，显式重试才恢复', async () => {
  const f = await setup();
  try {
    const imported = await f.importAudio('slow.wav');
    const running = await f.waitJob(scopeFor(), imported.job.id, 'running');
    const pid = await waitCheckpoint(f, imported.recording.id, running.pipelineFingerprint);
    assert.equal((await f.guest.request(`/api/library/jobs/${imported.job.id}/cancel`, {})).status, 200);
    const cancelled = (await f.service.job(scopeFor(), imported.job.id)).job;
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.stage, null);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await f.restart();
    assert.equal((await f.service.job(scopeFor(), imported.job.id)).job.state, 'cancelled');
    const retry = await f.guest.request(`/api/library/recordings/${imported.recording.id}/jobs`, { language: 'zh' });
    assert.notEqual(retry.json.job.id, imported.job.id);
    await f.waitJob(scopeFor(), retry.json.job.id, 'succeeded');
  } finally { await f.close(); }
});

test('移入回收站后停止访问，恢复保留原件及稿件', async () => {
  const f = await setup();
  try {
    const record = await f.importAudio(); await f.waitJob(scopeFor(), record.job.id, 'succeeded'); const path = `/api/library/recordings/${record.recording.id}`;
    assert.equal((await f.guest.request(path, undefined, 'DELETE')).status, 200); assert.equal((await f.guest.request(path + '/audio')).status, 404);
    assert.equal((await f.guest.request('/api/library/recordings')).json.total, 0); assert.equal((await f.guest.request('/api/library/recordings?trash=true')).json.total, 1);
    assert.equal((await f.guest.request(path + '/restore', {})).status, 200); assert.equal((await f.guest.request(path + '/transcript')).status, 200);
    const stored = JSON.parse(await readFile(join(f.options.root, 'scopes', scopeFor(), 'recordings', record.recording.id, 'recording.json'), 'utf8')) as RecordingRow['recording']; assert.equal(stored.sourceSha256, createHash('sha256').update(wav()).digest('hex'));
  } finally { await f.close(); }
});
