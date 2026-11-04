// These functions run in the isolated world of the one bound ChatGPT tab.
// Keep each function self-contained: executeScript cannot capture module closures.
export function inspectPage({ filename = '', message = '' } = {}) {
  const visible = e => !!e && !!(e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
  const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-id="root"], [contenteditable="true"][role="textbox"]')].find(visible);
  const form = composer?.closest('form') || composer?.closest('[data-type="unified-composer"]') || composer?.parentElement?.parentElement;
  const text = composer ? ('value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '') : '';
  const normalize = s => s.replace(/\s+/g, ' ').trim();
  const user = message ? [...document.querySelectorAll('[data-message-author-role="user"], [data-user-message-bubble="true"]')].find(e => normalize(e.innerText ?? e.textContent ?? '').includes(normalize(message))) : undefined;
  const turn = user?.closest('[data-testid^="conversation-turn-"], [data-content-search-turn-key]') || user;
  const attachments = turn?.querySelector('[data-chatgpt-search-unit-key$=":user"]') || turn;
  // A sent message must include both our exact message and an actual attachment card.
  const attachmentEvidence = attachments && [...attachments.querySelectorAll('a, button, [title], [data-testid*="attachment"], [class*="file"], [class*="attachment"]')].some(e => (e.getAttribute('title') === filename || !user.contains(e)) && ((e.textContent || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.getAttribute('aria-label') || '')).includes(filename));
  const send = [...(form || document).querySelectorAll('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"], button[aria-label="发送"], button[aria-label="Send message"]')].find(visible);
  const stop = [...document.querySelectorAll('[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="停止流式传输"], button[aria-label="停止"], button[aria-label="停止生成"], button[aria-label="Stop generating"]')].some(visible);
  const uploadBusy = form && [...form.querySelectorAll('[role="progressbar"], [aria-busy="true"], [class*="animate-spin"]')].some(visible);
  const chips = form ? [...form.querySelectorAll('[title], [aria-label], [data-testid*="attachment"], [class*="file"], [class*="attachment"]')].filter(e => !composer.contains(e) && !e.contains(composer)) : [];
  const attached = !!filename && chips.some(e => ((e.textContent || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.getAttribute('aria-label') || '')).includes(filename));
  const hasAttachments = attached || !!form?.querySelector('button[aria-label*="Remove file"], button[aria-label*="移除文件"], button[aria-label*="删除附件"], [data-testid*="attachment"], [class*="resource-card"], [class*="attachment-card"]') || [...document.querySelectorAll('input[type="file"]')].some(e => e.files?.length);
  return { ready: !!composer, text, hasAttachments, attached, uploadBusy: !!uploadBusy, canSend: !!send && !send.disabled && send.getAttribute('aria-disabled') !== 'true', generating: stop, submitted: !!user && !!attachmentEvidence, url: location.href };
}

export function attachFile({ filename, content, message }) {
  const visible = e => !!e && !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const composer = [...document.querySelectorAll('#prompt-textarea, textarea[data-id="root"], [contenteditable="true"][role="textbox"]')].find(visible);
  if (!composer) throw Error('未找到 ChatGPT 输入框，请先登录并切换到聊天模式。');
  if (('value' in composer ? composer.value : composer.innerText ?? composer.textContent ?? '').trim()) throw Error('ChatGPT 中有未发送的草稿，请先处理后重试。');
  const input = [...document.querySelectorAll('input[type="file"]')].find(e => !e.disabled && (!e.accept || /\*|\.md|text|application/.test(e.accept)));
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
  const attached = [...(form || document).querySelectorAll('[title], [aria-label], [data-testid*="attachment"], [class*="file"], [class*="attachment"]')].some(e => !composer.contains(e) && !e.contains(composer) && ((e.textContent || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.getAttribute('aria-label') || '')).includes(filename));
  const busy = [...(form || document).querySelectorAll('[role="progressbar"], [aria-busy="true"], [class*="animate-spin"]')].some(visible);
  const send = [...(form || document).querySelectorAll('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"], button[aria-label="发送"], button[aria-label="Send message"]')].find(visible);
  if (!attached || busy || !send || send.disabled || send.getAttribute('aria-disabled') === 'true') throw Error('附件尚未完成上传，已停止自动提交。');
  send.click(); return { clicked: true };
}
