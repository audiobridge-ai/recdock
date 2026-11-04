export const issueLabels = {
  many_zero_or_invalid_word_times: '词时间缺失较多', word_time_outside_source: '词时间越界',
  nonmonotonic_word_times: '词时间顺序异常', no_positive_word_interval: '仅有源片段时间',
  speaker_uncertain: '讲话人待确认', multiple_speakers_in_paragraph: '可能包含换人',
  overlapping_speech: '可能有重叠讲话', ALIGNMENT_TEXT_MAPPING_MISMATCH: '文字与对齐未匹配',
  ALIGNMENT_TEXT_CHANGED: '文字与对齐版本不一致',
  long_internal_gap: '段内时间间隔较大', unusually_long_word_span: '词跨度异常偏长'
};
export function timeLabel(ms, precise = false) {
  const value = Math.max(0, Math.round(ms)), seconds = Math.floor(value / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(v => String(v).padStart(2, '0')).join(':') + (precise ? '.' + String(value % 1000).padStart(3, '0') : '');
}
export function parseTime(value) {
  if (!/^\d{1,3}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)) return NaN;
  const [h, m, s] = value.split(':').map(Number);
  return m < 60 && s < 60 ? Math.round((h * 3600 + m * 60 + s) * 1000) : NaN;
}
export function emptyDraft(recording) {
  return {schemaVersion: 1, artifactType: 'recdock_review_draft', recordingId: recording.id,
    sourceSha256: recording.sourceSha256, fingerprint: recording.fingerprint, speakers: {}, edits: {}};
}
export function validateDraft(recording, value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || value.artifactType !== 'recdock_review_draft' || value.recordingId !== recording.id || value.sourceSha256 !== recording.sourceSha256 || value.fingerprint !== recording.fingerprint) throw Error('这份备份与当前录音或转写版本不匹配。');
  const plain = x => x && typeof x === 'object' && !Array.isArray(x);
  if (!plain(value.speakers) || !plain(value.edits)) throw Error('备份格式不正确。');
  const speakerIds = new Set(recording.speakers.map(s => s.id));
  const ids = new Set(recording.paragraphs.map(p => p.id));
  const clean = emptyDraft(recording);
  for (const [key, name] of Object.entries(value.speakers)) {
    if (!speakerIds.has(key) || typeof name !== 'string' || !name.trim() || name.length > 100) throw Error('备份中的讲话人名称无效。');
    clean.speakers[key] = name;
  }
  for (const [key, edit] of Object.entries(value.edits)) {
    if (!ids.has(key) || !plain(edit) || Object.keys(edit).some(k => !['text', 'speakerId', 'startMs', 'endMs', 'reviewed'].includes(k)) || typeof edit.text !== 'string' || edit.text.length > 100000 || ![edit.startMs, edit.endMs].every(Number.isInteger) || edit.startMs < 0 || edit.startMs >= edit.endMs || edit.endMs > recording.durationMs || !(edit.speakerId === null || speakerIds.has(edit.speakerId)) || typeof edit.reviewed !== 'boolean') throw Error('备份包含无效段落、讲话人或时间范围。');
    clean.edits[key] = {text: edit.text, speakerId: edit.speakerId, startMs: edit.startMs, endMs: edit.endMs, reviewed: edit.reviewed};
  }
  return clean;
}
export function effectiveParagraph(paragraph, draft) {
  return {...paragraph, ...(draft.edits[paragraph.id] || {})};
}
export function speakerName(recording, draft, id) {
  return id === null ? '讲话人待确认' : (draft.speakers[id] || recording.speakers.find(s => s.id === id)?.name || id);
}
export function reviewedCount(recording, draft) {
  return recording.paragraphs.filter(p => effectiveParagraph(p, draft).reviewed).length;
}
export function exportText(recording, draft, markdown = true) {
  const safe = value => markdown ? value.replace(/[\\`*_{}\[\]<>#|]/g, '\\$&') : value;
  const count = reviewedCount(recording, draft);
  const header = [markdown ? '# ' + safe(recording.title) : recording.title,
    '来源 SHA-256：' + recording.sourceSha256,
    '时长：' + timeLabel(recording.durationMs),
    `核对状态：${count}/${recording.paragraphs.length} 段已由使用者标记核对。`,
    '自动转写候选稿；讲话人编号仅在本录音内有效。时间为模型估计；仅有源片段时间的段落会单独标注。未经核对的文字、归属和定位可能有误。',
    '回答时请引用录音标题、讲话人与时间范围；原文未提供的信息请说明无法确定。'];
  const paragraphs = recording.paragraphs.map(original => {
    const p = effectiveParagraph(original, draft);
    const flags = p.reviewed ? '已人工核对' : ['待核对', ...(p.timing === 'source_chunk_only' ? ['仅有源片段时间'] : []), ...p.issues.map(x => issueLabels[x] || x)].join('；');
    return `${markdown ? '### ' : ''}[${timeLabel(p.startMs, true)}–${timeLabel(p.endMs, true)}] ${safe(speakerName(recording, draft, p.speakerId))}\n${flags}\n\n${safe(p.text.trim())}`;
  });
  return header.join('\n\n') + '\n\n' + paragraphs.join('\n\n') + '\n';
}
export function activeParagraph(recording, draft, ms) {
  // Linear selection tolerates overlapping/model-regressing intervals and manual edits.
  let match = null;
  for (const original of recording.paragraphs) {
    const p = effectiveParagraph(original, draft);
    if (p.startMs <= ms && ms < p.endMs && (!match || p.startMs >= match.startMs)) match = p;
  }
  return match?.id || null;
}
