import type { AudioTranscript, TranscriptRevision } from '../../src/library/types.ts';
import { assertAudioContract } from '../transcription/contracts.ts';
import { atomicJson, id, LibraryError } from './common.ts';
import { LibraryStore } from './store.ts';
import { join } from 'node:path';
import { writeReadableTranscript } from './transcript-export.ts';

export async function saveRevision(store: LibraryStore, scope: string, recordingId: string, baseRevisionId: string, changes: TranscriptRevision['changes']) {
  return store.serial(async () => {
    const { transcript: previous, state } = await store.transcript(scope, recordingId);
    if (state.revisionId !== baseRevisionId) throw new LibraryError('REVISION_CONFLICT', '这份稿件已在其他页面更新。请刷新后核对修改，当前修改尚未覆盖。', 409);
    if (!Array.isArray(changes) || !changes.length || changes.length > 500) throw new LibraryError('CHANGES_INVALID', '请提交 1–500 项有效修改。');
    const revision: TranscriptRevision = { schemaVersion: 1, id: id('rev'), recordingId, baseRevisionId, createdAtMs: Date.now(), changes };
    try { assertAudioContract('Revision', revision); } catch { throw new LibraryError('CHANGES_INVALID', '校对内容格式不正确。'); }
    const transcript: AudioTranscript = structuredClone(previous), reviewed = new Set(state.reviewedIds);
    const segments = new Map(transcript.segments.map(s => [s.id, s]));
    for (const change of changes) {
      if (change.kind === 'speaker_name') {
        const speaker = transcript.speakers.find(s => s.id === change.speakerId);
        if (!speaker || !change.displayName.trim()) throw new LibraryError('SPEAKER_INVALID', '此讲话人不存在或名称为空。');
        speaker.displayName = change.displayName.trim(); speaker.nameSource = 'user';
        for (const segment of transcript.segments) if (segment.speakerId === speaker.id) reviewed.delete(segment.id);
        continue;
      }
      const segment = segments.get(change.segmentId);
      if (!segment) throw new LibraryError('SEGMENT_INVALID', '此段落不存在。');
      if (change.kind === 'segment_reviewed') { if (change.reviewed) reviewed.add(segment.id); else reviewed.delete(segment.id); continue; }
      reviewed.delete(segment.id);
      if (!segment.flags.includes('user_edited')) segment.flags.push('user_edited');
      if (change.kind === 'segment_text') {
        if (!change.text.trim()) throw new LibraryError('TEXT_EMPTY', '段落文字不能为空。');
        segment.text = change.text; segment.words = []; segment.timingSource = 'user_pending';
        if (!segment.flags.includes('pending_alignment')) segment.flags.push('pending_alignment');
      } else if (change.kind === 'segment_speaker') {
        if (change.speakerId !== null && !transcript.speakers.some(s => s.id === change.speakerId)) throw new LibraryError('SPEAKER_INVALID', '此讲话人不存在。');
        segment.speakerId = change.speakerId;
        segment.flags = segment.flags.filter(f => f !== 'speaker_uncertain');
        if (change.speakerId === null) segment.flags.push('speaker_uncertain');
      } else if (change.kind === 'segment_time') {
        if (change.startMs >= change.endMs || change.endMs > transcript.durationMs) throw new LibraryError('TIME_INVALID', '结束时间应晚于开始时间且不超过录音时长。');
        segment.startMs = change.startMs; segment.endMs = change.endMs; segment.words = []; segment.timingSource = 'user_pending';
        segment.sourceChunkIds = transcript.chunks.filter(c => c.startMs <= change.endMs && c.endMs >= change.startMs).map(c => c.id);
        if (!segment.flags.includes('pending_alignment')) segment.flags.push('pending_alignment');
      }
    }
    transcript.revisionId = revision.id;
    // Source ranges may overlap; preserve a stable original order for equal starts.
    transcript.segments.sort((a, b) => a.startMs - b.startMs);
    try { assertAudioContract('Transcript', transcript); } catch { throw new LibraryError('REVISION_INVALID', '修改后的来源时间或引用不完整，请检查段落范围。'); }
    const directory = store.recordingDir(scope, recordingId);
    await atomicJson(join(directory, 'transcripts', `${revision.id}.json`), transcript);
    await atomicJson(join(directory, 'revisions', `${revision.id}.json`), revision);
    const next = { ...state, revisionId: revision.id, reviewedIds: [...reviewed], createdAtMs: revision.createdAtMs };
    await atomicJson(join(directory, 'revisions', `${revision.id}.state.json`), next);
    await writeReadableTranscript(directory, (await store.get(scope, recordingId)).title, transcript, next.reviewedIds);
    await atomicJson(join(directory, 'current.json'), next);
    return next;
  });
}

export { exportTranscript, timeLabel } from './transcript-export.ts';
