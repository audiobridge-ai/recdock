import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, exists, id, jsonFile, LibraryError, scopeFor, secureDirectory, validId } from './common.ts';
import { LibraryService } from './service.ts';
import { MAX_AUDIO_BYTES } from './store.ts';
import type { ImportRequest, RevisionState } from './store.ts';
import { exportTranscript, saveRevision } from './revisions.ts';
import type { TranscriptRevision } from '../../src/library/types.ts';
import { ChatGPTTransfers } from './chatgpt.ts';

export interface LibraryContext { accountId?: string; deviceIds: string[]; csrfToken: string }
export function jsonResponse(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new LibraryError('JSON_REQUIRED', '此操作需要 JSON 请求。', 415);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new LibraryError('REQUEST_TOO_LARGE', '请求内容过大，请分批保存修改。', 413); chunks.push(chunk); }
  try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>; } catch { /* No raw request in errors. */ }
  throw new LibraryError('INVALID_JSON', '请求格式不正确。');
}
export function parseRange(value: string | undefined, size: number): { start: number; end: number; status: number } {
  if (!value) return { start: 0, end: size - 1, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) throw new LibraryError('RANGE_INVALID', '此音频范围不可读取。', 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? Math.min(match[2] ? Number(match[2]) : size - 1, size - 1) : size - 1;
  if (![start, end].every(Number.isSafeInteger) || start < 0 || start > end || end >= size || (!match[1] && Number(match[2]) <= 0)) throw new LibraryError('RANGE_INVALID', '此音频范围不可读取。', 416);
  return { start, end, status: 206 };
}
async function stream(req: IncomingMessage, res: ServerResponse, path: string, type: string, filename?: string) {
  const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new LibraryError('ASSET_NOT_FOUND', '未找到此文件。', 404);
  let range;
  try { range = parseRange(req.headers.range, info.size); }
  catch { res.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Content-Length': 0 }); res.end(); return; }
  res.writeHead(range.status, { 'Content-Type': type, 'Content-Length': Math.max(0, range.end - range.start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    ...(range.status === 206 ? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` } : {}), ...(filename ? { 'Content-Disposition': `attachment; filename="recording-export"; filename*=UTF-8''${encodeURIComponent(filename)}` } : {}) });
  if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
  const file = createReadStream(path, { start: range.start, end: range.end });
  res.on('close', () => file.destroy()); file.on('error', () => res.destroy()); file.pipe(res);
}
function numberParam(value: string | null, fallback: number, max: number) { if (value === null) return fallback; const n = Number(value); if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new LibraryError('CURSOR_INVALID', '分页参数不正确。'); return n; }

export function createLibraryHandler(service: LibraryService) {
  const chatgpt = new ChatGPTTransfers(service.store);
  return async (req: IncomingMessage, res: ServerResponse, context: LibraryContext) => {
    try {
      await service.ready;
      const url = new URL(req.url || '/', 'http://localhost'), parts = url.pathname.split('/').filter(Boolean).slice(2);
      const scopeMode = url.searchParams.get('scope') || 'personal';
      if (!['personal', 'account'].includes(scopeMode) || scopeMode === 'account' && !context.accountId) throw new LibraryError('ACCOUNT_REQUIRED', '请先登录对应 PLAUD 账号，或切换到本机个人资料。', 401);
      const scope = scopeFor(scopeMode === 'account' ? context.accountId : undefined);
      if (parts[0] === 'context' && req.method === 'GET') { jsonResponse(res, 200, { csrfToken: context.csrfToken, accountAvailable: !!context.accountId, identity: scopeFor(context.accountId), scope: scopeMode, environment: await service.environment() }); return; }
      if (parts[0] === 'imports' && parts.length === 1 && req.method === 'POST') {
        const data = await body(req); const source = data.source as ImportRequest['source'];
        if (!source || !['import', 'ble'].includes(source.kind) || source.kind === 'import' && (source.deviceId !== null || source.sessionId !== null)) throw new LibraryError('SOURCE_INVALID', '录音来源格式不正确。');
        if (source.kind === 'ble' && (scopeMode !== 'account' || !context.deviceIds.includes(source.deviceId || '') || !Number.isSafeInteger(source.sessionId) || Number(source.sessionId) < 0 || Number(source.sessionId) > 0xffffffff)) throw new LibraryError('DEVICE_SCOPE_INVALID', '设备录音只能保存到其当前已登录账号的资料范围。', 403);
        const playable = data.playable as ImportRequest['playable'];
        if (playable && (source.kind !== 'ble' || typeof playable.filename !== 'string')) throw new LibraryError('SOURCE_INVALID', '仅设备完整下载可附带恢复后的音频。');
        const upload = await service.store.createImport(scope, { filename: data.filename as string, bytes: data.bytes as number, language: data.language as 'zh' | 'en', source: { kind: source.kind, deviceId: source.deviceId, sessionId: source.sessionId }, ...(playable ? { playable: { filename: playable.filename, bytes: playable.bytes } } : {}) });
        jsonResponse(res, 201, { uploadId: upload.id, maxBytes: MAX_AUDIO_BYTES }); return;
      }
      if (parts[0] === 'imports' && parts[1]) {
        const uploadId = validId(parts[1]);
        if (parts[2] === 'content' && req.method === 'PUT') { const role = url.searchParams.get('role') || 'original'; if (!['original', 'playable'].includes(role)) throw new LibraryError('ROLE_INVALID', '音频角色不正确。'); jsonResponse(res, 200, await service.store.upload(scope, uploadId, role as 'original' | 'playable', req)); return; }
        if (parts[2] === 'commit' && req.method === 'POST') {
          const data = await body(req);
          if (data.transcribe !== undefined && typeof data.transcribe !== 'boolean') throw new LibraryError('TRANSCRIBE_INVALID', '请选择仅保存或保存并转写。');
          const committed = await service.store.commit(scope, uploadId); let job = null, processingError = null;
          if (data.transcribe === true && committed.recording.state === 'stored') try { job = await service.enqueue(scope, committed.recording.id, committed.language); } catch (e) { processingError = e instanceof LibraryError ? { code: e.code, message: e.message } : { code: 'QUEUE_UNAVAILABLE', message: '录音已入库，请稍后开始转写。' }; }
          jsonResponse(res, 200, { ...committed, job, processingError }); return;
        }
      }
      if (parts[0] === 'jobs' && parts[1]) {
        const jobId = validId(parts[1]);
        if (parts.length === 2 && req.method === 'GET') { jsonResponse(res, 200, await service.job(scope, jobId)); return; }
        if (parts[2] === 'cancel' && req.method === 'POST') { jsonResponse(res, 200, { job: await service.cancel(scope, jobId) }); return; }
      }
      if (parts[0] === 'recordings') {
        if (parts.length === 1 && req.method === 'GET') {
          const records = (await service.store.records(scope)).filter(r => (r.state === 'deleted') === (url.searchParams.get('trash') === 'true'));
          const offset = numberParam(url.searchParams.get('cursor'), 0, 1000000), limit = numberParam(url.searchParams.get('limit'), 50, 100) || 50;
          jsonResponse(res, 200, { items: await Promise.all(records.slice(offset, offset + limit).map(r => service.store.row(r))), total: records.length, nextCursor: offset + limit < records.length ? offset + limit : null }); return;
        }
        const recordingId = validId(parts[1] || ''); const recording = await service.store.get(scope, recordingId);
        if (parts[2] === 'restore' && req.method === 'POST' && recording.state === 'deleted') {
          recording.state = recording.durationMs ? 'stored' : recording.source.kind === 'ble' ? 'needs_recovery' : 'unsupported'; await atomicJson(join(service.store.recordingDir(scope, recordingId), 'recording.json'), recording); jsonResponse(res, 200, await service.store.row(recording)); return;
        }
        if (recording.state === 'deleted') throw new LibraryError('RECORDING_DELETED', '此录音已移入回收站，请先恢复。', 404);
        if (parts[2] === 'chatgpt' && parts.length === 3 && req.method === 'GET') { jsonResponse(res, 200, { transfers: await chatgpt.list(scope, recordingId, url.searchParams.get('targetId')) }); return; }
        if (parts[2] === 'chatgpt' && parts.length === 3 && req.method === 'POST') { jsonResponse(res, 200, await chatgpt.prepare(scope, recordingId, await body(req))); return; }
        if (parts[2] === 'chatgpt' && parts[3] && req.method === 'PATCH') { jsonResponse(res, 200, { transfer: await chatgpt.update(scope, recordingId, parts[3], await body(req)) }); return; }
        if (parts.length === 2 && req.method === 'GET') { jsonResponse(res, 200, await service.store.row(recording)); return; }
        if (parts.length === 2 && req.method === 'PATCH') { const data = await body(req); jsonResponse(res, 200, await service.store.renameRecording(scope, recordingId, data.title)); return; }
        if (parts.length === 2 && req.method === 'DELETE') {
          for (const job of await service.store.jobs(scope, recordingId)) if (['queued', 'running', 'paused', 'interrupted'].includes(job.state)) await service.cancel(scope, job.id);
          await atomicJson(join(service.store.recordingDir(scope, recordingId), 'recording.json'), { ...recording, state: 'deleted' }); jsonResponse(res, 200, { deleted: true, recoverable: true }); return;
        }
        if (['audio', 'original'].includes(parts[2]) && ['GET', 'HEAD'].includes(req.method || '')) { const asset = await service.store.asset(scope, recordingId, parts[2] === 'original' ? 'original' : 'audio'); await stream(req, res, asset.path, asset.asset.mimeType, parts[2] === 'original' ? `${recording.title}.original` : url.searchParams.get('download') === '1' ? `${recording.title}${asset.asset.relativePath.match(/\.[a-zA-Z0-9]+$/)?.[0] || '.audio'}` : undefined); return; }
        if (parts[2] === 'jobs' && req.method === 'POST') { const data = await body(req); if (!['zh', 'en'].includes(String(data.language))) throw new LibraryError('LANGUAGE_INVALID', '请选择中文或英文。'); jsonResponse(res, 200, { job: await service.enqueue(scope, recordingId, data.language as 'zh' | 'en') }); return; }
        if (parts[2] === 'speakers' && parts[3] && parts[4] === 'preview' && req.method === 'GET') {
          const { transcript } = await service.store.transcript(scope, recordingId), speakerId = decodeURIComponent(parts[3]);
          if (!transcript.speakers.some(s => s.id === speakerId)) throw new LibraryError('SPEAKER_NOT_FOUND', '未找到此讲话人。', 404);
          const turns = transcript.speakerTurns.filter(t => t.speakerId === speakerId), solo = turns.filter(t => !t.overlap);
          const preview = (solo.length ? solo : turns).sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))[0] || transcript.segments.filter(s => s.speakerId === speakerId).sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))[0];
          if (!preview) throw new LibraryError('SPEAKER_NOT_FOUND', '没有可试听的讲话区间。', 404);
          jsonResponse(res, 200, { startMs: preview.startMs, endMs: Math.min(preview.endMs, preview.startMs + 12000) }); return;
        }
        if (parts[2] === 'transcript' && req.method === 'GET') {
          const { transcript, state } = await service.store.transcript(scope, recordingId, url.searchParams.get('revision') || undefined);
          const query = (url.searchParams.get('q') || '').slice(0, 1000).toLocaleLowerCase(), speaker = url.searchParams.get('speaker'); const reviewed = new Set(state.reviewedIds);
          const segments = transcript.segments.filter(s => (!query || s.text.toLocaleLowerCase().includes(query)) && (!speaker || (speaker === 'unknown' ? s.speakerId === null : s.speakerId === speaker)) && (url.searchParams.get('mode') !== 'issues' || s.flags.some(f => ['speaker_uncertain', 'unaligned', 'overlap', 'pending_alignment'].includes(f))) && (url.searchParams.get('mode') !== 'unreviewed' || !reviewed.has(s.id)));
          let offset = numberParam(url.searchParams.get('cursor'), 0, 1000000); const limit = numberParam(url.searchParams.get('limit'), 60, 200) || 60;
          if (url.searchParams.has('at')) { const at = numberParam(url.searchParams.get('at'), 0, transcript.durationMs); const index = segments.findIndex(s => s.startMs <= at && at < s.endMs); if (index >= 0) offset = Math.floor(index / limit) * limit; }
          const { segments: _all, speakerTurns: _turns, ...metadata } = transcript;
          jsonResponse(res, 200, { transcript: { ...metadata, segments: segments.slice(offset, offset + limit) }, revision: state, total: segments.length, totalSegments: transcript.segments.length, nextCursor: offset + limit < segments.length ? offset + limit : null, cursor: offset }); return;
        }
        if (parts[2] === 'revisions' && req.method === 'POST') { const data = await body(req); jsonResponse(res, 200, { revision: await saveRevision(service.store, scope, recordingId, String(data.baseRevisionId), data.changes as TranscriptRevision['changes']) }); return; }
        if (parts[2] === 'revisions' && req.method === 'GET') {
          const current = await service.store.revision(scope, recordingId), directory = join(service.store.recordingDir(scope, recordingId), 'revisions');
          const revisions = [];
          if (await exists(directory)) for (const name of await readdir(directory)) if (/^rev_[A-Za-z0-9_-]+\.state\.json$/.test(name)) {
            const state = await jsonFile<RevisionState>(join(directory, name)); revisions.push({ revisionId: state.revisionId, createdAtMs: state.createdAtMs || recording.createdAtMs, reviewedCount: state.reviewedIds.length, machine: state.revisionId === state.machineRevisionId, current: state.revisionId === current?.revisionId });
          }
          jsonResponse(res, 200, { revisions: revisions.sort((a, b) => b.createdAtMs - a.createdAtMs) }); return;
        }
        if (parts[2] === 'exports' && parts.length === 3 && req.method === 'POST') {
          const data = await body(req); if (typeof data.revisionId !== 'string') throw new LibraryError('REVISION_REQUIRED', '请明确选择要导出的稿件版本。');
          const { transcript, state } = await service.store.transcript(scope, recordingId, validId(data.revisionId));
          if (data.locale !== undefined && data.locale !== 'en' && data.locale !== 'zh-CN') throw new LibraryError('UI_LANGUAGE_INVALID', '界面语言设置不正确。');
          const exported = exportTranscript(recording.title, transcript, state.revisionId === data.revisionId ? state.reviewedIds : [], String(data.format), data.locale === 'en' ? 'en' : 'zh-CN');
          const sha256 = createHash('sha256').update(exported.content).digest('hex'), exportId = `exp_${sha256.slice(0, 32)}`, directory = join(service.store.recordingDir(scope, recordingId), 'exports'); await secureDirectory(directory);
          const filename = `${recording.title.slice(0, 80).replace(/[\\/\u0000-\u001f]/g, '_')}-${recordingId.slice(-8)}-${data.revisionId.slice(-8)}.${exported.extension}`;
          const temporary = join(directory, id('tmp')); await writeFile(temporary, exported.content, { flag: 'wx', mode: 0o600 }); await rename(temporary, join(directory, exportId));
          await atomicJson(join(directory, `${exportId}.json`), { filename, mimeType: exported.mimeType, revisionId: data.revisionId, sha256 });
          jsonResponse(res, 200, { exportId, filename, revisionId: data.revisionId, sha256, url: `/api/library/recordings/${recordingId}/exports/${exportId}?scope=${scopeMode}` }); return;
        }
        if (parts[2] === 'exports' && parts[3] && ['GET', 'HEAD'].includes(req.method || '')) { const exportId = validId(parts[3]), directory = join(service.store.recordingDir(scope, recordingId), 'exports'); const meta = await jsonFile<{ mimeType: string; filename: string }>(join(directory, `${exportId}.json`)); await stream(req, res, join(directory, exportId), meta.mimeType, meta.filename); return; }
      }
      throw new LibraryError('LIBRARY_ROUTE_NOT_FOUND', '未找到此录音库接口。', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const safe = error instanceof LibraryError ? error : new LibraryError('LIBRARY_UNAVAILABLE', '本机录音库处理失败，原始文件已保留，请稍后重试。', 500);
      jsonResponse(res, safe.status, { error: { code: safe.code, message: safe.message } });
    }
  };
}
