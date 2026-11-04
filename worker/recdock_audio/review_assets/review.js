'use strict';
const recordings = JSON.parse(document.getElementById('recording-data').textContent);
const $ = id => document.getElementById(id);
const colors = ['#3d8d82', '#6e88bb', '#ad8553', '#9671aa', '#ad7481', '#6d939d', '#849759'];
const pageSize = 60;
let current = recordings[0], draft, filtered = [], page = 0, mode = 'all', activeId = null, playEnd = null;
let editing = null, saving = null;
const node = (tag, className, text) => {const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e;};
const keyFor = r => 'recdock-long-review-v1:' + r.sourceSha256 + ':' + r.fingerprint;
function notice(message, error = false) {$('notice').textContent = message; $('notice').classList.toggle('error', error);}
function persist() {
  try {localStorage.setItem(keyFor(current), JSON.stringify(draft)); $('save-status').textContent = '校对稿已保存到本机浏览器';}
  catch {$('save-status').textContent = '浏览器未能保存，请下载备份'; notice('浏览器存储不可用或空间不足。请使用“备份校对稿”保存修改。', true);}
}
function loadDraft() {
  draft = emptyDraft(current);
  try {const value = localStorage.getItem(keyFor(current)); if (value) draft = validateDraft(current, JSON.parse(value));}
  catch {notice('当前浏览器的旧校对稿无法读取。原始候选结果仍可查看；可通过备份恢复。', true);}
}
function updateCounts() {
  $('paragraph-count').textContent = current.paragraphs.length;
  $('review-count').textContent = reviewedCount(current, draft) + ' / ' + current.paragraphs.length;
  $('uncertain-count').textContent = current.paragraphs.filter(p => effectiveParagraph(p, draft).speakerId === null).length;
  $('target-duration').textContent = (current.reviewTargets.reduce((n, t) => n + t.endMs - t.startMs, 0) / 60000).toFixed(1) + ' 分钟';
}
function setEdit(original, fields, explicitReview = false) {
  const previous = effectiveParagraph(original, draft);
  const changed = {text: previous.text, speakerId: previous.speakerId, startMs: previous.startMs, endMs: previous.endMs, reviewed: false, ...fields};
  if (explicitReview) changed.reviewed = fields.reviewed;
  draft.edits[original.id] = changed;
  updateCounts(); persist();
}
function colorFor(id) {return id === null ? '#9b8c73' : colors[current.speakers.findIndex(s => s.id === id) % colors.length];}
function speakerOptions(select, value, withAll = false) {
  select.replaceChildren();
  if (withAll) {const all = node('option', '', '所有讲话人'); all.value = 'all'; select.append(all);}
  for (const speaker of [...current.speakers, {id: null, name: '讲话人待确认'}]) {
    const option = node('option', '', speakerName(current, draft, speaker.id)); option.value = speaker.id === null ? 'unknown' : speaker.id; select.append(option);
  }
  select.value = value === null ? 'unknown' : value;
}
function renderSpeakers() {
  $('speakers').replaceChildren(); $('speaker-count').textContent = current.speakers.length + ' 个编号';
  for (const speaker of current.speakers) {
    const row = node('div', 'speaker-item'); row.style.setProperty('--speaker-color', colorFor(speaker.id));
    const dot = node('span', 'speaker-dot'), input = node('input'), raw = node('small', '', speaker.id + ' · ' + timeLabel(speaker.speechMs));
    input.value = speakerName(current, draft, speaker.id); input.maxLength = 100; input.setAttribute('aria-label', speaker.name + '的名称');
    input.onchange = () => {
      const name = input.value.trim(); if (!name) {input.value = speakerName(current, draft, speaker.id); return;}
      draft.speakers[speaker.id] = name;
      for (const original of current.paragraphs) {
        const p = effectiveParagraph(original, draft);
        if (p.speakerId === speaker.id && p.reviewed) draft.edits[p.id] = {text:p.text, speakerId:p.speakerId, startMs:p.startMs, endMs:p.endMs, reviewed:false};
      }
      persist(); updateCounts(); const selected = $('speaker-filter').value; speakerOptions($('speaker-filter'), selected, true); refresh();
    };
    const preview = node('button', 'speaker-preview', '试听片段 ' + timeLabel(speaker.previewStartMs));
    preview.onclick = () => {const audio = $('audio'); audio.currentTime = speaker.previewStartMs / 1000; playEnd = speaker.previewEndMs / 1000; audio.play().catch(() => {$('audio-status').textContent = '请点击播放器播放。';});};
    row.append(dot, input, raw, preview); $('speakers').append(row);
  }
}
function refresh(resetPage = false) {
  editing = null;
  const query = $('search').value.trim().toLocaleLowerCase(), speaker = $('speaker-filter').value;
  const targets = new Set(current.reviewTargets.map(t => t.chunkId));
  filtered = current.paragraphs.filter(original => {
    const p = effectiveParagraph(original, draft);
    return (!query || p.text.toLocaleLowerCase().includes(query)) &&
      (speaker === 'all' || p.speakerId === (speaker === 'unknown' ? null : speaker)) &&
      (mode === 'all' || (mode === 'targets' && targets.has(p.source.chunkId)) || (mode === 'issues' && p.issues.length > 0 && !p.reviewed) || (mode === 'unreviewed' && !p.reviewed));
  });
  if (resetPage) page = 0;
  page = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  $('target-note').hidden = mode !== 'targets';
  renderPage();
}
function playParagraph(original) {
  const p = effectiveParagraph(original, draft), audio = $('audio');
  audio.currentTime = Math.max(0, p.startMs / 1000 - .2); playEnd = Math.min(current.durationMs / 1000, p.endMs / 1000 + .25);
  audio.play().catch(() => {$('audio-status').textContent = '播放未启动，请点击播放器播放。';});
}
function openEditor(row, original) {
  if (editing === original.id) return;
  if (editing) {renderPage(); row = [...$('paragraphs').children].find(x => x.dataset.id === original.id);}
  editing = original.id;
  const p = effectiveParagraph(original, draft), box = node('div', 'editor'), textarea = node('textarea');
  textarea.value = p.text; textarea.setAttribute('aria-label', '编辑本段转写文字');
  const controls = node('div', 'editor-controls'), speakerLabel = node('label', '', '讲话人'), speaker = node('select'); speakerOptions(speaker, p.speakerId); speakerLabel.append(speaker);
  const startLabel = node('label', '', '开始时间'), start = node('input'); start.value = timeLabel(p.startMs, true); start.setAttribute('aria-label', '本段开始时间'); startLabel.append(start);
  const endLabel = node('label', '', '结束时间'), end = node('input'); end.value = timeLabel(p.endMs, true); end.setAttribute('aria-label', '本段结束时间'); endLabel.append(end);
  const done = node('button', 'primary', '完成'), reset = node('button', '', '还原本段'), message = node('p', 'message');
  const invalidateCheck = () => {row.querySelector('.review-state input').checked = false;};
  textarea.oninput = () => {setEdit(original, {text:textarea.value}); invalidateCheck(); row.querySelector('.paragraph-text').textContent = textarea.value;};
  speaker.onchange = () => {setEdit(original, {speakerId:speaker.value === 'unknown' ? null : speaker.value}); invalidateCheck(); const label = row.querySelector('.speaker-label'); label.textContent = speakerName(current, draft, speaker.value === 'unknown' ? null : speaker.value); label.style.setProperty('--speaker-color', colorFor(speaker.value === 'unknown' ? null : speaker.value));};
  function saveTimes() {
    const first = parseTime(start.value), last = parseTime(end.value);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first < 0 || first >= last || last > current.durationMs) {message.textContent = '请输入有效的 时:分:秒.毫秒，结束时间应晚于开始时间且不超过录音时长。'; return false;}
    const now = effectiveParagraph(original, draft);
    if (now.startMs !== first || now.endMs !== last) {setEdit(original, {startMs:first, endMs:last}); invalidateCheck(); row.querySelector('.timestamp').textContent = timeLabel(first) + ' – ' + timeLabel(last);}
    message.textContent = ''; return true;
  }
  start.onchange = end.onchange = saveTimes;
  done.onclick = () => {if (saveTimes()) {editing = null; refresh();}};
  reset.onclick = () => {delete draft.edits[original.id]; persist(); updateCounts(); editing = null; refresh();};
  controls.append(speakerLabel, startLabel, endLabel, done, reset);
  box.append(textarea, controls, node('p', 'small muted', '文字与讲话人修改自动保存。时间格式：时:分:秒.毫秒。修改后需重新标记本段已核对。'), message); row.append(box); textarea.focus();
}
function renderPage() {
  $('paragraphs').replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const original of filtered.slice(page * pageSize, (page + 1) * pageSize)) {
    const p = effectiveParagraph(original, draft), row = node('article', 'paragraph' + (activeId === p.id ? ' active' : '')); row.dataset.id = p.id;
    const top = node('div', 'paragraph-top'), label = node('span', 'speaker-label', speakerName(current, draft, p.speakerId)); label.style.setProperty('--speaker-color', colorFor(p.speakerId));
    const precise = Math.floor(p.startMs / 1000) === Math.floor(p.endMs / 1000);
    const timestamp = node('button', 'timestamp', timeLabel(p.startMs, precise) + ' – ' + timeLabel(p.endMs, precise)); timestamp.title = '回听 ' + timeLabel(p.startMs, true) + ' 至 ' + timeLabel(p.endMs, true); timestamp.onclick = () => playParagraph(original);
    const actions = node('div', 'paragraph-actions'), edit = node('button', '', '编辑'), checkLabel = node('label', 'review-state'), check = node('input'); check.type = 'checkbox'; check.checked = p.reviewed; check.setAttribute('aria-label', '本段文字、时间和讲话人均已回听核对'); checkLabel.append(check, document.createTextNode('已核对'));
    check.onchange = () => {setEdit(original, {reviewed:check.checked}, true); row.querySelector('.flags').replaceChildren(...(check.checked ? [node('span', 'flag reviewed-tag', '已人工核对')] : p.issues.map(x => node('span', 'flag', issueLabels[x] || x))));};
    edit.onclick = () => openEditor(row, original); actions.append(edit, checkLabel); top.append(label, timestamp, actions);
    const text = node('p', 'paragraph-text', p.text.trim()), flags = node('div', 'flags');
    if (p.reviewed) flags.append(node('span', 'flag reviewed-tag', '已人工核对'));
    else for (const issue of p.issues) flags.append(node('span', 'flag', issueLabels[issue] || issue));
    row.append(top, text, flags); fragment.append(row);
  }
  if (!filtered.length) fragment.append(node('div', 'empty', '没有符合筛选条件的段落。'));
  $('paragraphs').append(fragment);
  $('results-count').textContent = '显示 ' + filtered.length + ' / ' + current.paragraphs.length + ' 段 · 时间为模型估计';
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)); $('page').textContent = (page + 1) + ' / ' + pages;
  $('prev').disabled = page === 0; $('next').disabled = page + 1 >= pages;
}
function show(recording) {
  $('audio').pause(); current = recording; activeId = null; playEnd = null; page = 0; mode = 'all'; editing = null;
  notice('文字、时间和讲话人均为模型候选结果。点击时间回听后，可编辑并标记本段已核对。'); loadDraft();
  for (const button of $('recordings').children) button.classList.toggle('selected', button.dataset.id === current.id);
  for (const button of document.querySelectorAll('[data-mode]')) button.classList.toggle('selected', button.dataset.mode === mode);
  $('title').textContent = current.title; $('player-title').textContent = current.title;
  $('subtitle').textContent = timeLabel(current.durationMs) + ' · ' + (current.language === 'zh' ? '中文' : '英文') + ' · ' + current.speakers.length + ' 个讲话人编号';
  $('search').value = ''; speakerOptions($('speaker-filter'), 'all', true); renderSpeakers(); updateCounts(); refresh();
  $('audio-status').textContent = ''; $('audio').src = current.audio; $('audio').playbackRate = Number($('speed').value); $('clock').textContent = '00:00:00';
  $('save-status').textContent = Object.keys(draft.edits).length ? '已恢复本机校对稿' : '原始候选稿 · 尚未人工核对';
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], {type})), a = node('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
for (const recording of recordings) {
  const button = node('button', 'recording-button', recording.shortTitle); button.dataset.id = recording.id; button.append(node('small', '', timeLabel(recording.durationMs) + ' · ' + recording.speakers.length + ' 个讲话人编号')); button.onclick = () => show(recording); $('recordings').append(button);
}
for (const button of document.querySelectorAll('[data-mode]')) button.onclick = () => {mode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('selected', x === button)); refresh(true);};
$('search').oninput = () => {clearTimeout(saving); saving = setTimeout(() => refresh(true), 120);}; $('speaker-filter').onchange = () => refresh(true);
$('prev').onclick = () => {page--; editing = null; renderPage(); document.querySelector('.transcript').scrollIntoView({block:'start'});};
$('next').onclick = () => {page++; editing = null; renderPage(); document.querySelector('.transcript').scrollIntoView({block:'start'});};
$('export-md').onclick = () => download(current.id + '.transcript.md', exportText(current, draft, true), 'text/markdown;charset=utf-8');
$('export-txt').onclick = () => download(current.id + '.transcript.txt', exportText(current, draft, false), 'text/plain;charset=utf-8');
$('backup').onclick = () => download(current.id + '.review.json', JSON.stringify({...draft, savedAt:new Date().toISOString()}, null, 2), 'application/json');
$('manage-speakers').onclick = () => {const sidebar = document.querySelector('.sidebar'); sidebar.classList.toggle('speakers-open'); sidebar.scrollIntoView({block:'start'}); $('speakers').querySelector('input')?.focus();};
$('import').onclick = () => $('import-file').click();
$('import-file').onchange = async () => {
  const file = $('import-file').files[0]; if (!file) return; const recording = current;
  try {
    if (file.size > 20 * 1024 * 1024) throw Error('备份文件过大。');
    const next = validateDraft(recording, JSON.parse(await file.text()));
    if (current !== recording) throw Error('录音已经切换，请在对应录音中重新恢复。');
    if (Object.keys(draft.edits).length && !confirm('恢复备份会替换当前录音的校对稿。请先确认已备份现有修改。继续恢复？')) return;
    draft = next; persist(); renderSpeakers(); speakerOptions($('speaker-filter'), 'all', true); updateCounts(); refresh(true); notice('校对稿已恢复。原始录音和模型结果保持原样。');
  } catch (error) {notice(error.message || '恢复失败，请检查备份文件。', true);}
  finally {$('import-file').value = '';}
};
$('audio').ontimeupdate = () => {
  const audio = $('audio'), ms = audio.currentTime * 1000; $('clock').textContent = timeLabel(ms) + ' / ' + timeLabel(current.durationMs);
  if (playEnd !== null && audio.currentTime >= playEnd) {audio.pause(); playEnd = null;}
  const id = activeParagraph(current, draft, ms); if (id === activeId) return; activeId = id;
  document.querySelectorAll('.paragraph.active').forEach(x => x.classList.remove('active'));
  if ($('follow').checked && editing === null && id) {
    const index = filtered.findIndex(p => p.id === id);
    if (index >= 0 && Math.floor(index / pageSize) !== page) {page = Math.floor(index / pageSize); renderPage();}
    const row = [...$('paragraphs').children].find(x => x.dataset.id === id);
    if (row) {row.classList.add('active'); const rect = row.getBoundingClientRect(); if (rect.bottom > window.innerHeight - 180 || rect.top < 0) row.scrollIntoView({block:'center', behavior:'smooth'});}
  } else {const row = [...$('paragraphs').children].find(x => x.dataset.id === id); if (row) row.classList.add('active');}
};
$('audio').onerror = () => {$('audio-status').textContent = '音频加载失败，请将 index.html 与 audio 文件夹放在同一目录，或使用本地查看服务。';};
$('audio').onloadedmetadata = () => {$('audio-status').textContent = Math.abs($('audio').duration * 1000 - current.durationMs) > 1000 ? '播放副本时长与处理结果不一致，请核对。' : '';};
$('audio').onseeked = () => {if ($('audio').paused) playEnd = null;};
$('speed').onchange = () => {$('audio').playbackRate = Number($('speed').value);};
$('back').onclick = () => {playEnd = null; $('audio').currentTime = Math.max(0, $('audio').currentTime - 5);};
$('forward').onclick = () => {playEnd = null; $('audio').currentTime = Math.min(current.durationMs / 1000, $('audio').currentTime + 5);};
show(current);
