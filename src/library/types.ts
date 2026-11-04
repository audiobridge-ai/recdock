/** Wire types for contracts/audio-v1.schema.json. Times are original-audio milliseconds. */
export type PipelineStage = 'preparing' | 'transcribing' | 'aligning' | 'diarizing' | 'merging' | 'exporting';
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'paused';
export interface ModelProvenance { engine: string; model: string; revision: string; quantization: string | null }
export interface ModelScore { engine: string; kind: string; value: number }
export interface AudioAsset {
  id: string; role: 'original' | 'playable'; relativePath: string; sha256: string; bytes: number; mimeType: string;
}
export interface LibraryRecording {
  schemaVersion: 1; id: string; scopeId: string; title: string;
  source: { kind: 'import' | 'ble'; deviceId: string | null; sessionId: number | null };
  sourceSha256: string; durationMs: number | null; createdAtMs: number;
  state: 'stored' | 'needs_recovery' | 'unsupported' | 'deleted'; assets: AudioAsset[];
}
export interface TranscriptSpeaker { id: string; displayName: string; nameSource: 'default' | 'user' }
export interface TranscriptWord {
  text: string; startMs: number | null; endMs: number | null;
  timingSource: 'forced_alignment' | 'segment' | 'unavailable'; scores: ModelScore[] | null;
}
export interface TranscriptSegment {
  id: string; startMs: number; endMs: number; speakerId: string | null; text: string;
  timingSource: 'forced_alignment' | 'asr_segment' | 'user_pending'; overlap: boolean;
  flags: ('speaker_uncertain' | 'unaligned' | 'user_edited' | 'pending_alignment' | 'overlap')[];
  sourceChunkIds: string[]; words: TranscriptWord[]; scores: ModelScore[] | null;
}
export interface TranscriptChunk {
  id: string; startMs: number; endMs: number; paddingLeftMs: number; paddingRightMs: number;
  status: 'ready' | 'failed' | 'skipped'; errorCode: string | null;
}
export interface SpeakerTurn { id: string; startMs: number; endMs: number; speakerId: string; overlap: boolean }
export interface AudioTranscript {
  schemaVersion: 1; recordingId: string; sourceSha256: string; durationMs: number; revisionId: string; language: string;
  provenance: { pipelineVersion: string; asr: ModelProvenance | null; aligner: ModelProvenance | null; diarizer: ModelProvenance | null };
  speakers: TranscriptSpeaker[]; segments: TranscriptSegment[]; speakerTurns: SpeakerTurn[]; chunks: TranscriptChunk[];
}
export interface AudioJob {
  schemaVersion: 1; id: string; recordingId: string; scopeId: string; pipelineFingerprint: string;
  state: JobState; stage: PipelineStage | null; createdAtMs: number; updatedAtMs: number;
  completedStages: PipelineStage[]; error: { code: string; retryable: boolean; message: string } | null;
}
export interface TranscriptRevision {
  schemaVersion: 1; id: string; recordingId: string; baseRevisionId: string; createdAtMs: number;
  changes: ({ kind: 'speaker_name'; speakerId: string; displayName: string } | { kind: 'segment_text'; segmentId: string; text: string }
    | { kind: 'segment_speaker'; segmentId: string; speakerId: string | null }
    | { kind: 'segment_time'; segmentId: string; startMs: number; endMs: number }
    | { kind: 'segment_reviewed'; segmentId: string; reviewed: boolean })[];
}
export interface AudioSync {
  schemaVersion: 1; id: string; recordingId: string; revisionId: string; targetId: string; contentSha256: string;
  state: 'prepared' | 'attached' | 'submitted' | 'verified' | 'failed' | 'user_action_required';
  remoteReference: string | null; updatedAtMs: number;
}
export interface WorkerPayloads {
  ready: { workerVersion: string; capabilities: PipelineStage[] };
  stage_started: { inputFingerprint: string };
  progress: { completedUnits: number; totalUnits: number | null; unit: 'chunks' | 'milliseconds' | 'steps' };
  artifact: { kind: string; relativePath: string; sha256: string };
  completed: { transcriptRelativePath: string; sha256: string };
  failed: { code: string; message: string; retryable: boolean };
  cancelled: { reason: 'user' | 'logout' | 'shutdown' };
  heartbeat: { elapsedMs: number };
}
export type WorkerEvent = {
  [E in keyof WorkerPayloads]: {
    protocolVersion: 1; event: E; sequence: number; payload: WorkerPayloads[E];
    jobId: E extends 'ready' ? null : string;
    stage: E extends 'stage_started' | 'progress' | 'artifact' ? PipelineStage : null;
  }
}[keyof WorkerPayloads];
export type WorkerCommand = {
  protocolVersion: 1; jobId: string; command: 'run';
  payload: { recordingId: string; sourceAssetId: string; pipelineFingerprint: string; language: string | null; minSpeakers: number | null; maxSpeakers: number | null };
} | { protocolVersion: 1; jobId: string; command: 'cancel'; payload: { reason: 'user' | 'logout' | 'shutdown' } };
export interface AudioContractMap {
  Recording: LibraryRecording; Transcript: AudioTranscript; Job: AudioJob; Revision: TranscriptRevision;
  Sync: AudioSync; WorkerEvent: WorkerEvent; WorkerCommand: WorkerCommand;
}
