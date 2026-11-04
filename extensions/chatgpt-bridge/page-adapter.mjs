// These functions run in the isolated world of the one bound ChatGPT tab.
// Keep each function self-contained: executeScript cannot capture module closures.
export function inspectPage({ filename = '', message = '' } = {}) {
  const visible = e => !!e && !!(e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
  const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-id="root"], [contenteditable="true"][role="textbox"]')].find(visible);
  const form = composer?.closest('form') || composer?.closest('[data-type="unified-composer"]') || composer?.parentElement?.parentElement;
  const text = composer ? ('value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '') : '';
  const normalize = s => s.replace(/\s+/g, ' ').trim();
  const attachmentName = value => {
    const raw = String(value || '').trim();
    if (!filename || !raw) return null;
    const dot = filename.lastIndexOf('.'), stem = filename.slice(0, dot), extension = filename.slice(dot);
    return [raw, raw.replace(/^(?:移除|删除附件|Remove(?: file| attachment)?)\s*[:：]?\s*/i, '').trim()].find(name => name === filename || dot > 0 && name.startsWith(stem) && name.endsWith(extension) && /^ ?\(\d{1,6}\)$/.test(name.slice(stem.length, -extension.length))) || null;
  };
  const users = message ? [...document.querySelectorAll('[data-message-author-role="user"], [data-user-message-bubble="true"]')].filter(e => visible(e) && normalize(e.innerText ?? e.textContent ?? '').includes(normalize(message))) : [];
  // SPA navigation retains hidden copies of previous messages. Evidence must
  // come from a rendered matching user message and its own attachment card.
  const submitted = users.some(user => {
    const turn = user.closest('[data-testid^="conversation-turn-"], [data-content-search-turn-key]') || user;
    const attachments = turn.querySelector('[data-chatgpt-search-unit-key$=":user"]') || turn;
    return [...attachments.querySelectorAll('a, button, [title], [data-testid*="attachment"], [class*="file"], [class*="attachment"], [class*="resource-card"] span')].some(e => visible(e) && (attachmentName(e.getAttribute('title')) || !user.contains(e)) && [e.getAttribute('title'), e.getAttribute('aria-label'), e.textContent].some(attachmentName));
  });
  const send = [...(form || document).querySelectorAll('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"], button[aria-label="发送"], button[aria-label="Send message"]')].find(visible);
  const stop = [...document.querySelectorAll('[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="停止流式传输"], button[aria-label="停止"], button[aria-label="停止生成"], button[aria-label="Stop generating"]')].some(visible);
  const uploadBusy = form && [...form.querySelectorAll('[role="progressbar"], [aria-busy="true"], [class*="animate-spin"]')].some(visible);
  const chips = form ? [...form.querySelectorAll('button, [title], [aria-label], [data-testid*="attachment"], [class*="file"], [class*="attachment"]')].filter(e => visible(e) && !composer.contains(e) && !e.contains(composer)) : [];
  const actualFilename = chips.flatMap(e => [e.getAttribute('title'), e.getAttribute('aria-label'), e.textContent]).map(attachmentName).find(Boolean) || null;
  const attached = !!actualFilename;
  const removeButtons = form ? [...form.querySelectorAll('button[aria-label]')].filter(e => visible(e) && /^(?:移除|删除附件|Remove(?: file| attachment)?)\s/i.test(e.getAttribute('aria-label') || '')) : [];
  const attachmentCount = removeButtons.length || (attached ? 1 : 0);
  const unrelatedAttachments = removeButtons.some(e => !attachmentName(e.getAttribute('aria-label')));
  const hasAttachments = attached || !!form?.querySelector('button[aria-label*="Remove file"], button[aria-label*="移除文件"], button[aria-label*="删除附件"], [data-testid*="attachment"], [class*="resource-card"], [class*="attachment-card"]') || [...(form?.querySelectorAll('input[type="file"]') || [])].some(e => e.files?.length);
  return { ready: !!composer, text, hasAttachments, attached, attachmentFilename: actualFilename, attachmentCount, unrelatedAttachments, uploadBusy: !!uploadBusy, canSend: !!send && !send.disabled && send.getAttribute('aria-disabled') !== 'true', generating: stop, submitted, url: location.href };
}

export function attachFile({ filename, content, message }) {
  const visible = e => !!e && !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-id="root"], [contenteditable="true"][role="textbox"]')].find(visible);
  if (!composer) throw Error('未找到 ChatGPT 输入框，请先登录并切换到聊天模式。');
  if (('value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '').trim()) throw Error('ChatGPT 中有未发送的草稿，请先处理后重试。');
  const form = composer.closest('form') || composer.closest('[data-type="unified-composer"]') || composer.parentElement?.parentElement;
  const input = [...(form?.querySelectorAll('input[type="file"]') || [])].find(e => !e.disabled && (!e.accept || e.accept.split(',').some(type => ['*/*', '.md', 'text/*', 'text/plain', 'text/markdown', 'application/*', 'application/octet-stream'].includes(type.trim().toLowerCase()))));
  if (!input) throw Error('未找到文件上传入口，请在 ChatGPT 点击“添加文件”后重新核对。');
  // Insert text through the editor's native input path; never replace an existing draft.
  composer.focus();
  if ('value' in composer) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter.call(composer, message); composer.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(composer); selection.removeAllRanges(); selection.addRange(range);
    if (!document.execCommand('insertText', false, message)) throw Error('ChatGPT 输入框不支持自动填写，请手动上传。');
  }
  const text = 'value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '';
  if (text.replace(/\s+/g, ' ').trim() !== message.replace(/\s+/g, ' ').trim()) throw Error('提示词未完整填入，请在 ChatGPT 检查草稿。');
  const transfer = new DataTransfer(); transfer.items.add(new File([content], filename, { type: 'text/markdown' }));
  input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  return { attached: true };
}

export function submitMessage({ filename, message }) {
  const visible = e => !!e && !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-id="root"], [contenteditable="true"][role="textbox"]')].find(visible);
  if (!composer) throw Error('ChatGPT 输入框不可用，请手动检查。');
  const text = 'value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '';
  if (text.replace(/\s+/g, ' ').trim() !== message.replace(/\s+/g, ' ').trim()) throw Error('ChatGPT 草稿已变化，已停止自动提交。');
  const form = composer.closest('form') || composer.closest('[data-type="unified-composer"]') || composer.parentElement?.parentElement;
  const attachmentName = value => {
    const raw = String(value || '').trim();
    if (!filename || !raw) return null;
    const dot = filename.lastIndexOf('.'), stem = filename.slice(0, dot), extension = filename.slice(dot);
    return [raw, raw.replace(/^(?:移除|删除附件|Remove(?: file| attachment)?)\s*[:：]?\s*/i, '').trim()].find(name => name === filename || dot > 0 && name.startsWith(stem) && name.endsWith(extension) && /^ ?\(\d{1,6}\)$/.test(name.slice(stem.length, -extension.length))) || null;
  };
  const attached = [...(form || document).querySelectorAll('button, [title], [aria-label], [data-testid*="attachment"], [class*="file"], [class*="attachment"]')].some(e => visible(e) && !composer.contains(e) && !e.contains(composer) && [e.getAttribute('title'), e.getAttribute('aria-label'), e.textContent].some(attachmentName));
  const removeButtons = [...(form || document).querySelectorAll('button[aria-label]')].filter(e => visible(e) && /^(?:移除|删除附件|Remove(?: file| attachment)?)\s/i.test(e.getAttribute('aria-label') || ''));
  if (removeButtons.length > 1 || removeButtons.some(e => !attachmentName(e.getAttribute('aria-label')))) throw Error('附件与当前稿件不一致，请检查 ChatGPT 草稿。');
  const busy = [...(form || document).querySelectorAll('[role="progressbar"], [aria-busy="true"], [class*="animate-spin"]')].some(visible);
  const send = [...(form || document).querySelectorAll('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"], button[aria-label="发送"], button[aria-label="Send message"]')].find(visible);
  if (!attached || busy || !send || send.disabled || send.getAttribute('aria-disabled') === 'true') throw Error('附件尚未完成上传，已停止自动提交。');
  // Match the focus change of a native send-button click so the editor can flush
  // its draft state before submission.
  send.focus(); send.click(); return { clicked: true };
}

export function beginNewChat() {
  const visible = e => !!e && !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-id="root"], [contenteditable="true"][role="textbox"]')].find(visible);
  const text = composer ? ('value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '') : '';
  if (!composer || text.trim()) throw Error('ChatGPT 中有未发送的内容，已保留当前页面。');
  const button = [...document.querySelectorAll('button, a[data-testid="create-new-chat-button"], a[aria-label="New chat"], a[aria-label="新聊天"]')].find(e => visible(e) && (/^(新聊天|New chat)$/i.test(e.getAttribute('aria-label') || '') || /^(新聊天|New chat)$/i.test((e.textContent || '').trim()) || e.getAttribute('data-testid') === 'create-new-chat-button'));
  if (!button) return { clicked: false };
  button.click(); return { clicked: true };
}

/** Only an exact draft already proven submitted may be cleared. No app storage APIs. */
export function clearSubmittedDraft({ message, filename }) {
  const visible = e => !!e && !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  if (location.origin !== 'https://chatgpt.com' || location.pathname !== '/') throw Error('页面已变化，已保留草稿。');
  const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-id="root"], [contenteditable="true"][role="textbox"]')].find(visible);
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  const text = composer ? ('value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '') : '';
  if (!composer || !text.trim() || normalize(text) !== normalize(message)) return { cleared: false };
  const form = composer.closest('form') || composer.closest('[data-type="unified-composer"]') || composer.parentElement?.parentElement;
  if (!form) return { cleared: false };
  const attachments = [...form.querySelectorAll('[class*="resource-card"], [data-testid*="attachment"], [class*="attachment-card"], button[aria-label*="Remove file"], button[aria-label*="移除文件"], button[aria-label*="删除附件"], [role="progressbar"], [aria-busy="true"]')].some(visible);
  const inputs = [...form.querySelectorAll('input[type="file"]')];
  if (attachments || inputs.some(input => [...(input.files || [])].some(file => file.name !== filename))) return { cleared: false };
  composer.focus();
  if ('value' in composer) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, '');
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(composer); selection.removeAllRanges(); selection.addRange(range);
    if (!document.execCommand('delete', false)) return { cleared: false };
  }
  const after = 'value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '';
  if (after.trim()) return { cleared: false };
  for (const input of inputs) if (input.files?.length) input.value = '';
  composer.blur(); return { cleared: true };
}
