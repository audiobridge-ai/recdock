import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import type { AudioContractMap, AudioTranscript } from '../../src/library/types.ts';

const schema: Record<string, unknown> = JSON.parse(readFileSync(new URL('../../contracts/audio-v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

export class AudioContractError extends Error {
  readonly code = 'AUDIO_CONTRACT_INVALID';
}

function fail(message: string): never { throw new AudioContractError(message); }

function unique(ids: string[], kind: string) {
  if (new Set(ids).size !== ids.length) fail(`${kind}: duplicate id`);
}

function checkTranscript(t: AudioTranscript) {
  const speakers = new Set(t.speakers.map(s => s.id));
  const chunks = new Map(t.chunks.map(c => [c.id, c]));
  unique(t.speakers.map(s => s.id), 'speakers');
  unique(t.chunks.map(c => c.id), 'chunks');
  unique(t.segments.map(s => s.id), 'segments');
  unique(t.speakerTurns.map(s => s.id), 'speakerTurns');
  const span = (s: { startMs: number; endMs: number }, kind: string) => {
    if (s.startMs >= s.endMs || s.endMs > t.durationMs) fail(`${kind}: invalid source time range`);
  };
  for (const chunk of t.chunks) {
    span(chunk, 'chunk');
    if (chunk.paddingLeftMs > chunk.startMs || chunk.endMs + chunk.paddingRightMs > t.durationMs) fail('chunk: padding exceeds source');
    if ((chunk.status === 'failed') !== (chunk.errorCode !== null)) fail('chunk: inconsistent error');
  }
  let previous = -1;
  for (const s of t.segments) {
    span(s, 'segment');
    if (s.startMs < previous) fail('segments: not ordered by start time');
    previous = s.startMs;
    if (s.speakerId !== null && !speakers.has(s.speakerId)) fail('segment: unknown speaker');
    const sources = s.sourceChunkIds.map(id => chunks.get(id));
    if (sources.some(c => !c)) fail('segment: unknown source chunk');
    const ranges = sources.map(c => ({ start: c!.startMs - c!.paddingLeftMs, end: c!.endMs + c!.paddingRightMs })).sort((a, b) => a.start - b.start);
    let covered = s.startMs;
    for (const range of ranges) { if (range.start <= covered) covered = Math.max(covered, range.end); }
    if (covered < s.endMs) fail('segment: outside referenced chunks');
    let wordStart = -1;
    for (const word of s.words) {
      if ((word.startMs === null) !== (word.endMs === null)) fail('word: incomplete timing');
      if (word.timingSource === 'unavailable') {
        if (word.startMs !== null) fail('word: unavailable timing must be null');
      } else if (word.startMs === null) fail('word: missing timing');
      if (word.startMs !== null && word.endMs !== null) {
        if (word.startMs < s.startMs || word.endMs > s.endMs || word.startMs >= word.endMs || word.startMs < wordStart) fail('word: invalid source time range');
        wordStart = word.startMs;
      }
    }
    if (s.timingSource === 'user_pending' && s.words.some(w => w.startMs !== null)) fail('segment: pending edit retains stale word times');
  }
  for (const turn of t.speakerTurns) { span(turn, 'speakerTurn'); if (!speakers.has(turn.speakerId)) fail('speakerTurn: unknown speaker'); }
}

export function assertAudioContract<K extends keyof AudioContractMap>(kind: K, value: unknown): asserts value is AudioContractMap[K] {
  let validator = validators.get(kind);
  if (!validator) {
    validator = ajv.compile({ $ref: `https://recdock.local/contracts/audio-v1#/$defs/${kind}` });
    validators.set(kind, validator);
  }
  if (!validator(value)) fail(ajv.errorsText(validator.errors, { dataVar: kind }));
  if (kind === 'Transcript') checkTranscript(value as AudioTranscript);
  if (kind === 'WorkerEvent') {
    const event = value as AudioContractMap['WorkerEvent'];
    if (event.event === 'progress' && event.payload.totalUnits !== null && event.payload.completedUnits > event.payload.totalUnits) fail('progress: exceeds total');
  }
  if (kind === 'WorkerCommand') {
    const command = value as AudioContractMap['WorkerCommand'];
    if (command.command === 'run' && command.payload.minSpeakers !== null && command.payload.maxSpeakers !== null && command.payload.minSpeakers > command.payload.maxSpeakers) fail('speakers: invalid limits');
  }
  if (kind === 'Job') {
    const job = value as AudioContractMap['Job'];
    if ((job.state === 'running') !== (job.stage !== null)) fail('job: state and stage disagree');
    if ((job.state === 'failed') !== (job.error !== null)) fail('job: state and error disagree');
    if (job.updatedAtMs < job.createdAtMs) fail('job: timestamps reversed');
  }
}
