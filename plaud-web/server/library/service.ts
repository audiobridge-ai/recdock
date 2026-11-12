import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AudioJob, AudioTranscript, JobState, PipelineStage, WorkerEvent } from '../../src/library/types.ts';
import { assertAudioContract } from '../transcription/contracts.ts';
import { acquireLock, atomicJson, digest, exists, fileSha256, id, jsonFile, LibraryError, scopeFor, secureDirectory } from './common.ts';
import { LibraryStore } from './store.ts';
import type { JobRuntime } from './store.ts';
import { migrateLegacyLibrary } from './migration.ts';

const stages: PipelineStage[] = ['preparing', 'transcribing', 'aligning', 'diarizing', 'merging'];
const artifactNames = { preparing: 'prepare.json', transcribing: 'asr.json', aligning: 'align.json', diarizing: 'diarize.json', merging: 'transcript.json' };
export interface LibraryOptions { root?: string; workspace?: string; python?: string; models?: string; device?: 'cpu' | 'mps'; workerModule?: string }
interface Active { job: AudioJob; child?: ChildProcessWithoutNullStreams; stopped?: JobState; done: Promise<void>; stopTimer?: ReturnType<typeof setTimeout> }

export class LibraryService {
  readonly store: LibraryStore;
  readonly workspace: string;
  readonly python: string;
  readonly models: string;
  readonly device: 'cpu' | 'mps';
  readonly ready: Promise<void>;
  private workerModule: string;
  private jobs = new Map<string, AudioJob>();
  private languages = new Map<string, 'zh' | 'en'>();
  private scopesAllowed = new Set([scopeFor()]);
  private active?: Active;
  private pumping = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private releaseLock?: () => Promise<void>;
  private migrateLegacy: boolean;
  constructor(options: LibraryOptions = {}) {
    this.workspace = resolve(options.workspace || process.cwd());
    this.migrateLegacy = !options.root && !process.env.RECDOCK_LIBRARY_DIR;
    this.store = new LibraryStore(options.root || process.env.RECDOCK_LIBRARY_DIR || join(this.workspace, '.local-audio', 'library'));
    this.python = options.python || process.env.RECDOCK_AUDIO_PYTHON || join(this.workspace, 'worker', '.venv', 'bin', 'python');
    this.models = options.models || process.env.RECDOCK_AUDIO_MODELS || join(this.workspace, '.local-audio', 'models');
    this.device = options.device || (process.platform === 'darwin' && process.arch === 'arm64' ? 'mps' : 'cpu');
    this.workerModule = options.workerModule || 'recdock_audio.runtime';
    this.ready = this.initialize().catch(async error => { await this.releaseLock?.(); this.releaseLock = undefined; throw error; });
    // Surface initialization failures to API callers, without an unhandled rejection.
    void this.ready.catch(() => {});
  }
  private async initialize() {
    await this.store.init(); this.releaseLock = await acquireLock(this.store.root);
    if (this.migrateLegacy) await migrateLegacyLibrary(this.store.root, join(homedir(), 'Library', 'Application Support', 'PLAUD BLE Workspace', 'library-v1'));
    for (const scope of await this.store.scopes()) {
      // Uploads are not resumable; partially uploaded bytes never appear in recordings.
      await rm(join(this.store.scope(scope), 'imports'), { recursive: true, force: true });
      for (const recording of await this.store.records(scope)) {
        if (await this.store.revision(scope, recording.id)) await this.store.refreshReadableTranscript(scope, recording.id);
        for (const job of await this.store.jobs(scope, recording.id)) {
          const configPath = join(this.store.recordingDir(scope, recording.id), 'jobs', `${job.id}.config.json`);
          const config = await jsonFile<{ language: 'zh' | 'en' }>(configPath);
          this.languages.set(job.id, config.language);
          if (job.state === 'running' || job.state === 'queued' || job.state === 'interrupted') {
            const interrupted = job.state !== 'queued';
            job.state = scope === scopeFor() ? 'queued' : 'paused'; job.stage = null; job.error = null; job.updatedAtMs = Date.now();
            const prior = await this.store.runtime(job);
            await this.store.saveJob(job, { progress: null, attempt: prior?.attempt || 0, resumed: interrupted || prior?.resumed || false });
          }
          this.jobs.set(job.id, job);
        }
      }
    }
    queueMicrotask(() => this.kick());
  }
  async environment() {
    await this.ready;
    const missing = [];
    if (!await exists(this.python)) missing.push('Python 处理环境');
    const modelRevisions: Record<string, { repo: string; revision: string }> = {};
    try {
      const lock = await jsonFile<{ models: Record<string, { repo: string; revision: string; files: { path: string }[] }> }>(join(this.models, 'models.lock.json'));
      for (const name of ['asr', 'aligner', 'diarizer']) {
        const model = lock.models[name];
        if (!model?.revision || !await exists(join(this.models, name))) missing.push(name === 'asr' ? '转写模型' : name === 'aligner' ? '时间对齐模型' : '讲话人模型');
        else modelRevisions[name] = { repo: model.repo, revision: model.revision };
      }
    } catch { missing.push('模型准备与校验记录'); }
    return { available: missing.length === 0, missing, languages: ['zh', 'en'], maxBytes: 1024 ** 3, maxDurationHours: 6,
      processing: 'offline', quality: 'candidate_requires_review', modelRevisions, activeJobs: this.active ? 1 : 0, storageRoot: this.store.root };
  }
  async pipelineFingerprint(scope: string, recordingId: string, language: 'zh' | 'en') {
    const { recording, asset } = await this.store.asset(scope, recordingId);
    let lock;
    try { lock = await jsonFile<Record<string, unknown>>(join(this.models, 'models.lock.json')); }
    catch { throw new LibraryError('MODELS_NOT_READY', '模型尚未准备完成，请先检查本机处理环境。', 503); }
    const code = [];
    for (const file of ['runtime.py', 'paragraphs.py', 'benchmark.py', 'retry_asr.py', 'resume.py', 'contracts.py']) code.push(await fileSha256(join(this.workspace, 'worker', 'recdock_audio', file)));
    return digest({ version: 'library-pipeline-v1', source: recording.sourceSha256, playable: asset.sha256, language, device: this.device, models: lock, code });
  }
  async enqueue(scope: string, recordingId: string, language: 'zh' | 'en') {
    await this.ready;
    if (this.closing) throw new LibraryError('SERVICE_STOPPING', '工作台服务正在重启，请稍后重试。', 503);
    const recording = await this.store.get(scope, recordingId);
    if (recording.state !== 'stored') throw new LibraryError('RECORDING_NOT_PLAYABLE', '原件已保存；文件尚未恢复为可解码音频，不能开始转写。', 409);
    const fingerprint = await this.pipelineFingerprint(scope, recordingId, language);
    return this.store.serial(async () => {
      const prior = [...this.jobs.values()].find(j => j.scopeId === scope && j.recordingId === recordingId && (['queued', 'running'].includes(j.state) || (j.state === 'succeeded' && j.pipelineFingerprint === fingerprint)));
      if (prior) return prior;
      const now = Date.now();
      const job: AudioJob = { schemaVersion: 1, id: id('job'), recordingId, scopeId: scope, pipelineFingerprint: fingerprint,
        state: this.scopesAllowed.has(scope) ? 'queued' : 'paused', stage: null, createdAtMs: now, updatedAtMs: now, completedStages: [], error: null };
      this.jobs.set(job.id, job); this.languages.set(job.id, language);
      await atomicJson(join(this.store.recordingDir(scope, recordingId), 'jobs', `${job.id}.config.json`), { language });
      await this.store.saveJob(job, { progress: null, attempt: 0, resumed: (await this.store.jobs(scope, recordingId)).length > 0 });
      queueMicrotask(() => this.kick());
      return job;
    });
  }
  async grantAccount(account: string) {
    await this.ready; const scope = scopeFor(account); if (this.scopesAllowed.has(scope)) return; this.scopesAllowed.add(scope);
    for (const job of this.jobs.values()) if (job.scopeId === scope && job.state === 'paused') { job.state = 'queued'; job.updatedAtMs = Date.now(); await this.store.saveJob(job); }
    this.kick();
  }
  async revokeAccount(account: string) {
    await this.ready; const scope = scopeFor(account); this.scopesAllowed.delete(scope);
    for (const job of this.jobs.values()) if (job.scopeId === scope && job.state === 'queued') { job.state = 'paused'; job.updatedAtMs = Date.now(); await this.store.saveJob(job); }
    if (this.active?.job.scopeId === scope) await this.stopActive('paused', 'logout');
  }
  async job(scope: string, jobId: string) {
    await this.ready; const job = this.jobs.get(jobId);
    if (!job || job.scopeId !== scope) throw new LibraryError('JOB_NOT_FOUND', '未找到此处理任务。', 404);
    return { job, runtime: await this.store.runtime(job) };
  }
  private killGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
  }
  private async stopActive(state: JobState, reason: 'user' | 'logout' | 'shutdown') {
    const active = this.active; if (!active) return;
    active.stopped ??= state;
    if (active.child) {
      const command = { protocolVersion: 1, jobId: active.job.id, command: 'cancel', payload: { reason } };
      active.child.stdin.write(JSON.stringify(command) + '\n', () => {});
      this.killGroup(active.child, 'SIGTERM');
      active.stopTimer = setTimeout(() => this.killGroup(active.child!, 'SIGKILL'), 5000);
    }
    await active.done;
  }
  async cancel(scope: string, jobId: string) {
    const { job } = await this.job(scope, jobId);
    if (this.active?.job.id === jobId) await this.stopActive('cancelled', 'user');
    else if (['queued', 'paused', 'interrupted'].includes(job.state)) { job.state = 'cancelled'; job.stage = null; job.updatedAtMs = Date.now(); await this.store.saveJob(job); }
    return job;
  }
  private kick() { if (!this.pumping && !this.closing) { this.pumping = true; void this.pump().finally(() => { this.pumping = false; if ([...this.jobs.values()].some(j => j.state === 'queued' && this.scopesAllowed.has(j.scopeId))) this.kick(); }); } }
  private async pump() {
    while (!this.closing) {
      const next = [...this.jobs.values()].filter(j => j.state === 'queued' && this.scopesAllowed.has(j.scopeId)).sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
      if (!next) return;
      let finish!: () => void;
      const active: Active = { job: next, done: new Promise<void>(resolvePromise => { finish = resolvePromise; }) };
      this.active = active;
      try { await this.run(active); }
      catch {
        next.state = active.stopped || 'failed'; next.stage = null; next.updatedAtMs = Date.now();
        next.error = next.state === 'failed' ? { code: 'AUDIO_PROCESSING_FAILED', retryable: true, message: '本机处理未完成，原音频和已完成阶段已保留，可重试。' } : null;
        await this.store.saveJob(next).catch(() => {});
      } finally { clearTimeout(active.stopTimer); this.active = undefined; finish(); }
    }
  }
  private async run(active: Active) {
    const job = active.job, directory = this.store.recordingDir(job.scopeId, job.recordingId), work = join(directory, 'work', job.pipelineFingerprint);
    const language = this.languages.get(job.id) || 'zh';
    const prior = await this.store.runtime(job), runtime: JobRuntime = { progress: null, attempt: (prior?.attempt || 0) + 1, resumed: prior?.resumed || false };
    if (await this.pipelineFingerprint(job.scopeId, job.recordingId, language) !== job.pipelineFingerprint) {
      job.state = 'failed'; job.stage = null; job.error = { code: 'PIPELINE_CHANGED', retryable: true, message: '模型或处理程序已变化，请重试以使用新的处理版本。' }; job.updatedAtMs = Date.now(); await this.store.saveJob(job); return;
    }
    job.state = 'running'; job.stage = 'preparing'; job.error = null; job.updatedAtMs = Date.now(); await this.store.saveJob(job, runtime);
    if (active.stopped) { job.state = active.stopped; job.stage = null; await this.store.saveJob(job, runtime); return; }
    await secureDirectory(work);
    const { asset } = await this.store.asset(job.scopeId, job.recordingId);
    const child = spawn(this.python, ['-m', this.workerModule, '--recording-dir', directory, '--models', this.models, '--device', this.device, '--parent-pid', String(process.pid)], {
      cwd: this.workspace, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONPATH: join(this.workspace, 'worker'), HF_HOME: process.env.HF_HOME || join(this.workspace, '.local-audio', 'huggingface'), MPLCONFIGDIR: process.env.MPLCONFIGDIR || join(this.workspace, '.local-audio', 'matplotlib'), HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', PYANNOTE_METRICS_ENABLED: '0' },
    });
    active.child = child;
    child.stdin.on('error', () => {}); child.stderr.resume();
    const command = { protocolVersion: 1, jobId: job.id, command: 'run', payload: { recordingId: job.recordingId, sourceAssetId: asset.id, pipelineFingerprint: job.pipelineFingerprint, language, minSpeakers: null, maxSpeakers: null } };
    assertAudioContract('WorkerCommand', command); child.stdin.write(JSON.stringify(command) + '\n');
    let sequence = 0, stageIndex = -1, lastEvent = Date.now(), terminal: WorkerEvent | undefined, protocolError = false;
    let chain = Promise.resolve(), buffer = ''; const decoder = new StringDecoder('utf8');
    const handle = async (event: WorkerEvent) => {
      if (active.stopped) return;
      assertAudioContract('WorkerEvent', event);
      if (event.sequence !== sequence + 1 || (event.event === 'ready' ? sequence !== 0 : event.jobId !== job.id) || (sequence === 0 && event.event !== 'ready') || (terminal && event.event !== 'heartbeat')) throw new Error('WORKER_PROTOCOL');
      sequence = event.sequence; lastEvent = Date.now();
      if (event.event === 'stage_started') {
        stageIndex++;
        if (stages[stageIndex] !== event.stage || event.payload.inputFingerprint !== job.pipelineFingerprint) throw new Error('WORKER_STAGE');
        job.stage = event.stage; runtime.progress = null; job.updatedAtMs = Date.now(); await this.store.saveJob(job, runtime);
      } else if (event.event === 'progress') {
        if (event.stage !== job.stage) throw new Error('WORKER_STAGE');
        runtime.progress = event.payload; job.updatedAtMs = Date.now(); await this.store.saveJob(job, runtime);
      } else if (event.event === 'artifact') {
        if (event.stage !== job.stage || !(event.stage in artifactNames) || artifactNames[event.stage as keyof typeof artifactNames] !== event.payload.relativePath) throw new Error('WORKER_ARTIFACT_PATH');
        const path = resolve(work, event.payload.relativePath);
        if (!path.startsWith(work + '/') || await fileSha256(path) !== event.payload.sha256) throw new Error('WORKER_ARTIFACT_HASH');
        if (!job.completedStages.includes(event.stage)) job.completedStages.push(event.stage);
        job.updatedAtMs = Date.now(); await this.store.saveJob(job, runtime);
      } else if (event.event === 'completed' || event.event === 'failed' || event.event === 'cancelled') terminal = event;
    };
    child.stdout.on('data', bytes => {
      buffer += decoder.write(bytes);
      if (buffer.length > 1024 * 1024) { protocolError = true; this.killGroup(child, 'SIGKILL'); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        chain = chain.then(() => handle(JSON.parse(line) as WorkerEvent)).catch(() => { protocolError = true; this.killGroup(child, 'SIGKILL'); });
      }
    });
    const watchdog = setInterval(() => { if (Date.now() - lastEvent > 90000) { protocolError = true; this.killGroup(child, 'SIGKILL'); } }, 10000);
    const wall = setTimeout(() => { protocolError = true; this.killGroup(child, 'SIGKILL'); }, 4 * 60 * 60 * 1000);
    let code: number | null;
    try { code = await new Promise<number | null>(resolvePromise => { child.once('error', () => resolvePromise(-1)); child.once('close', resolvePromise); }); await chain; }
    finally { clearInterval(watchdog); clearTimeout(wall); child.stdin.destroy(); }
    job.updatedAtMs = Date.now(); runtime.progress = null;
    if (active.stopped) { job.state = active.stopped; job.error = null; }
    else if (code === 0 && !protocolError && terminal?.event === 'completed' && job.completedStages.length === stages.length && terminal.payload.transcriptRelativePath === 'transcript.json' && await fileSha256(join(work, 'transcript.json')) === terminal.payload.sha256) {
      const transcript = await jsonFile<AudioTranscript>(join(work, 'transcript.json'));
      await this.store.installTranscript(job.scopeId, job.recordingId, transcript); job.state = 'succeeded'; job.error = null;
    } else {
      job.state = 'failed'; job.error = { code: protocolError ? 'WORKER_PROTOCOL_INVALID' : terminal?.event === 'failed' ? terminal.payload.code : 'AUDIO_PROCESSING_FAILED', retryable: true,
        message: '本机处理未完成。请检查模型环境后重试；原音频和已完成阶段已保留。' };
    }
    job.stage = null;
    await this.store.saveJob(job, runtime);
  }
  close() { return this.closePromise ??= this.finishClose(); }
  private async finishClose() { this.closing = true; await this.ready.catch(() => {}); if (this.active) await this.stopActive('interrupted', 'shutdown'); await this.releaseLock?.(); this.releaseLock = undefined; }
}
