import { t, html, systemMessage } from '../i18n/index.ts';
import { ChatGPTBridge, chatgptPrompt, saveChatgptPrompt } from './bridge.ts';

export function installChatGPTSettings(parent: HTMLElement) {
  const bridge = new ChatGPTBridge(), section = document.createElement('section'); section.className = 'panel settings-chatgpt'; section.id = 'settings-chatgpt';
  section.innerHTML = html`<div class="section-heading"><h3>ChatGPT 转发</h3></div><p class="panel-description" data-chatgpt-status role="status">连接浏览器中的 ChatGPT 后，可发送已保存的完整转写。</p><div class="actions"><button type="button" data-chatgpt-bind>连接现有 ChatGPT 页面</button><button type="button" class="quiet" data-chatgpt-check>检查连接</button></div><p class="hint">固定复用一个 ChatGPT 标签页，每次在该页新建对话。更换 ChatGPT 账号后，请重新连接。</p><label class="field">发送时的提示词<textarea data-chatgpt-prompt rows="4" maxlength="6000" aria-label="ChatGPT 转发提示词"></textarea></label><div class="actions"><button type="button" class="quiet" data-chatgpt-save>保存提示词</button></div><details class="settings-diagnostics"><summary>安装扩展与手动转发</summary><ol><li>在 Edge 打开扩展管理，启用开发人员模式，选择“加载解压缩的扩展”。</li><li>选择项目中的 <code>plaud-web/extensions/chatgpt-bridge</code> 目录，然后刷新录音工作台。</li><li>打开并登录 ChatGPT，保持在聊天模式，再点击上方的“连接现有 ChatGPT 页面”。</li></ol><p class="hint">扩展只接收 localhost:5173 工作台的任务，并操作你连接的 chatgpt.com 页面。只上传当前版本的转写全文与提示词。自动转发上限为 8 MiB；上传配额由 ChatGPT 决定。遇到登录、配额或页面变化时会暂停，可导出 Markdown 全文手动上传。</p></details>`;
  parent.append(section);
  if (window.recdockDesktop) {
    const details = section.querySelector('details')!;
    details.innerHTML = html`<summary>安装扩展与手动转发</summary><p class="hint">请打开顶部“模型与应用”，按步骤安装或重新加载 RecDock 扩展，并在 Edge 中登录 ChatGPT，然后在这里连接现有页面。只发送已保存版本的完整转写和提示词，不上传音频。自动转发上限 8 MiB；发送遇到问题时可导出 Markdown 全文手动上传。</p>`;
  }
  const prompt = section.querySelector<HTMLTextAreaElement>('[data-chatgpt-prompt]')!, status = section.querySelector<HTMLElement>('[data-chatgpt-status]')!, bind = section.querySelector<HTMLButtonElement>('[data-chatgpt-bind]')!, check = section.querySelector<HTMLButtonElement>('[data-chatgpt-check]')!;
  prompt.value = chatgptPrompt();
  async function connect(rebind: boolean) {
    check.disabled = bind.disabled = true;
    try { const info = await (rebind ? bridge.bind() : bridge.info()); status.textContent = info.bound ? t("{0}。发送前请确认该页使用的是你的目标账号。", systemMessage(info.targetLabel)) : t("扩展已就绪。请先打开并登录 ChatGPT，再连接现有页面。"); bind.textContent = info.bound ? t("重新连接 ChatGPT 页面") : t("连接现有 ChatGPT 页面"); }
    catch (error) { status.textContent = error instanceof Error ? systemMessage(error.message) : t("无法连接扩展。"); }
    finally { check.disabled = bind.disabled = false; }
  }
  check.onclick = () => { void connect(false); }; bind.onclick = () => { void connect(true); };
  section.querySelector<HTMLButtonElement>('[data-chatgpt-save]')!.onclick = () => { try { saveChatgptPrompt(prompt.value); prompt.value = chatgptPrompt(); status.textContent = t("提示词已保存，用于后续新发送的稿件。"); } catch (error) { status.textContent = error instanceof Error ? systemMessage(error.message) : t("保存失败。"); } };
  window.addEventListener('recdock:locale-changing', event => { if (prompt.value !== chatgptPrompt()) { event.preventDefault(); status.textContent = t('保存或取消修改后再切换语言。'); prompt.focus(); } });
  return { check: () => connect(false), focus: () => { section.scrollIntoView({ block: 'start', behavior: 'smooth' }); bind.focus({ preventScroll: true }); } };
}
