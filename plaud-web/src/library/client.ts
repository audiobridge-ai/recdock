import type { AudioJob, AudioTranscript, LibraryRecording, TranscriptRevision } from './types.ts';

export interface LibraryEnvironment { available: boolean; missing: string[]; maxBytes: number; quality: string; storageRoot?: string }
export interface LibraryContext { csrfToken: string; accountAvailable: boolean; identity: string; environment: LibraryEnvironment }
export interface RevisionState { revisionId: string; machineRevisionId: string; reviewedIds: string[] }
export interface RecordingRow { recording: LibraryRecording; job: AudioJob | null; runtime: { progress: { completedUnits: number; totalUnits: number | null; unit: string } | null; resumed: boolean } | null; revision: RevisionState | null; language?: 'zh' | 'en'; storagePath?: string }
export interface TranscriptPage { transcript: Omit<AudioTranscript, 'speakerTurns'>; revision: RevisionState; total: number; totalSegments: number; cursor: number; nextCursor: number | null }
export class LibraryApiError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; }
}
export class LibraryClient {
  scope: 'personal' | 'account' = 'personal';
  private csrf = '';
  private contextRequest?: Promise<LibraryContext>;
  url(path: string, scope = this.scope) { return `/api/library/${path}${path.includes('?') ? '&' : '?'}scope=${scope}`; }
  context() {
    if (!this.contextRequest) {
      const pending = this.request<LibraryContext>('context', undefined, 'GET', 'personal').then(context => { this.csrf = context.csrfToken; return context; }).finally(() => { if (this.contextRequest === pending) this.contextRequest = undefined; });
      this.contextRequest = pending;
    }
    return this.contextRequest;
  }
  async request<T>(path: string, data?: unknown, method = data === undefined ? 'GET' : 'POST', scope = this.scope): Promise<T> {
    const response = await fetch(this.url(path, scope), { method, credentials: 'same-origin', cache: 'no-store', headers: data === undefined && method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = await response.json();
    if (!response.ok) throw new LibraryApiError(value.error?.code || 'LIBRARY_UNAVAILABLE', value.error?.message || '本机录音库暂时不可用，请重试。', response.status);
    return value as T;
  }
  async upload(uploadId: string, role: 'original' | 'playable', file: Blob, scope: 'personal' | 'account', progress: (loaded: number, total: number) => void) {
    await new Promise<void>((resolvePromise, reject) => {
      const request = new XMLHttpRequest();
      request.open('PUT', this.url(`imports/${uploadId}/content?role=${role}`, scope)); request.setRequestHeader('X-CSRF-Token', this.csrf); request.setRequestHeader('Content-Type', 'application/octet-stream');
      request.upload.onprogress = e => progress(e.loaded, e.lengthComputable ? e.total : file.size);
      request.onload = () => { if (request.status >= 200 && request.status < 300) resolvePromise(); else { let message = '文件上传未完成，请重新导入。'; try { message = JSON.parse(request.responseText).error?.message || message; } catch {} reject(new Error(message)); } };
      request.onerror = request.onabort = () => reject(new Error('上传中断，未完成的文件不会进入录音库。'));
      request.timeout = 30 * 60 * 1000; request.ontimeout = () => reject(new Error('上传超时，请重新选择文件。')); request.send(file);
    });
  }
  async importFile(input: { filename: string; original: Blob; language: 'zh' | 'en'; transcribe: boolean; source: LibraryRecording['source']; playable?: { filename: string; file: Blob } }, progress: (text: string) => void, scope = this.scope) {
    const upload = await this.request<{ uploadId: string }>('imports', { filename: input.filename, bytes: input.original.size, language: input.language, source: input.source, ...(input.playable ? { playable: { filename: input.playable.filename, bytes: input.playable.file.size } } : {}) }, 'POST', scope);
    await this.upload(upload.uploadId, 'original', input.original, scope, (loaded, total) => progress(`正在保存原音频 · ${Math.min(100, Math.floor(loaded / total * 100))}%`));
    if (input.playable) await this.upload(upload.uploadId, 'playable', input.playable.file, scope, (loaded, total) => progress(`正在保存可播放音频 · ${Math.min(100, Math.floor(loaded / total * 100))}%`));
    progress('正在检查音频完整性并入库…');
    return this.request<{ recording: LibraryRecording; job: AudioJob | null; duplicate: boolean; processingError: { message: string } | null }>(`imports/${upload.uploadId}/commit`, { transcribe: input.transcribe }, 'POST', scope);
  }
  save(recordingId: string, baseRevisionId: string, changes: TranscriptRevision['changes']) { return this.request<{ revision: RevisionState }>(`recordings/${recordingId}/revisions`, { baseRevisionId, changes }); }
}
