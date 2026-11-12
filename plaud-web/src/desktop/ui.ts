import './desktop.css';
import type { DesktopInfo } from './api.ts';

const byteSize = (bytes: number) => `${(bytes / 1000 ** 3).toFixed(1)} GB`;
export function installDesktopUI() {
  const desktop = window.recdockDesktop; if (!desktop) return;
  document.body.classList.add('desktop-app'); document.title = 'RecDock';
  const brand = document.querySelector('.brand strong'); if (brand) brand.textContent = 'RecDock';
  const badge = document.querySelector('.local-badge'); if (badge) badge.textContent = '本机处理 · 开源录音工作台';
  const entry = document.createElement('button'); entry.type = 'button'; entry.className = 'text-button desktop-entry'; entry.textContent = '模型与应用';
  const appbar = document.querySelector('.library-appbar-actions');
  if (appbar) appbar.prepend(entry);
  else document.querySelector('.topbar')?.insertBefore(entry, document.querySelector('.local-badge'));
  const panel = document.createElement('dialog'); panel.className = 'desktop-settings'; panel.setAttribute('aria-labelledby', 'desktop-title');
  panel.innerHTML = `<div class="desktop-heading"><div><p class="eyebrow">RECDOCK / LOCAL FIRST</p><h2 id="desktop-title">准备好你的录音工作台</h2></div><button type="button" data-desktop="close" aria-label="关闭模型与应用设置">关闭</button></div>
    <p class="desktop-summary" data-desktop="summary" role="status">正在检查本机环境…</p>
    <section><h3>本地模型</h3><p>沿用 Qwen3 ASR 1.7B、ForcedAligner 0.6B 和 pyannote Community 1。模型约 3.78 GB，准备完成后可离线处理音频。</p><label class="field">模型目录<input data-desktop="directory" readonly></label><div class="actions"><button data-desktop="choose">选择已有模型目录</button><button data-desktop="download" class="primary">下载 / 继续下载</button><button data-desktop="verify">完整校验</button><button data-desktop="probe">检查环境</button><button data-desktop="cancel">取消准备</button></div><p data-desktop="progress" class="desktop-progress" role="status" aria-live="polite"></p>
    <details><summary>模型授权与首次下载</summary><p>说话人模型需要在 Hugging Face 接受访问条件，并提供有权限的访问令牌。授权只用于模型下载，令牌加密保存在这台电脑上。</p><button data-desktop="terms">打开模型许可页面 ↗</button><label class="field">Hugging Face 令牌<input type="password" data-desktop="token" autocomplete="off" placeholder="hf_…"></label><div class="actions"><button data-desktop="save-token">保存令牌</button><button data-desktop="remove-token">删除已存令牌</button></div><p data-desktop="token-state" class="hint"></p></details></section>
    <section><h3>一键发送到 ChatGPT</h3><p>安装 RecDock 浏览器扩展，在浏览器中登录 ChatGPT，再到工作台设置中“连接现有 ChatGPT 页面”。发送完整转写与提示词，不上传音频。</p><ol><li>在 Edge 打开 <code>edge://extensions/</code>，启用开发人员模式。</li><li>点击“加载解压缩的扩展”，选择下方目录；已有扩展请重新加载。</li><li>打开并登录 ChatGPT，回到工作台设置连接页面。</li></ol><input data-desktop="extension-directory" readonly aria-label="浏览器扩展目录"><div class="actions"><button data-desktop="extension">打开扩展目录</button><button data-desktop="copy-extension">复制目录</button><button data-desktop="chatgpt">打开 ChatGPT ↗</button></div><p data-desktop="bridge-state" class="hint"></p></section>
    <section><h3>应用与资料</h3><p data-desktop="version"></p><label class="checkline"><input type="checkbox" data-desktop="login"> 登录电脑时启动 RecDock</label><p>关闭窗口后任务继续；退出应用后停止并保留任务。录音和模型保存在应用之外，替换升级安装包不会删除资料。</p><div class="actions"><button data-desktop="data">打开资料目录</button><button data-desktop="releases">查看新版本 ↗</button><button data-desktop="source">查看源码与帮助 ↗</button></div></section>`;
  document.body.append(panel);
  const find = <T extends HTMLElement = HTMLElement>(name: string) => panel.querySelector<T>(`[data-desktop="${name}"]`)!;
  let running = false;
  function render(info: DesktopInfo) {
    find<HTMLInputElement>('directory').value = info.modelsDirectory; find<HTMLInputElement>('extension-directory').value = info.extensionDirectory;
    find('summary').textContent = `${info.modelsPrepared ? '已找到本地模型，可完整校验后使用。' : '先导入录音也可以；准备模型后即可开始转写。'} 当前磁盘可用 ${byteSize(info.freeBytes)}。`;
    find('version').textContent = `RecDock ${info.version} · ${info.distribution}`;
    find<HTMLInputElement>('login').checked = info.loginAtStart;
    find('token-state').textContent = info.tokenSaved ? '已保存模型下载授权。' : '尚未保存模型下载授权；已有完整模型可以直接校验。';
    find('bridge-state').textContent = info.extensionConnected ? '桌面与浏览器扩展已连接。' : '尚未连接浏览器扩展，请完成上方安装步骤并保持 Edge 打开。';
    find('progress').textContent = info.setup.message || ''; running = info.setup.running;
    for (const name of ['choose', 'download', 'verify', 'probe']) find<HTMLButtonElement>(name).disabled = running;
    find<HTMLButtonElement>('cancel').disabled = !running;
  }
  async function refresh() { try { render(await desktop!.info()); } catch (error) { find('progress').textContent = error instanceof Error ? error.message : '暂时无法读取环境。'; } }
  async function action(work: () => Promise<unknown>) { try { await work(); await refresh(); } catch (error) { find('progress').textContent = error instanceof Error ? error.message : '操作未完成，请重试。'; } }
  entry.onclick = () => { panel.showModal(); void refresh(); };
  find('close').onclick = () => panel.close();
  find('choose').onclick = () => { void action(() => desktop.chooseModels()); };
  for (const name of ['download', 'verify', 'probe'] as const) find(name).onclick = () => { void action(() => desktop.setup(name)); };
  find('cancel').onclick = () => { void action(() => desktop.cancelSetup()); };
  find('terms').onclick = () => { void desktop.external('https://huggingface.co/pyannote/speaker-diarization-community-1'); };
  find('save-token').onclick = () => { const field = find<HTMLInputElement>('token'), token = field.value; field.value = ''; void action(() => desktop.saveToken(token)); };
  find('remove-token').onclick = () => { void action(() => desktop.removeToken()); };
  find('extension').onclick = () => { void action(() => desktop.reveal('extension')); };
  find('copy-extension').onclick = () => { void action(() => desktop.copyExtensionPath()); };
  find('chatgpt').onclick = () => { void desktop.external('https://chatgpt.com/'); };
  find('data').onclick = () => { void action(() => desktop.reveal('data')); };
  find('releases').onclick = () => { void desktop.external('https://github.com/audiobridge-ai/recdock/releases'); };
  find('source').onclick = () => { void desktop.external('https://github.com/audiobridge-ai/recdock'); };
  find<HTMLInputElement>('login').onchange = event => { void action(() => desktop.login((event.target as HTMLInputElement).checked)); };
  panel.addEventListener('close', () => { find<HTMLInputElement>('token').value = ''; });
  desktop.onSetup(() => { void refresh(); });
  setInterval(() => { if (panel.open) void refresh(); }, 3000);
  void desktop.info().then(info => { render(info); if (!info.modelsPrepared) panel.showModal(); });

  const chooser = document.createElement('dialog'); chooser.className = 'desktop-bluetooth'; chooser.setAttribute('aria-label', '选择蓝牙设备');
  const title = document.createElement('h2'); title.textContent = '选择你的 PLAUD';
  const hint = document.createElement('p'); hint.textContent = '请先断开手机 App 的蓝牙连接。正在搜索附近设备…';
  const list = document.createElement('div'); list.className = 'desktop-device-list';
  const cancel = document.createElement('button'); cancel.textContent = '取消搜索'; cancel.onclick = () => { void desktop.selectBluetooth(''); chooser.close(); };
  chooser.append(title, hint, list, cancel); document.body.append(chooser);
  chooser.addEventListener('cancel', () => { void desktop.selectBluetooth(''); });
  desktop.onBluetoothDevices(devices => {
    if (!devices.length) { if (chooser.open) chooser.close(); return; }
    list.replaceChildren();
    for (const device of devices) { const button = document.createElement('button'); button.textContent = device.name; button.onclick = () => { void desktop.selectBluetooth(device.id); chooser.close(); }; list.append(button); }
    if (!chooser.open) chooser.showModal();
  });
}
