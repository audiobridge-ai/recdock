import { t, html, systemMessage } from '../i18n/index.ts';
import { localConnection } from './connection.ts';

export function installCompanionPanel(parent: HTMLElement, onConnected: () => Promise<void>, onDisconnected: () => void) {
  if (!localConnection.remote) return;
  const panel = document.createElement('section'); panel.className = 'companion-panel'; panel.setAttribute('aria-label', t("本地助手连接"));
  panel.innerHTML = html`<div class="companion-heading"><div><strong>连接 RecDock 本地助手</strong><p>网页提供工作台，音频和转写保存在这台电脑。</p></div><span data-helper-status role="status">尚未连接</span></div>
    <div data-helper-desktop><button type="button" data-helper-approve class="primary">连接 Mac 助手</button><a href="recdock://open">打开 RecDock 助手 ↗</a><span>首次连接请在 Mac 助手窗口中确认，之后自动恢复。</span></div>
    <details data-helper-fallback><summary>使用备用配对码</summary><form data-helper-form><label>助手地址<input data-helper-endpoint type="url" required aria-label="本地助手地址"></label><a data-helper-open target="_blank" rel="noopener noreferrer">打开助手，查看配对码 ↗</a><label>一次性配对码<input data-helper-code inputmode="numeric" autocomplete="off" pattern="[0-9]{8}" maxlength="8" required placeholder="8 位数字"></label><button type="submit" class="primary">连接本地助手</button></form></details>
    <div data-helper-connected hidden><span>本地助手已连接。关闭网页后，已开始的转写仍会继续。</span><button type="button" data-helper-disconnect>断开网页连接</button></div>
    <p data-helper-message role="status" aria-live="polite"></p><details data-helper-guide><summary>备用配对与连接说明</summary><p>安装并打开 RecDock Mac 助手后，点击“连接 Mac 助手”，在本机确认网站授权。关闭网页不会停止任务；退出助手会暂停任务。命令行开发入口：</p><pre data-helper-command></pre><p>也可以使用下方一次性配对码进行临时连接。浏览器请求本机网络访问权限时请选择允许；仅授权你信任的工作台。</p><a href="/connection-guide.html" target="_blank" rel="noopener noreferrer">完整连接说明 ↗</a></details>`;
  parent.prepend(panel);
  const query = <T extends HTMLElement>(s: string) => panel.querySelector<T>(s)!;
  const form = query<HTMLFormElement>('[data-helper-form]'), endpoint = query<HTMLInputElement>('[data-helper-endpoint]'), code = query<HTMLInputElement>('[data-helper-code]'), link = query<HTMLAnchorElement>('[data-helper-open]'), connected = query<HTMLDivElement>('[data-helper-connected]'), status = query<HTMLElement>('[data-helper-status]'), message = query<HTMLElement>('[data-helper-message]');
  endpoint.value = localConnection.endpoint; link.href = `${localConnection.endpoint}/`;
  query<HTMLElement>('[data-helper-command]').textContent = `RECDOCK_WEB_ORIGINS='${window.location.origin}' npm run companion`;
  const desktop = query<HTMLElement>('[data-helper-desktop]');
  function render(paired: boolean) { form.hidden = paired; query<HTMLElement>('[data-helper-fallback]').hidden = paired; desktop.hidden = paired; connected.hidden = !paired; status.textContent = paired ? t("已连接 · 本机处理") : t("尚未连接"); panel.classList.toggle('is-connected', paired); }
  function error(e: unknown) { message.textContent = e instanceof Error ? systemMessage(e.message) : t("连接未完成，请重试。"); }
  let approval: AbortController | undefined;
  query<HTMLButtonElement>('[data-helper-approve]').onclick = () => {
    if (approval) { approval.abort(); approval = undefined; return; }
    const controller = new AbortController(); approval = controller;
    const button = query<HTMLButtonElement>('[data-helper-approve]'); button.textContent = t("取消等待授权");
    void localConnection.approve(controller.signal, () => { message.textContent = t("请在 Mac 菜单栏打开 RecDock，在助手窗口中确认当前网站。"); })
      .then(async () => { render(true); await onConnected(); message.textContent = ''; })
      .catch(e => { if (controller.signal.aborted) message.textContent = t("已取消等待；如助手中仍有请求，请选择拒绝。"); else error(e); })
      .finally(() => { if (approval === controller) approval = undefined; button.textContent = t("连接 Mac 助手"); });
  };
  endpoint.addEventListener('input', () => { try { localConnection.setEndpoint(endpoint.value); link.href = `${localConnection.endpoint}/`; } catch { link.removeAttribute('href'); } });
  form.onsubmit = event => {
    event.preventDefault(); const button = form.querySelector('button')!; button.disabled = true; message.textContent = t("正在连接本地助手…");
    void (async () => {
      localConnection.setEndpoint(endpoint.value); const value = code.value.trim(); code.value = '';
      await localConnection.pair(value); render(true); await onConnected(); message.textContent = '';
    })().catch(error).finally(() => { button.disabled = false; });
  };
  query<HTMLButtonElement>('[data-helper-disconnect]').onclick = () => {
    const button = query<HTMLButtonElement>('[data-helper-disconnect]'); button.disabled = true;
    void localConnection.disconnect().then(() => { onDisconnected(); render(false); message.textContent = t("网页访问授权已撤销，助手中的文件与转写任务继续保留。"); }).catch(error).finally(() => { button.disabled = false; });
  };
  window.addEventListener('recdock:companion-expired', () => { onDisconnected(); render(false); message.textContent = t("网页授权已过期或被撤销，请重新连接本地助手。"); });
  render(false);
  if (localConnection.paired) {
    message.textContent = t("正在恢复本地助手连接…");
    void localConnection.health().then(onConnected).then(() => { render(true); message.textContent = ''; }).catch(error);
  } else {
    void localConnection.health().then(value => { if (value.desktopApproval) status.textContent = t("已检测到 Mac 助手 · 等待授权"); }).catch(() => {});
  }
}
