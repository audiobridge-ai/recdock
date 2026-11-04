import { conversationUrl, messageFor, publicTask, selectTarget, validatePacket, workspaceSender } from './shared.mjs';
import { attachFile, inspectPage, submitMessage } from './page-adapter.mjs';

let queue = Promise.resolve();
const serial = operation => { const next = queue.then(operation, operation); queue = next.catch(() => {}); return next; };
let running;
async function config() {
  const value = (await chrome.storage.local.get('config')).config;
  if (value) return value;
  const created = { targetId: crypto.randomUUID(), tabId: null };
  await chrome.storage.local.set({ config: created }); return created;
}
async function tasks() { return (await chrome.storage.local.get('tasks')).tasks || {}; }
async function save(task, state, message, url) {
  task = { ...task, state, message, ...(url ? { conversationUrl: url } : {}), updatedAtMs: Date.now() };
  const all = await tasks(); all[task.id] = task;
  await chrome.storage.local.set({ tasks: all }); return task;
}
async function targetTab(c) {
  if (!c.tabId) throw Error('请先在设置中连接现有的 ChatGPT 页面。');
  let tab; try { tab = await chrome.tabs.get(c.tabId); } catch { throw Error('已连接的 ChatGPT 标签页已关闭，请重新连接。'); }
  if (!selectTarget([tab], c.tabId)) throw Error('已连接页面已离开 ChatGPT，请返回后重新连接。');
  return tab;
}
async function execute(tabId, func, args) {
  const c = await config(); if (c.tabId !== tabId) throw Error('连接目标已更改，已停止发送。');
  await targetTab(c);
  const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func, args: args ? [args] : [] });
  if (!results[0]?.result) throw Error('无法读取 ChatGPT 页面，请刷新后重新核对。');
  return results[0].result;
}
async function info() { const c = await config(), all = await tasks(); let bound = false; try { await targetTab(c); bound = true; } catch {} return { version: 1, targetId: c.targetId, bound, targetLabel: bound ? '已连接的 ChatGPT 标签页' : '尚未连接 ChatGPT 页面', activeTaskId: running || Object.values(all).find(t => ['attaching', 'attached', 'submitting'].includes(t.state))?.id }; }
async function bind() {
  if (running) throw Error('正在转发，请等待当前任务完成后再连接。');
  const c = await config(), tab = selectTarget(await chrome.tabs.query({ url: 'https://chatgpt.com/*' }), c.tabId);
  if (!tab) throw Error('请先在浏览器中打开并登录 ChatGPT，再点击连接。');
  await chrome.storage.local.set({ config: { targetId: crypto.randomUUID(), tabId: tab.id } });
  return info();
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function inspect(task) {
  const c = await config(); if (c.targetId !== task.targetId) throw Error('ChatGPT 连接已更改，请重新选择目标。');
  return execute(c.tabId, inspectPage, { filename: task.filename, message: task.messageText });
}
async function reconcile(task) {
  if (task.state === 'submitted') return task;
  const page = await inspect(task), url = conversationUrl(page.url);
  if (page.submitted && url) return save(task, 'submitted', '已确认 ChatGPT 用户消息与附件。', url);
  if (running === task.id) return task;
  if (['user_action_required', 'failed'].includes(task.state)) return task;
  return save(task, 'user_action_required', '尚未确认提交。请检查已连接的 ChatGPT 页面；系统不会自动重复上传或发送。');
}
async function run(packet, initial) {
  let task = initial;
  try {
    const c = await config(), tab = await targetTab(c);
    let page = await inspect(task);
    if (!page.ready || page.generating) throw Error('请先登录 ChatGPT、切换到聊天模式，并等待当前回复完成。');
    if (page.text.trim() || page.hasAttachments) throw Error('ChatGPT 中有未发送的草稿或附件，请先处理，再重新核对发送状态。');
    // Start a new conversation in this SAME tab. Never create another ChatGPT tab.
    if (new URL(tab.url).pathname !== '/') {
      await chrome.tabs.update(tab.id, { url: 'https://chatgpt.com/', active: true });
      for (let i = 0; i < 40; i++) {
        await delay(500); try { page = await inspect(task); if (page.ready && new URL(page.url).pathname === '/') break; } catch { if (i === 39) throw Error('ChatGPT 新对话未就绪，请手动检查。'); }
      }
      if (!page.ready || new URL(page.url).pathname !== '/' || page.text.trim() || page.hasAttachments) throw Error('新对话尚未准备好，请手动检查。');
    }
    task = await save({ ...task, touchedPage: true }, 'attaching', '正在上传完整转写文件…');
    await execute(tab.id, attachFile, { filename: task.filename, content: packet.content, message: task.messageText });
    let stable = 0;
    for (let i = 0; i < 120; i++) {
      await delay(1000); page = await inspect(task);
      if (page.text.replace(/\s+/g, ' ').trim() !== task.messageText.replace(/\s+/g, ' ').trim()) throw Error('ChatGPT 草稿已变化，请手动检查。');
      stable = page.attached && !page.uploadBusy && page.canSend ? stable + 1 : 0;
      if (stable >= 2) break;
    }
    if (stable < 2) throw Error('附件上传未完成，可能需要登录、处理配额或手动上传。');
    task = await save(task, 'attached', '全文已上传，正在提交…');
    task = await save({ ...task, attemptedSubmit: true }, 'submitting', '正在确认 ChatGPT 对话…'); // Persist BEFORE the one and only click.
    await execute(tab.id, submitMessage, { filename: task.filename, message: task.messageText });
    for (let i = 0; i < 60; i++) {
      await delay(1000); page = await inspect(task); const url = conversationUrl(page.url);
      if (page.submitted && url) { task = await save(task, 'submitted', '已确认 ChatGPT 用户消息与附件。', url); break; }
    }
    if (task.state !== 'submitted') throw Error('未能确认提交结果，请检查 ChatGPT 页面；系统不会自动重复发送。');
  } catch (error) { task = await save(task, 'user_action_required', (error instanceof Error ? error.message : '请检查 ChatGPT 页面。').slice(0, 600)); }
  finally { running = undefined; await chrome.storage.session.remove(task.id); }
}
async function start(input) {
  const packet = await validatePacket(input), c = await config();
  if (packet.transfer.targetId !== c.targetId) throw Error('ChatGPT 连接已更改，请重新准备发送。');
  await targetTab(c); const all = await tasks(), previous = all[packet.transfer.id];
  const base = { id: packet.transfer.id, targetId: c.targetId, sha256: packet.transfer.sha256, promptHash: packet.transfer.promptHash, filename: packet.transfer.filename, messageText: messageFor(packet), state: 'prepared' };
  if (!previous && (packet.transfer.submissionAttempted || ['submitting', 'submitted'].includes(packet.transfer.state))) return publicTask(await save({ ...base, attemptedSubmit: true }, 'user_action_required', '本地记录显示此任务可能已提交，但扩展回执缺失。请手动核对 ChatGPT；不会自动重复发送。'));
  if (previous) {
    if (previous.targetId !== c.targetId || previous.sha256 !== packet.transfer.sha256 || previous.promptHash !== packet.transfer.promptHash) throw Error('任务内容不一致，请重新准备发送。');
    const checked = await reconcile(previous);
    if (checked.state === 'submitted' || previous.attemptedSubmit || running) return publicTask(checked);
    const page = await inspect(previous);
    if (page.text.trim() || page.hasAttachments || page.generating) return publicTask(checked);
    // An explicit retry before any submit click is allowed only after an empty-page check.
  }
  for (const pending of Object.values(all)) if (!running && pending.id !== packet.transfer.id && ['attaching', 'attached', 'submitting'].includes(pending.state)) await reconcile(pending);
  if (running) throw Error('另一个任务尚未确认完成，请先核对该任务。');
  let task = base;
  await chrome.storage.session.set({ [task.id]: packet });
  task = await save(task, 'prepared', '正在准备 ChatGPT 页面…'); running = task.id;
  void run(packet, task).catch(() => { running = undefined; }); return publicTask(task);
}
async function handle(action, payload) {
  if (action === 'info') return info();
  if (action === 'bind') return bind();
  if (action === 'start') return start(payload);
  if (action === 'status') { const task = (await tasks())[payload?.id]; return publicTask(task ? await reconcile(task) : null); }
  if (action === 'open') {
    const url = conversationUrl(payload?.conversationUrl), c = await config();
    if (!url) throw Error('ChatGPT 对话链接不正确。');
    const tab = await targetTab(c);
    if (tab.url === url) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return { opened: true }; }
    if (running) throw Error('正在转发，请等待当前任务完成后再打开其他对话。');
    const page = await execute(tab.id, inspectPage);
    if (page.text.trim() || page.hasAttachments || page.generating) throw Error('ChatGPT 中有草稿或正在回复，请先处理再打开历史对话。');
    await chrome.tabs.update(tab.id, { url, active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return { opened: true };
  }
  throw Error('不支持此扩展操作。');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const popup = sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('popup.html');
  if (!popup && (!workspaceSender(sender) || message?.source !== 'recdock-workspace')) return false;
  if (popup && !['info', 'bind'].includes(message?.action)) return false;
  serial(() => handle(message.action, message.payload)).then(result => respond({ result }), error => respond({ error: error instanceof Error ? error.message : '扩展操作未完成。' }));
  return true;
});
