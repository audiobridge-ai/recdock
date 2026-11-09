import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore The offline review bundle uses the same dependency-free ES module.
import { emptyDraft, validateDraft, effectiveParagraph, exportText, parseTime, activeParagraph } from '../worker/recdock_audio/review_assets/review-core.mjs';

const recording = {
  id: 'test', title: '候选录音', sourceSha256: 'source', fingerprint: 'v1', durationMs: 10000,
  speakers: [{ id: 'a', name: '讲话人 1' }],
  paragraphs: [
    { id: 'p1', text: '第一段。', startMs: 1000, endMs: 2000, speakerId: 'a', reviewed: false, issues: [], timing: 'model_estimate' },
    { id: 'p2', text: '最后一段。', startMs: 5000, endMs: 6000, speakerId: null, reviewed: false, issues: ['speaker_uncertain'], timing: 'model_estimate' },
  ],
};
test('review backups are bound to the recording and exact derived paragraph version', () => {
  const draft = emptyDraft(recording);
  assert.throws(() => validateDraft({ ...recording, sourceSha256: 'different' }, draft));
  assert.throws(() => validateDraft({ ...recording, fingerprint: 'new-merge' }, draft));
  assert.deepEqual(validateDraft(recording, draft), draft);
});
test('invalid edited times, speakers and unknown paragraph IDs cannot be restored', () => {
  const edit = { text: '校对', startMs: 1000, endMs: 2000, speakerId: 'a', reviewed: true };
  for (const change of [{ endMs: 20000 }, { endMs: 1000 }, { speakerId: 'missing' }, { startMs: NaN }]) {
    assert.throws(() => validateDraft(recording, { ...emptyDraft(recording), edits: { p1: { ...edit, ...change } } }));
  }
  assert.throws(() => validateDraft(recording, { ...emptyDraft(recording), edits: { unknown: edit } }));
});
test('exports retain full recording and explicitly distinguish manual review from candidates', () => {
  const draft = emptyDraft(recording);
  draft.speakers.a = '主持人';
  draft.edits.p1 = { text: '已修正的第一段。', speakerId: 'a', startMs: 1100, endMs: 2200, reviewed: true };
  const text = exportText(recording, draft, false);
  assert.match(text, /1\/2 段/);
  assert.match(text, /00:00:01\.100–00:00:02\.200/);
  assert.match(text, /主持人/);
  assert.match(text, /已人工核对/);
  assert.match(text, /最后一段/);
  assert.match(text, /讲话人待确认/);
  assert.equal(recording.paragraphs[0].text, '第一段。');
});
test('Markdown transcript content cannot inject raw HTML or headings', () => {
  const draft = emptyDraft(recording);
  draft.edits.p1 = { text: '<script>bad</script>\n# heading', speakerId: 'a', startMs: 1000, endMs: 2000, reviewed: false };
  const text = exportText(recording, draft);
  assert.ok(!text.includes('<script>'));
  assert.ok(text.includes('\\# heading'));
});
test('time parsing and playback lookup support hours and manual changes', () => {
  assert.equal(parseTime('01:20:30.125'), 4830125);
  assert.ok(Number.isNaN(parseTime('00:75:00')));
  const draft = emptyDraft(recording);
  draft.edits.p1 = { ...effectiveParagraph(recording.paragraphs[0], draft), startMs: 3000, endMs: 4000 };
  assert.equal(activeParagraph(recording, draft, 3500), 'p1');
  assert.equal(activeParagraph(recording, draft, 1500), null);
});
