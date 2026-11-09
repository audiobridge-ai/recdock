import { writeReadableTranscript } from './transcript-export.ts';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, open, readdir, rename, rm, statfs } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { AudioJob, AudioTranscript, LibraryRecording, TranscriptRevision } from '../../src/library/types.ts';
import { assertAudioContract } from '../transcription/contracts.ts';
import { atomicJson, exists, fileSha256, id, isMissing, jsonFile, LibraryError, secureDirectory, validId } from './common.ts';

export const MAX_AUDIO_BYTES = 1024 ** 3;
export interface ImportRequest {
  filename: string; bytes: number; language: 'zh' | 'en';
  source: LibraryRecording['source']; playable?: { filename: string; bytes: number };
}
interface Upload extends ImportRequest { id: string; scopeId: string; createdAtMs: number }
export interface RevisionState { revisionId: string; machineRevisionId: string; reviewedIds: string[]; createdAtMs?: number }
export interface JobProgress { completedUnits: number; totalUnits: number | null; unit: string }
export interface JobRuntime { progress: JobProgress | null; attempt: number; resumed: boolean }
export interface RecordingRow { recording: LibraryRecording; job: AudioJob | null; runtime: JobRuntime | null; revision: RevisionState | null; language: 'zh' | 'en'; storagePath: string }
export type RevisionChange = TranscriptRevision['changes'][number];

function safeFilename(value: string) {
  return basename(value.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || '录音';
}
function expectedBytes(value: number) { if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_AUDIO_BYTES) throw new LibraryError('FILE_SIZE_INVALID', '请选择非空且不超过 1 GiB 的音频文件。', 413); }
async function mediaProbe(path: string): Promise<{ durationMs: number; mimeType: string }> {
  const output = await subprocess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type', '-of', 'json', path], 30000);
  const info = JSON.parse(output) as { format?: { duration?: string; format_name?: string }; streams?: { codec_type: string }[] };
  const seconds = Number(info.format?.duration);
  if (!info.streams?.some(s => s.codec_type === 'audio') || !Number.isFinite(seconds) || seconds <= 0 || seconds > 21600) throw new LibraryError('AUDIO_UNSUPPORTED', '此文件没有可识别的音频，或时长超过当前 6 小时上限。');
  await subprocess('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', path, '-map', '0:a:0', '-f', 'null', '-'], 600000);
  const format = info.format?.format_name || '';
  return { durationMs: Math.round(seconds * 1000), mimeType: format.includes('mp3') ? 'audio/mpeg' : format.includes('ogg') ? 'audio/ogg' : format.includes('wav') ? 'audio/wav' : format.includes('mov') ? 'audio/mp4' : 'application/octet-stream' };
}
export function subprocess(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', finished = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(new LibraryError('AUDIO_PROBE_TIMEOUT', '检查音频超时，原文件已保留。')); }, timeout);
    function done(error?: Error) { if (finished) return; finished = true; clearTimeout(timer); if (error) reject(error); else resolvePromise(output); }
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 4 * 1024 * 1024) { child.kill(); done(new LibraryError('AUDIO_UNSUPPORTED', '音频元信息过大。')); } });
    child.stderr.resume();
    child.on('error', () => done(new LibraryError('FFMPEG_UNAVAILABLE', '本机 FFmpeg / FFprobe 不可用，请检查环境。', 503)));
    child.on('close', code => done(code === 0 ? undefined : new LibraryError('AUDIO_UNSUPPORTED', '音频无法完整解码，已保留原文件，尚未排队转写。')));
  });
}

export class LibraryStore {
  readonly root: string;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(root: string) { this.root = resolve(root); }
  async serial<T>(action: () => Promise<T>): Promise<T> { const next = this.writes.then(action); this.writes = next.catch(() => {}); return next; }
  scope(scope: string) { return join(this.root, 'scopes', validId(scope)); }
  recordingDir(scope: string, recording: string) { return join(this.scope(scope), 'recordings', validId(recording)); }
  async init() {
    await secureDirectory(this.root); await secureDirectory(join(this.root, 'scopes'));
  }
  async prepareScope(scope: string) {
    await secureDirectory(this.scope(scope)); await secureDirectory(join(this.scope(scope), 'recordings')); await secureDirectory(join(this.scope(scope), 'imports'));
  }
  async scopes(): Promise<string[]> { return (await readdir(join(this.root, 'scopes'))).filter(x => /^scope_[a-zA-Z0-9_-]+$/.test(x)); }
  async get(scope: string, recording: string): Promise<LibraryRecording> {
    try {
      const directory = this.recordingDir(scope, recording); const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      const value = await jsonFile<LibraryRecording>(join(directory, 'recording.json')); assertAudioContract('Recording', value);
      if (value.id !== recording || value.scopeId !== scope) throw new Error();
      return value;
    } catch (error) { if (error instanceof LibraryError) throw error; throw new LibraryError('RECORDING_NOT_FOUND', '未找到此录音。', 404); }
  }
  async records(scope: string): Promise<LibraryRecording[]> {
    await this.prepareScope(scope); const values = [];
    for (const name of await readdir(join(this.scope(scope), 'recordings'))) {
      if (/^rec_[A-Za-z0-9_-]+$/.test(name)) values.push(await this.get(scope, name));
    }
    return values.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }
  async createImport(scope: string, input: ImportRequest) {
    expectedBytes(input.bytes); if (input.playable) expectedBytes(input.playable.bytes);
    if (!['zh', 'en'].includes(input.language)) throw new LibraryError('LANGUAGE_INVALID', '请选择中文或英文处理模式。');
    if (!input.filename || typeof input.filename !== 'string') throw new LibraryError('FILENAME_INVALID', '请提供文件名。');
    const space = await statfs(this.root);
    if (space.bavail * space.bsize < (input.bytes + (input.playable?.bytes || 0)) * 2 + 256 * 1024 * 1024) throw new LibraryError('DISK_FULL', '本机可用空间不足，请释放空间后重试。', 507);
    await this.prepareScope(scope);
    const upload: Upload = { ...input, filename: safeFilename(input.filename), ...(input.playable ? { playable: { ...input.playable, filename: safeFilename(input.playable.filename) } } : {}), id: id('imp'), scopeId: scope, createdAtMs: Date.now() };
    const directory = join(this.scope(scope), 'imports', upload.id); await secureDirectory(directory); await atomicJson(join(directory, 'import.json'), upload);
    return upload;
  }
  async upload(scope: string, uploadId: string, role: 'original' | 'playable', req: IncomingMessage) {
    const directory = join(this.scope(scope), 'imports', validId(uploadId));
    let meta: Upload;
    try { meta = await jsonFile<Upload>(join(directory, 'import.json')); } catch { throw new LibraryError('UPLOAD_NOT_FOUND', '导入已失效，请重新选择文件。', 404); }
    const size = role === 'original' ? meta.bytes : meta.playable?.bytes;
    if (meta.scopeId !== scope || !size) throw new LibraryError('UPLOAD_NOT_FOUND', '此上传不属于当前资料范围。', 404);
    const path = join(directory, `${role}.uploading`), ready = join(directory, `${role}.ready`);
    if (await exists(ready)) throw new LibraryError('UPLOAD_EXISTS', '此文件已经上传，请完成导入。', 409);
    let handle;
    try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch { throw new LibraryError('UPLOAD_BUSY', '文件正在上传，请稍后重试。', 409); }
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > size || bytes > MAX_AUDIO_BYTES) throw new LibraryError('UPLOAD_TOO_LARGE', '上传内容超过声明的文件大小。', 413);
        await handle.writeFile(chunk);
      }
      if (bytes !== size || req.aborted) throw new LibraryError('UPLOAD_INCOMPLETE', '文件上传不完整，请重新导入。');
      await handle.sync(); await handle.close(); handle = undefined; await rename(path, ready);
    } finally { await handle?.close(); await rm(path, { force: true }); }
    return { uploadedBytes: bytes };
  }
  async commit(scope: string, uploadId: string): Promise<{ recording: LibraryRecording; language: 'zh' | 'en'; duplicate: boolean }> {
    return this.serial(async () => {
      const directory = join(this.scope(scope), 'imports', validId(uploadId));
      let meta: Upload;
      try { meta = await jsonFile<Upload>(join(directory, 'import.json')); } catch { throw new LibraryError('UPLOAD_NOT_FOUND', '导入已失效，请重新选择文件。', 404); }
      if (meta.scopeId !== scope) throw new LibraryError('UPLOAD_NOT_FOUND', '此上传不属于当前资料范围。', 404);
      const original = join(directory, 'original.ready'), playable = join(directory, 'playable.ready');
      if (!await exists(original) || (await lstat(original)).size !== meta.bytes || (meta.playable && (!await exists(playable) || (await lstat(playable)).size !== meta.playable.bytes))) throw new LibraryError('UPLOAD_INCOMPLETE', '文件上传尚未完整完成，未入库。');
      const sourceSha256 = await fileSha256(original);
      const duplicate = (await this.records(scope)).find(r => r.sourceSha256 === sourceSha256);
      if (duplicate) {
        if (duplicate.state === 'deleted') { duplicate.state = duplicate.durationMs ? 'stored' : duplicate.source.kind === 'ble' ? 'needs_recovery' : 'unsupported'; await atomicJson(join(this.recordingDir(scope, duplicate.id), 'recording.json'), duplicate); }
        if (meta.playable && duplicate.state !== 'stored') {
          try {
            const media = await mediaProbe(playable), directory = this.recordingDir(scope, duplicate.id), playableId = id('asset');
            const relativePath = `playable/audio${meta.playable.filename.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] || '.bin'}`;
            await secureDirectory(join(directory, 'playable')); await copyFile(playable, join(directory, relativePath), constants.COPYFILE_EXCL); await chmod(join(directory, relativePath), 0o600);
            duplicate.assets = [...duplicate.assets.filter(a => a.role !== 'playable'), { id: playableId, role: 'playable', relativePath, sha256: await fileSha256(playable), bytes: meta.playable.bytes, mimeType: media.mimeType }];
            duplicate.state = 'stored'; duplicate.durationMs = media.durationMs; assertAudioContract('Recording', duplicate); await atomicJson(join(directory, 'recording.json'), duplicate);
          } catch (error) { if (!(error instanceof LibraryError && error.code === 'AUDIO_UNSUPPORTED')) throw error; }
        }
        await rm(directory, { recursive: true, force: true }); return { recording: duplicate, language: meta.language, duplicate: true };
      }
      let media: { durationMs: number; mimeType: string } | undefined;
      try { media = await mediaProbe(meta.playable ? playable : original); }
      catch (error) { if (error instanceof LibraryError && ['AUDIO_UNSUPPORTED'].includes(error.code)) { /* Preserve unsupported/raw input as an explicit record. */ } else throw error; }
      const recordingId = id('rec'), assetId = id('asset'), extension = meta.filename.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] || '.bin';
      const pending = join(directory, 'recording'); await secureDirectory(pending); await secureDirectory(join(pending, 'original'));
      const originalRelative = `original/source${extension}`;
      await copyFile(original, join(pending, originalRelative), constants.COPYFILE_EXCL); await chmod(join(pending, originalRelative), 0o600);
      const recording: LibraryRecording = { schemaVersion: 1, id: recordingId, scopeId: scope, title: meta.filename.replace(/\.[^.]+$/, ''), source: meta.source, sourceSha256,
        durationMs: media?.durationMs ?? null, createdAtMs: Date.now(), state: media ? 'stored' : meta.source.kind === 'ble' ? 'needs_recovery' : 'unsupported',
        assets: [{ id: assetId, role: 'original', relativePath: originalRelative, sha256: sourceSha256, bytes: meta.bytes, mimeType: meta.playable ? 'application/octet-stream' : media?.mimeType || 'application/octet-stream' }] };
      if (meta.playable) {
        const playableId = id('asset'), relativePath = `playable/audio${meta.playable.filename.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] || '.bin'}`;
        await secureDirectory(join(pending, 'playable')); await copyFile(playable, join(pending, relativePath), constants.COPYFILE_EXCL); await chmod(join(pending, relativePath), 0o600);
        recording.assets.push({ id: playableId, role: 'playable', relativePath, sha256: await fileSha256(playable), bytes: meta.playable.bytes, mimeType: media?.mimeType || 'application/octet-stream' });
      }
      assertAudioContract('Recording', recording); await atomicJson(join(pending, 'recording.json'), recording);
      await atomicJson(join(pending, 'settings.json'), { language: meta.language });
      await rename(pending, this.recordingDir(scope, recordingId)); await rm(directory, { recursive: true, force: true });
      return { recording, language: meta.language, duplicate: false };
    });
  }
  async asset(scope: string, recordingId: string, role: 'original' | 'audio' = 'audio') {
    const recording = await this.get(scope, recordingId);
    const asset = role === 'original' ? recording.assets.find(a => a.role === 'original')! : recording.assets.find(a => a.role === 'playable') || recording.assets.find(a => a.role === 'original')!;
    const directory = this.recordingDir(scope, recordingId), path = resolve(directory, asset.relativePath);
    if (!path.startsWith(directory + '/') || (await lstat(path)).isSymbolicLink()) throw new LibraryError('ASSET_UNAVAILABLE', '此音频资产不可读取。', 404);
    return { recording, asset, path };
  }
  async jobs(scope: string, recordingId: string): Promise<AudioJob[]> {
    const directory = join(this.recordingDir(scope, recordingId), 'jobs');
    if (!await exists(directory)) return [];
    const result = [];
    for (const name of await readdir(directory)) if (/^job_[A-Za-z0-9_-]+\.json$/.test(name)) { const job = await jsonFile<AudioJob>(join(directory, name)); assertAudioContract('Job', job); if (job.scopeId !== scope || job.recordingId !== recordingId || name !== `${job.id}.json`) throw new LibraryError('JOB_SOURCE_INVALID', '任务来源与录音不一致，已停止读取。', 500); result.push(job); }
    return result.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }
  async saveJob(job: AudioJob, runtime?: JobRuntime) {
    assertAudioContract('Job', job); const directory = join(this.recordingDir(job.scopeId, job.recordingId), 'jobs');
    await atomicJson(join(directory, `${job.id}.json`), job);
    if (runtime) await atomicJson(join(directory, `${job.id}.runtime.json`), runtime);
  }
  async runtime(job: AudioJob) { try { return await jsonFile<JobRuntime>(join(this.recordingDir(job.scopeId, job.recordingId), 'jobs', `${job.id}.runtime.json`)); } catch (e) { if (isMissing(e)) return null; throw e; } }
  async revision(scope: string, recordingId: string) { try { return await jsonFile<RevisionState>(join(this.recordingDir(scope, recordingId), 'current.json')); } catch (error) { if (isMissing(error)) return null; throw error; } }
  async transcript(scope: string, recordingId: string, revisionId?: string) {
    await this.get(scope, recordingId); let state = await this.revision(scope, recordingId);
    if (!state) throw new LibraryError('TRANSCRIPT_NOT_READY', '转写尚未完成。', 409);
    if (revisionId && revisionId !== state.revisionId) state = await jsonFile<RevisionState>(join(this.recordingDir(scope, recordingId), 'revisions', `${validId(revisionId)}.state.json`));
    const transcript = await jsonFile<AudioTranscript>(join(this.recordingDir(scope, recordingId), 'transcripts', `${validId(revisionId || state.revisionId)}.json`)); assertAudioContract('Transcript', transcript);
    return { transcript, state };
  }
  async installTranscript(scope: string, recordingId: string, transcript: AudioTranscript) {
    return this.serial(async () => {
      const recording = await this.get(scope, recordingId); assertAudioContract('Transcript', transcript);
      if (transcript.recordingId !== recordingId || transcript.sourceSha256 !== recording.sourceSha256) throw new LibraryError('WORKER_SOURCE_MISMATCH', '转写来源校验失败，原文件已保留。', 500);
      const directory = this.recordingDir(scope, recordingId);
      await atomicJson(join(directory, 'transcripts', `${transcript.revisionId}.json`), transcript);
      // Reusing an already installed machine version never overwrites a human revision.
      const previous = await this.revision(scope, recordingId);
      if (!previous || previous.machineRevisionId !== transcript.revisionId) {
        const state = { revisionId: transcript.revisionId, machineRevisionId: transcript.revisionId, reviewedIds: [], createdAtMs: Date.now() } satisfies RevisionState;
        await atomicJson(join(directory, 'revisions', `${transcript.revisionId}.state.json`), state);
        await atomicJson(join(directory, 'current.json'), state);
      }
      if (recording.durationMs !== transcript.durationMs) await atomicJson(join(directory, 'recording.json'), { ...recording, durationMs: transcript.durationMs });
      await this.refreshReadableTranscript(scope, recordingId);
    });
  }
  async refreshReadableTranscript(scope: string, recordingId: string) {
    const recording = await this.get(scope, recordingId), { transcript, state } = await this.transcript(scope, recordingId);
    await writeReadableTranscript(this.recordingDir(scope, recordingId), recording.title, transcript, state.reviewedIds);
  }
  async renameRecording(scope: string, recordingId: string, title: unknown) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 180 || /[\u0000-\u001f]/.test(title)) throw new LibraryError('TITLE_INVALID', '请输入 1–180 个字符的录音标题。');
    return this.serial(async () => {
      const recording = await this.get(scope, recordingId); recording.title = title.trim();
      await atomicJson(join(this.recordingDir(scope, recordingId), 'recording.json'), recording);
      if (await this.revision(scope, recordingId)) await this.refreshReadableTranscript(scope, recordingId);
      return this.row(recording);
    });
  }
  async row(recording: LibraryRecording): Promise<RecordingRow> {
    const job = (await this.jobs(recording.scopeId, recording.id))[0] || null;
    const config = job ? await jsonFile<{ language: 'zh' | 'en' }>(join(this.recordingDir(recording.scopeId, recording.id), 'jobs', `${job.id}.config.json`)) : await jsonFile<{ language: 'zh' | 'en' }>(join(this.recordingDir(recording.scopeId, recording.id), 'settings.json')).catch(() => null);
    return { recording, job, runtime: job ? await this.runtime(job) : null, revision: await this.revision(recording.scopeId, recording.id), language: config?.language || 'zh', storagePath: this.recordingDir(recording.scopeId, recording.id) };
  }
}
