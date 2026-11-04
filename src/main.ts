import './style.css';
import './library/workspace.css';
import { PlaudController } from './app/controller.ts';
import { detectDeviceProtocol } from './app/device-protocol.ts';
import { emptyCredentials, importCredentials, validateCredentials } from './auth/credentials.ts';
import type { Credentials } from './auth/credentials.ts';
import { CloudApiError, CloudClient, parseSuccessfulRequestAuthorization, parseWebSessionJson } from './auth/cloud.ts';
import type { CloudDevice, CloudSession, OfficialWebSessionInput } from './auth/cloud.ts';
import { BrowserBleLink, chooseDevice, observeAdvertisement } from './ble/transport.ts';
import { formatBytes } from './protocol/status.ts';
import type { RecordingFile } from './protocol/files.ts';
import { canSaveCompletedDownload, downloadActionLabel, recordingFilesBlocked, recordingFilesHint, recordingFileView, recordingView, transferView } from './ui/recordings.ts';
import type { PlayableRecording } from './audio/ogg.ts';
import { recoverRecording } from './audio/recovery.ts';
import { toWav } from './audio/wav.ts';
import { cloudFailureAction, connectionChoice, connectionProgress, initialFlowState, reduceFlow } from './ui/flow.ts';
import type { ConnectionStep, FlowEvent } from './ui/flow.ts';
import { WorkspaceOverlay } from './ui/workspace-overlay.ts';
import { WorkspacePreferences } from './ui/preferences.ts';
import type { DevicePreference } from './ui/preferences.ts';
import { LibraryWorkspace } from './library/workspace.ts';
import type { DownloadOptions } from './library/workspace.ts';
import { installChatGPTSettings } from './chatgpt/settings.ts';

// 仅复制公开的导出脚本；令牌由用户在官方页面手动导出，不经过聊天或本地存储。
const WEB_SESSION_EXPORT_SCRIPT = String.raw`(() => {
  if (location.hostname !== 'web.plaud.ai') throw Error('请在 PLAUD 官方 Web 页面运行');
  let userToken = localStorage.getItem('pld_tokenstr') || localStorage.getItem('tokenstr');
  try { userToken = JSON.parse(userToken); } catch {}
  if (typeof userToken === 'string') userToken = userToken.trim().replace(/^bearer\s+/i, '');
  let region;
  try { region = JSON.parse(localStorage.getItem('pld_plaud_user_api_domain') || localStorage.getItem('plaud_user_api_domain') || 'null'); } catch {}
  const userApiDomain = region?.domain;
  if (typeof userToken !== 'string' || !userToken || typeof userApiDomain !== 'string') throw Error('请先在官方网页登录');
  if (!/^https:[/]{2}api(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?[.]plaud[.]ai[/]?$/i.test(userApiDomain)) throw Error('官方账号区域无法识别');
  copy(JSON.stringify({ userToken, userApiDomain }));
  console.log('已复制登录态，请仅粘贴到本机 PLAUD 页面');
})()`;
const WEB_SESSION_EXPORT_READY = true;

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="topbar"><a class="brand" href="/" aria-label="PLAUD 录音工作台首页"><span class="brand-mark">p<span></span></span><strong>PLAUD<span>录音工作台</span></strong></a><span class="local-badge"><i></i> 本地运行 · 录音与转写</span></header>
  <main>
    <div class="intro"><div><p class="eyebrow">DEVICE WORKSPACE / 01</p><h1>让设备状态，<br class="mobile-br">触手可及。</h1><p class="intro-copy">在电脑浏览器中连接你的 PLAUD，读取状态并通过蓝牙下载录音。</p></div><span class="edition">本地工作台 <strong>0.1</strong><br>已绑定设备 · 状态与录音文件</span></div>
    <div class="environment" id="environment" role="status"><span class="env-icon">✓</span><span id="env-text">正在检查浏览器环境…</span><span class="env-note">推荐电脑 Chrome / Edge</span></div>
    <div class="workspace">
      <div class="left-column">
        <section class="panel login-panel" aria-labelledby="login-title">
          <div class="section-heading"><div><p class="eyebrow">01 / ACCOUNT</p><h2 id="login-title">登录 PLAUD 账号</h2></div><span id="login-status" class="pill">未登录</span></div>
          <p class="panel-description">使用设备绑定的同一账号登录，选择云端设备后自动准备认证材料，再连接蓝牙。</p>
          <form id="login-form" autocomplete="off">
            <label class="field">邮箱<input id="login-email" type="email" autocomplete="off" spellcheck="false" required placeholder="PLAUD 账号邮箱"></label>
            <label class="field">密码<input id="login-password" type="password" autocomplete="off" required placeholder="PLAUD 账号密码"></label>
            <div class="actions auth-actions"><button id="login" class="primary" type="submit">登录</button></div>
          </form>
          <details id="web-session-import" class="web-session-import"><summary>导入官方 Web 登录态</summary>
            <p class="hint">如果密码登录需要官方验证，可先在官方 Web 完成登录，再把本次登录态导入本机。</p>
            <ol class="session-import-steps">
              <li><a href="https://web.plaud.ai/" target="_blank" rel="noopener noreferrer">打开 PLAUD 官方 Web ↗</a>，使用设备绑定的同一账号登录。</li>
              <li>复制导出脚本，在官方页面的开发者工具 Console 中手动运行。脚本会将两字段 JSON 复制到剪贴板，不会在控制台输出令牌。</li>
              <li>仅粘贴到下面的本机输入框并导入，不发送到聊天或公开分享。</li>
            </ol>
            <button id="copy-session-export" class="text-button" type="button">复制官方登录态导出脚本</button>
            <p id="session-export-notice" class="hint" role="status" aria-live="polite">复制脚本后，请在官方 Web 的 Console 手动运行，再将复制出的 JSON 粘贴到本机输入框。</p>
            <textarea id="session-export-script" class="session-export-script" rows="7" readonly spellcheck="false" aria-label="官方登录态导出脚本" hidden></textarea>
            <form id="web-session-form" autocomplete="off">
              <label class="field">官方登录态 JSON<input id="web-session-json" type="password" autocomplete="off" spellcheck="false" required maxlength="40000" placeholder="仅包含 userToken 和 userApiDomain"></label>
              <div class="actions auth-actions"><button id="import-web-session" class="primary" type="submit">导入本次登录态</button></div>
            </form>
            <details class="web-request-import"><summary>备用：从官方成功请求导入</summary>
              <p class="hint">若上方导入失败，可在官方页面开发者工具 Network 中找到业务成功的 /user-app/profile/account/me 请求，复制 Request Headers 中的 Authorization 值，并填写同一请求的 API 域名。</p>
              <form id="web-request-form" autocomplete="off">
                <label class="field">当前 Authorization<input id="web-request-authorization" type="password" autocomplete="off" spellcheck="false" required maxlength="40000" placeholder="Bearer …"></label>
                <label class="field">该请求的官方 API 域名<input id="web-request-api-domain" type="url" autocomplete="off" spellcheck="false" required value="https://api-euc1.plaud.ai"></label>
                <div class="actions auth-actions"><button id="import-web-request" class="primary" type="submit">验证并导入当前授权</button></div>
              </form>
            </details>
            <p class="hint">导入后会验证用户授权。提交后立即清空输入，不回显令牌；选择“记住登录”后会加密保存在本机文件缓存。</p>
          </details>
          <div id="cloud-account-controls" hidden>
            <p id="cloud-account" class="account-caption"></p>
            <label class="field">账号绑定设备<select id="cloud-device"><option value="">请选择设备</option></select></label>
            <p id="cloud-device-detail" class="hint"></p>
            <div class="actions auth-actions"><button id="logout" class="quiet" type="button">退出登录</button></div>
          </div>
          <p class="hint">自动跟随账号区域。密码提交后清空；登录授权可保存在本机，普通退出保留录音解密材料。</p>
          <p id="cloud-notice" class="inline-notice" role="status" aria-live="polite">正在检查本地登录服务…</p>
        </section>
        <section class="panel device-panel" aria-labelledby="device-title">
          <div class="section-heading"><div><p class="eyebrow">02 / CONNECTION</p><h2 id="device-title">我的设备</h2></div><span class="pill" id="phase">未连接</span></div>
          <div class="device-hero"><div class="note-device" aria-hidden="true"><div class="note-stripes"></div><div class="note-led"></div><span>PLAUD</span><i></i></div><div><p class="device-kicker">PLAUD HARDWARE</p><h3 id="device-name">等待选择设备</h3><p id="device-id">点击下方按钮打开浏览器设备列表</p></div></div>
          <ol class="steps" aria-label="连接进度"><li id="step-select"><b>1</b><span>选择设备</span></li><li id="step-gatt"><b>2</b><span>蓝牙连接</span></li><li id="step-auth"><b>3</b><span>认证并读取</span></li></ol>
          <div class="actions"><button id="choose" class="primary">＋ 搜索 / 选择设备</button><button id="connect">连接设备</button><button id="disconnect" class="quiet">断开</button></div>
          <label class="checkline"><input type="checkbox" id="all-devices"> 显示全部 BLE 设备（仅排查漏搜时使用）</label>
          <p class="hint">默认按广播中的产品号 / 序列号特征查找 PLAUD，支持改名设备，列表会显示 App 中设置的名称。搜索前，请先断开手机 App 与设备的蓝牙连接。</p>
          <div class="stage-line" aria-live="polite"><span id="stage-dot"></span><span id="stage">选择设备后即可连接</span></div>
          <p class="error-message" id="error" role="alert" hidden></p>
        </section>
        <section class="panel auth-panel" aria-labelledby="auth-title">
          <div class="section-heading"><div><p class="eyebrow">03 / AUTHENTICATION</p><h2 id="auth-title">设备认证</h2></div><button id="import" class="text-button">导入 JSON ↗</button><input id="credential-file" type="file" accept="application/json,.json" hidden></div>
          <p class="panel-description">登录后自动准备认证材料。协议版本可从广播确认；手工导入和查看材料请使用高级选项。</p>
          <div class="form-grid">
            <label>协议版本 <span>portVersion</span><input id="port" type="number" min="1" max="65535" step="1" placeholder="从广播或 App 获取"></label>
            <label>设备序列号 <span>SN</span><input id="sn" autocomplete="off" spellcheck="false" placeholder="RSA / ECC 认证必填"></label>
          </div>
          <button id="advertisement" class="text-button broadcast">从设备广播读取版本 / SN ↗</button>
          <p class="protocol-note" id="protocol-note">先填写实际协议版本。设备型号无法单独决定认证方式。</p>
          <details id="manual-auth-details" class="manual-auth-details"><summary>高级认证材料（手工导入／查看）</summary>
          <label class="field">绑定账号 ID <span>通常为 user_id</span><input id="account" type="password" autocomplete="off" spellcheck="false" placeholder="不是邮箱，也不是登录 access_token"></label>
          <label class="field">BLE token <span>可选，优先于账号 ID</span><input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="已有设备握手 token 时填写"></label>
          <div id="rsa-fields" hidden>
            <label class="field">设备 SN 签名 <span>Base64</span><textarea id="rsa-signature" rows="2" spellcheck="false" autocomplete="off" placeholder="snSignature"></textarea></label>
            <label class="field">用户 RSA 公钥 <span>原始 PEM 字符串</span><textarea id="rsa-public" rows="3" spellcheck="false" autocomplete="off" placeholder="-----BEGIN PUBLIC KEY-----"></textarea></label>
            <label class="field">用户 RSA 私钥 <span>PKCS#8 PEM</span><textarea id="rsa-private" rows="3" spellcheck="false" autocomplete="off" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></label>
            <label class="checkline"><input type="checkbox" id="rsa-alternate"> 使用 FE20 签名命令变体（仅已确认需要时）</label>
          </div>
          <div id="ecc-fields" hidden>
            <label class="field">设备长期公钥 <span>65 字节 SEC1，hex</span><textarea id="ecc-device" rows="2" spellcheck="false" autocomplete="off" placeholder="04…"></textarea></label>
            <label class="field">用户 ECC 私钥 <span>32 字节，hex</span><input id="ecc-private" type="password" spellcheck="false" autocomplete="off" placeholder="64 个十六进制字符"></label>
            <p class="hint">支持已绑定设备的 mode 2 重连。若设备要求首次绑定，页面会说明所需云验证步骤。</p>
          </div>
          <details class="advanced"><summary>传统协议扩展握手字段</summary><p class="hint">仅在现有 App 连接记录明确提供这些字段时填写。</p><label class="field">附加字段 R <span>最多 8 字节</span><input id="extra8" type="password" autocomplete="off"></label><label class="field">附加字段 S <span>最多 255 字节</span><input id="extra-text" type="password" autocomplete="off"></label></details>
          <div class="actions auth-actions"><button id="authorize" class="primary">认证并读取</button><button id="clear-credentials" class="quiet">清空认证信息</button></div>
          </details>
          <p class="hint">自动准备失败时可手工导入自己的认证材料。登录 access_token 不会被当作 BLE token；认证材料仅保留在本页内存。</p>
          <p id="auth-notice" class="inline-notice" aria-live="polite"></p>
        </section>
      </div>
      <div class="right-column">
        <section class="panel status-panel" aria-labelledby="status-title">
          <div class="section-heading"><div><p class="eyebrow">04 / LIVE STATUS</p><h2 id="status-title">设备概览</h2></div><button id="refresh" class="text-button">↻ 刷新状态</button></div>
          <p class="panel-description" id="status-caption">设备认证完成后，状态将在这里显示。</p>
          <div class="metrics"><article class="metric"><div class="metric-top"><span>电池电量</span><span aria-hidden="true">▰</span></div><div class="metric-value" id="battery-value">—</div><p id="battery-detail">未读取</p><div class="meter"><span id="battery-meter"></span></div></article><article class="metric"><div class="metric-top"><span>可用存储</span><span aria-hidden="true">▤</span></div><div class="metric-value storage-value" id="storage-value">—</div><p id="storage-detail">未读取</p><div class="meter"><span id="storage-meter"></span></div></article></div>
          <div class="state-card recording-status"><span class="state-icon" aria-hidden="true">≋</span><div><span class="small-label">录音状态</span><strong id="state-value">录音状态待确认</strong></div><div class="recording-clock"><span class="small-label" id="recording-duration-label">最近录音时长</span><strong id="recording-duration">—</strong></div></div>
          <p id="recording-notice" class="hint" role="status" aria-live="polite"></p>
          <dl class="state-details"><div><dt>隐私模式</dt><dd id="privacy">未获取</dd></div><div><dt>USB 状态</dt><dd id="usb">未获取</dd></div><div><dt>场景编号</dt><dd id="scene">未获取</dd></div><div><dt>录音会话 ID</dt><dd id="session">未获取</dd></div><div><dt>Find My token 状态</dt><dd id="findmy">未获取</dd></div><div><dt>HTTP token 状态</dt><dd id="http">未获取</dd></div><div><dt>SNDP 密钥状态</dt><dd id="sndp">未获取</dd></div><div><dt>信号 / eSIM 状态</dt><dd id="signal">未获取</dd></div></dl>
          <p id="state-code" class="raw-state">—</p>
          <p class="last-update" id="last-update">尚无设备数据</p>
        </section>
        <section class="panel recordings-panel" aria-labelledby="recordings-title">
          <div class="section-heading"><div><p class="eyebrow">05 / RECORDINGS</p><h2 id="recordings-title">设备录音文件</h2></div><button id="refresh-files" class="text-button" type="button">↻ 刷新列表</button></div>
          <div class="audio-export-controls"><label for="save-format">恢复文件导出格式<select id="save-format"><option value="ogg" selected>Ogg（默认，保留压缩音频）</option><option value="wav">WAV（仅本机恢复导出）</option></select></label><button id="recover-file" class="quiet" type="button">恢复已下载文件</button><input id="recording-file" type="file" accept=".bin,.ogg,.opus" hidden></div>
          <p class="hint">WAV 在本机解码，体积较大；Ogg 保留压缩音频。恢复加密 .bin 需先准备同一账号的 RSA 认证材料，无需连接设备。文件与私钥不会上传。</p>
          <p id="files-caption" class="panel-description">设备认证完成后可读取录音目录。</p>
          <p id="files-error" class="recording-error" role="alert" hidden></p>
          <p id="files-empty" class="files-empty">尚未读取设备文件</p>
          <div id="files-table-wrapper" class="files-table-wrapper" hidden><table class="files-table"><caption class="sr-only">设备录音目录</caption><thead><tr><th scope="col">会话 ID</th><th scope="col">文件大小</th><th scope="col"><span class="sr-only">下载操作</span></th></tr></thead><tbody id="recording-files"></tbody></table></div>
          <p id="files-updated" class="last-update"></p>
          <div id="transfer-panel" class="transfer-card" hidden>
            <div class="transfer-heading"><strong id="transfer-title">尚无下载</strong><span id="transfer-session" class="code-badge"></span></div>
            <progress id="download-progress" max="100" value="0" aria-label="录音文件下载进度"></progress>
            <div class="transfer-stats"><span id="transfer-bytes">0 B / 0 B</span><span id="transfer-percent">0%</span></div>
            <p id="transfer-notice" class="hint" role="status" aria-live="polite"></p>
            <button id="cancel-download" class="quiet" type="button" hidden>取消下载</button>
          </div>
          <p id="download-save-notice" class="inline-notice" role="status" aria-live="polite" hidden></p>
          <div class="audio-export-actions"><button id="save-fallback-ogg" class="quiet" type="button" hidden>保存 Ogg 文件</button><button id="cancel-audio-export" class="quiet" type="button" hidden>取消导出</button></div>
          <p class="hint">录音或暂停期间暂缓目录与下载。不提供录音控制；文件通过蓝牙传输，不上传录音。</p>
        </section>
        <section class="panel log-panel"><details id="logs-details"><summary><span><span class="eyebrow">ACTIVITY</span><strong>连接与查询日志</strong></span><span id="log-count">0 条</span></summary><div class="log-toolbar"><span>仅记录阶段和命令编号</span><button id="export-logs" class="text-button">导出</button><button id="clear-logs" class="text-button">清空</button></div><ol id="logs" aria-live="polite"></ol></details></section>
        <aside class="scope-note"><span>i</span><p>状态与文件目录来自设备实际响应，未提供的字段显示“未获取”。连接中断后状态会清空；同一设备的单个未完成下载可在本页内存中保留进度。</p></aside>
      </div>
    </div>
    <footer><span>PLAUD BLE WORKSPACE</span><span>本地实验工程 · 非官方客户端</span></footer>
  </main>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const val = (id: string) => input(id).value;
const put = (id: string, value: unknown) => { $(id).textContent = String(value); };
const show = (id: string, yes: boolean) => { $(id).hidden = !yes; };
function installFlowLayout() {
  const old = document.querySelector('.workspace')!;
  const login = document.querySelector('.login-panel')!, devicePanel = document.querySelector('.device-panel')!;
  const auth = document.querySelector('.auth-panel')!, status = document.querySelector('.status-panel')!, recordings = document.querySelector('.recordings-panel')!, logs = document.querySelector('.log-panel')!, scope = document.querySelector('.scope-note')!;
  const dialog = document.createElement('dialog'); dialog.id = 'plaud-dialog'; dialog.className = 'workspace-dialog';
  dialog.setAttribute('aria-labelledby', 'plaud-dialog-title');
  dialog.innerHTML = `<header class="workspace-dialog-header"><div><p>PLAUD</p><h2 id="plaud-dialog-title">连接设备</h2></div><button type="button" data-overlay-close aria-label="关闭弹窗">✕</button></header><div class="flow-root" id="flow-root"></div>`;
  const root = dialog.querySelector('#flow-root')!;
  root.innerHTML = `
    <div class="flow-feedback"><p id="flow-cache-notice" class="hint" role="status" hidden></p></div>
    <section id="flow-restore" class="panel flow-centered"><span class="flow-spinner" aria-hidden="true"></span><h3>正在读取账号信息</h3><p>本机音频功能随时可用，可关闭弹窗继续使用。</p></section>
    <div id="flow-login" class="flow-login" hidden></div>
    <section id="flow-devices" class="panel flow-devices" hidden><div class="section-heading"><div><h3>选择 PLAUD 设备</h3><p id="flow-account-label" class="hint"></p></div><button id="devices-logout" class="text-button" type="button">退出登录</button></div><p class="panel-description">先断开手机 App 与设备的蓝牙连接，再点击连接并在浏览器中授权。</p><div id="device-cards" class="device-cards"></div><p id="device-cards-empty" class="files-empty" hidden>此账号暂无绑定设备。请确认与手机 App 使用同一账号及登录方式。</p><div id="device-connect-slot" class="flow-connect-slot"><button id="flow-connect" class="primary" type="button">连接设备</button></div></section>
    <section id="flow-connecting" class="panel flow-centered" hidden><span class="flow-spinner" aria-hidden="true"></span><h3 id="flow-connecting-name">正在连接设备</h3><p id="flow-connecting-stage" class="panel-description"></p><ol id="flow-progress" class="flow-progress"></ol><p class="hint">可关闭弹窗，连接进度会显示在工作台顶部。</p><button id="flow-cancel" class="quiet" type="button">取消连接</button></section>
    <section id="flow-device-summary" hidden><div class="overlay-device-actions"><button id="flow-switch-device" class="quiet" type="button">切换设备</button><span id="workspace-disconnect-slot"></span></div><div id="workspace-overview"></div></section>
    <section id="flow-workspace" class="settings-stack" hidden><section class="panel settings-transcription"><div class="section-heading"><h3>转写设置</h3></div><label class="field">转写语言<select id="transcription-language"><option value="zh">中文 / 中英混说</option><option value="en">English</option></select></label><p class="hint">用于新的导入、设备下载和手动转写，不改变已有稿件。</p></section><section class="panel"><div class="section-heading"><h3>账号与本机数据</h3></div><p id="settings-account" class="panel-description"></p><p id="settings-persistence" class="hint"></p><div id="settings-account-actions" class="actions"><button id="settings-login" class="quiet" type="button">登录 PLAUD</button><button id="forget-local-data" class="quiet" type="button">移除账号授权与解密材料</button></div><p class="hint">普通退出保留加密的历史录音密钥。移除解密材料后，旧设备文件可能无法解密。音频与转写文件请在录音列表中管理。</p></section><details id="settings-diagnostics" class="settings-diagnostics"><summary>高级设置与连接诊断</summary><p class="hint">协议、认证材料与日志用于排查连接问题。</p><div id="diagnostic-panels" class="settings-stack"></div></details><details class="settings-diagnostics"><summary>设备原始文件恢复</summary><div id="workspace-recordings"></div></details><details class="settings-diagnostics settings-local-files"><summary>本地文件与处理环境</summary><div><p id="settings-audio-environment" class="hint">正在读取本机环境…</p><code id="settings-audio-storage"></code><p class="hint">每条录音单独保存音频和转写文件。本机导入最大 1 GiB / 6 小时；设备源文件最大 256 MiB，默认保留 Ogg。</p></div></details></section>
    <div id="flow-internal" hidden></div>`;
  old.replaceWith(dialog);
  $('flow-login').append(login); $('workspace-overview').append(status); $('workspace-recordings').append(recordings);
  $('flow-devices').append($('environment'));
  $('diagnostic-panels').append(devicePanel, auth, logs, scope);
  $('settings-account-actions').prepend($('logout'));
  $('flow-internal').append($('cloud-account-controls'));
  $('workspace-disconnect-slot').append($('disconnect'));
  $('flow-root').prepend($('cloud-notice'));
  const details = document.querySelector('.state-details')!, rawState = $('state-code'); devicePanel.append(details, rawState);
  const remember = document.createElement('label'); remember.className = 'checkline remember-account';
  remember.innerHTML = '<input id="remember-account" type="checkbox" checked>记住登录（不保存密码）';
  login.querySelector('.panel-description')!.after(remember);
  const settings = document.createElement('button'); settings.id = 'flow-open-settings'; settings.className = 'text-button topbar-settings'; settings.type = 'button'; settings.textContent = '设置 / 诊断';
  document.querySelector('.topbar')!.insertBefore(settings, document.querySelector('.local-badge'));
  login.querySelector('.panel-description')!.textContent = '连接 PLAUD 设备需要登录。本机音频的导入与转写无需登录。';
  const loginHints = login.querySelectorAll<HTMLElement>(':scope > .hint');
  for (const hint of loginHints) hint.textContent = '密码提交后立即清空；记住登录会加密保存授权，不保存密码。';
  const importHint = $('web-session-import').querySelector<HTMLElement>(':scope > p:last-child');
  if (importHint) importHint.textContent = '提交后清空输入并验证授权。选择记住账号时，本地服务会加密保存授权与录音密钥；不会保存密码。';
}
installFlowLayout();
const logs: { time: string; message: string }[] = [];
function log(message: string) {
  const entry = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), message };
  logs.push(entry); if (logs.length > 200) logs.shift();
  $('logs').replaceChildren(...logs.map(row => {
    const li = document.createElement('li'), time = document.createElement('time'), content = document.createElement('span');
    time.textContent = row.time; content.textContent = row.message; li.append(time, content); return li;
  }));
  put('log-count', `${logs.length} 条`);
}
let device: BluetoothDevice | undefined;
const supported = !!navigator.bluetooth && isSecureContext;
let choosing = false, watching = false, stopAdvertisement: (() => void) | undefined;
let advertisementTimer: ReturnType<typeof setTimeout> | undefined;
const cloud = new CloudClient();
let cloudSession: CloudSession | undefined, cloudBusy = false, cloudGeneration = 0, cloudOperation = 0;
let usingCloudCredentials = false;
let preparedCloudDevice: { serialNumber: string; portVersion?: number } | undefined;
let recordingClock: ReturnType<typeof setInterval> | undefined;
let pageActive = true;
let renderedFiles: RecordingFile[] | undefined;
let downloadGeneration = 0;
let downloadSaveNotice = '';
let audioExportBusy = false, audioExportCancelled = false;
let fallbackOgg: { recording: PlayableRecording; generation: number } | undefined;
let wasConnected = false;
let flow = initialFlowState();
const overlay = new WorkspaceOverlay($<HTMLDialogElement>('plaud-dialog'), () => {
  if (!overlay.current) { input('login-password').value = ''; clearOfficialSessionInputs(); }
  render();
});
let rsaPrivateKeyHistory: string[] = [];
const preferences = new WorkspacePreferences(location.origin);
const devicePreferences = new Map<string, DevicePreference>();
const authorizedDevices = new Map<string, BluetoothDevice>();
const cloudDeviceCards = new Map<string, HTMLButtonElement>();
let renderedCloudDevices: CloudDevice[] | undefined;
let chosenFor: { accountId: string; serialNumber: string } | undefined;
let rememberOperation = -1;
let accountPreferencesGeneration = 0;
let controllerFlowOperation: number | undefined, controllerFlowStarted = false;
let protocolDetection: AbortController | undefined;
let protocolDetectionStage = '';
let selectionRevision = 0, audioFormatRevision = 0;
const recordingFileButtons = new Map<number, HTMLButtonElement>();
const controller = new PlaudController(render, log);
const libraryWorkspace = new LibraryWorkspace({
  parent: document.querySelector('main')!,
  onVisibility: visible => { document.body.classList.toggle('library-open', visible); },
  onDownload: (sessionId, options) => downloadRecording(sessionId, options),
  onCancelDownload: () => controller.cancelDownload(),
  onRefreshDevice: () => { void controller.listFiles(); },
  onOpenSettings: section => { overlay.open('settings'); void chatgptSettings.check(); if (section === 'chatgpt') chatgptSettings.focus(); },
  onOpenDevice: () => overlay.open('device'),
  onDisconnectDevice: () => { invalidateAudioExport(); controller.disconnect(); },
  onSwitchDevice: () => switchDevice(),
  onLogout: () => { void logoutAccount(); },
  onEnvironment: environment => {
    put('settings-audio-environment', environment.available ? '本机转写环境已准备。自动稿仍需回听核对。' : `录音可先保存。转写环境待准备：${environment.missing.join('、')}`);
    put('settings-audio-storage', environment.storageRoot || '项目录音目录');
  },
});
const chatgptSettings = installChatGPTSettings($('flow-workspace'));
$<HTMLSelectElement>('transcription-language').value = libraryWorkspace.transcriptionLanguage;
$('transcription-language').addEventListener('change', () => libraryWorkspace.setTranscriptionLanguage($<HTMLSelectElement>('transcription-language').value as 'zh' | 'en'));
const deviceEntry = document.createElement('button'); deviceEntry.className = 'text-button'; deviceEntry.textContent = '设备'; deviceEntry.type = 'button'; deviceEntry.id = 'open-device'; deviceEntry.onclick = () => overlay.open('device'); document.querySelector('.topbar')!.insertBefore(deviceEntry, $('flow-open-settings')); document.querySelector('.topbar')!.insertBefore($('open-library'), deviceEntry);
function transition(event: FlowEvent) { flow = reduceFlow(flow, event); return flow; }
function currentFlow() { return flow; }
function cacheNotice(message: string) { put('flow-cache-notice', message); show('flow-cache-notice', !!message); }
async function prefetchAuthorizedDevices() {
  if (!supported) return;
  const bluetooth = navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> };
  if (!bluetooth.getDevices) return;
  try { for (const row of await bluetooth.getDevices()) authorizedDevices.set(row.id, row); }
  catch { /* Permission inventory is optional; a click can always open the chooser. */ }
}
async function loadAccountPreferences() {
  const accountId = cloudSession?.account?.accountId;
  if (!accountId) return;
  const generation = ++accountPreferencesGeneration;
  const selection = selectionRevision, formatSelection = audioFormatRevision, preparation = cloudGeneration;
  const [bindings, format] = await Promise.all([preferences.loadDevices(accountId), preferences.loadAudioFormat(accountId)]);
  if (generation !== accountPreferencesGeneration || cloudSession?.account?.accountId !== accountId) return;
  devicePreferences.clear(); for (const binding of bindings) devicePreferences.set(binding.serialNumber, binding);
  if (formatSelection === audioFormatRevision && !audioExportBusy && !controller.snapshot.busy) $<HTMLSelectElement>('save-format').value = format;
  const recent = bindings.find(row => cloudSession?.devices?.some(device => device.serialNumber === row.serialNumber))?.serialNumber
    || [...(cloudSession?.devices ?? [])].sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0))[0]?.serialNumber;
  const selected = flow.selectedSerialNumber || recent;
  if (selected && selection === selectionRevision && preparation === cloudGeneration && flow.connection === 'offline' && !controller.connected && !controller.snapshot.busy && !choosing && !watching && !cloudBusy) {
    $<HTMLSelectElement>('cloud-device').value = selected; selectCloudDevice();
  }
  if (!preferences.persistent) cacheNotice('浏览器未允许保存设备偏好，本页仍可正常连接；刷新后可能需要重新选择设备。');
}
function rememberConnectedDevice(operation: number) {
  const accountId = cloudSession?.account?.accountId, row = selectedCloudDevice(), port = config().portVersion;
  if (rememberOperation === operation || !accountId || !row || !device || !port || controller.snapshot.phase !== 'ready') return;
  rememberOperation = operation;
  const serialNumber = row.serialNumber, browserDeviceId = device.id;
  const preference = { origin: location.origin, accountId, serialNumber, browserDeviceId, verifiedPortVersion: port, lastUsed: Date.now() };
  devicePreferences.set(serialNumber, preference); authorizedDevices.set(device.id, device);
  void Promise.allSettled([
    preferences.rememberDevice(accountId, serialNumber, browserDeviceId, port),
    cloud.rememberDevice(serialNumber, port, row.firmware),
  ]).then(results => {
    if (cloudSession?.account?.accountId !== accountId || flow.workspaceSerialNumber !== serialNumber) return;
    const [browser, server] = results;
    if (server.status === 'fulfilled' && server.value.authenticated) { cloudSession = server.value; renderCloudSession(); }
    if (browser.status === 'rejected' || browser.value === false || server.status === 'rejected') cacheNotice('设备已连接，但本次连接信息未能完整保存。连接可继续使用；下次可能需要重新选择设备。');
    render();
  });
}
function updateFlowFromController() {
  const s = controller.snapshot;
  if (flow.connection !== 'connecting' || controllerFlowOperation !== flow.operation) return;
  if (s.phase === 'connecting' || s.phase === 'gatt' || s.phase === 'authenticating') controllerFlowStarted = true;
  if (!controllerFlowStarted) return;
  if (s.phase === 'ready') {
    const ready = transition({ type: 'connect-ready', operation: flow.operation, serialNumber: selectedCloudDevice()?.serialNumber || '' });
    if (ready.connection === 'ready') { rememberConnectedDevice(ready.operation); if (overlay.current === 'device') overlay.close(); }
  } else if (s.phase === 'error' || s.phase === 'credentials') transition({ type: 'connect-error', operation: flow.operation, message: s.error || '连接未完成，请重试。' });
  else {
    const step: ConnectionStep = /读取.*状态|确认认证/.test(s.stage) ? 'reading' : s.phase === 'authenticating' ? 'authenticating' : 'gatt';
    transition({ type: 'connect-progress', operation: flow.operation, step });
  }
}
function renderFlow(blocked: boolean) {
  if (cloudSession?.persistence?.available === false) cacheNotice(cloudSession.persistence.error || '本机文件缓存不可用，本次登录未被记住。关闭服务后可能需要重新登录。');
  const settings = overlay.current === 'settings', restoring = flow.screen === 'restore';
  const connected = controller.snapshot.phase === 'ready', connecting = flow.connection === 'connecting';
  const authenticated = cloudSession?.authenticated === true;
  document.body.dataset.screen = 'workspace';
  put('plaud-dialog-title', settings ? '设置与诊断' : restoring ? 'PLAUD 账号' : connecting ? '正在连接设备' : connected ? '设备详情' : authenticated ? '连接 PLAUD 设备' : '登录 PLAUD');
  show('flow-restore', !settings && restoring);
  show('flow-login', !settings && !restoring && !authenticated);
  show('flow-devices', !settings && !restoring && authenticated && !connecting && !connected);
  show('flow-connecting', !settings && connecting);
  show('flow-device-summary', !settings && connected && !connecting);
  show('flow-workspace', settings);
  show('cloud-notice', cloudBusy || $('cloud-notice').dataset.error === 'true');
  $<HTMLButtonElement>('flow-open-settings').disabled = false;
  put('flow-account-label', `${cloudSession?.account?.email || '已登录账号'}${cloudSession?.offline ? ' · 当前使用本机缓存' : ''}`);
  put('settings-account', authenticated ? `当前账号 · ${cloudSession?.account?.email || '已登录账号'}` : '当前未登录。导入、播放和本地转写无需 PLAUD 账号。');
  put('settings-persistence', cloudSession?.persistence?.available ? (cloudSession.persistence.hasSavedAccount ? '账号与录音密钥已加密保存在本机。' : '本机文件缓存可用，当前账号未选择持久保存登录。') : '登录授权可选择加密保存在本机。');
  $('logout').hidden = !authenticated; show('settings-login', !authenticated);
  show('forget-local-data', authenticated || !!cloudSession?.persistence?.hasSavedAccount);
  $<HTMLButtonElement>('settings-login').disabled = restoring || cloudBusy;
  $<HTMLButtonElement>('forget-local-data').disabled = blocked;
  $<HTMLButtonElement>('devices-logout').disabled = blocked;
  put('flow-connecting-name', `正在连接 ${selectedCloudDevice()?.name || 'PLAUD 设备'}`);
  put('flow-connecting-stage', flow.step === 'choosing' ? '请在浏览器列表中选择同一台设备。' : flow.step === 'preparing' ? protocolDetectionStage || '正在准备账号与设备认证材料…' : controller.snapshot.stage);
  const rows = cloudSession?.devices;
  if (renderedCloudDevices !== rows) {
    renderedCloudDevices = rows; cloudDeviceCards.clear();
    $('device-cards').replaceChildren(...(rows ?? []).map(row => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'device-card';
      const icon = document.createElement('span'); icon.className = 'device-card-icon'; icon.textContent = '▤'; icon.setAttribute('aria-hidden', 'true');
      const content = document.createElement('span'), name = document.createElement('strong'), model = document.createElement('small'), detail = document.createElement('small');
      name.textContent = row.name || 'PLAUD 设备'; model.textContent = row.model || '已绑定设备'; detail.textContent = `SN 尾号 ${row.serialNumber.slice(-4)}${row.firmware ? ` · 固件 ${row.firmware}` : ''}`;
      content.append(name, model, detail); button.append(icon, content);
      button.addEventListener('click', () => { $<HTMLSelectElement>('cloud-device').value = row.serialNumber; selectCloudDevice(true); render(); });
      cloudDeviceCards.set(row.serialNumber, button); return button;
    }));
  }
  for (const [serialNumber, card] of cloudDeviceCards) { card.classList.toggle('selected', serialNumber === flow.selectedSerialNumber); card.setAttribute('aria-pressed', String(serialNumber === flow.selectedSerialNumber)); card.disabled = blocked || controller.connected; }
  show('device-cards-empty', !rows?.length);
  $<HTMLButtonElement>('flow-switch-device').disabled = blocked;
  const connect = $<HTMLButtonElement>('flow-connect');
  connect.textContent = flow.workspaceSerialNumber === flow.selectedSerialNumber ? '重新连接' : '连接设备';
  connect.disabled = !supported || blocked || !selectedCloudDevice() || flow.connection !== 'offline';
  $('flow-progress').replaceChildren(...connectionProgress(flow).map(row => { const li = document.createElement('li'); li.dataset.status = row.status; li.textContent = row.label; return li; }));
  if (flow.error) { put('cloud-notice', flow.error); $('cloud-notice').dataset.error = 'true'; }
  libraryWorkspace.updateAccount({ authenticated, restoring, accountId: cloudSession?.account?.accountId, email: cloudSession?.account?.email, busy: blocked, connecting, error: flow.error });
}
function invalidateAudioExport() {
  downloadGeneration++; fallbackOgg = undefined;
  downloadSaveNotice = audioExportBusy ? '导出已取消，正在释放本机转换资源。' : '';
  if (audioExportBusy) audioExportCancelled = true;
}
function activeAudioExport(generation: number) { return pageActive && generation === downloadGeneration; }
function startAudioExport(message: string) {
  audioExportBusy = true; audioExportCancelled = false; fallbackOgg = undefined;
  downloadSaveNotice = message; render();
}
function finishAudioExport() {
  if (audioExportCancelled) downloadSaveNotice = '本次导出已取消。';
  audioExportBusy = false; audioExportCancelled = false; render();
}
function config(): Credentials {
  const portText = val('port').trim(), port = portText ? Number(portText) : undefined;
  return {
    portVersion: port, accountId: val('account').trim(), bindingToken: val('token').trim(), serialNumber: val('sn').trim(),
    rsa: { snSignature: val('rsa-signature').trim(), publicKeyPem: val('rsa-public').trim(), privateKeyPem: val('rsa-private').trim(), privateKeyHistory: [...rsaPrivateKeyHistory], alternateCommand: input('rsa-alternate').checked },
    ecc: { devicePublicKeyHex: val('ecc-device').trim(), userPrivateKeyHex: val('ecc-private').trim() },
    secondHandshake: { extra8: val('extra8'), extraText: val('extra-text') },
  };
}
function fill(c: Credentials) {
  rsaPrivateKeyHistory = [...(c.rsa.privateKeyHistory ?? [])];
  input('port').value = c.portVersion?.toString() ?? ''; input('sn').value = c.serialNumber;
  input('account').value = c.accountId; input('token').value = c.bindingToken;
  input('rsa-signature').value = c.rsa.snSignature; input('rsa-public').value = c.rsa.publicKeyPem; input('rsa-private').value = c.rsa.privateKeyPem;
  input('rsa-alternate').checked = c.rsa.alternateCommand;
  input('ecc-device').value = c.ecc.devicePublicKeyHex; input('ecc-private').value = c.ecc.userPrivateKeyHex;
  input('extra8').value = c.secondHandshake.extra8; input('extra-text').value = c.secondHandshake.extraText;
  renderProtocol();
}
function selectedCloudDevice(): CloudDevice | undefined {
  const serialNumber = $<HTMLSelectElement>('cloud-device').value;
  return cloudSession?.authenticated ? cloudSession.devices?.find(row => row.serialNumber === serialNumber) : undefined;
}
function clearOfficialSessionInputs() { input('web-session-json').value = ''; input('web-request-authorization').value = ''; }
function renderCloudSession() {
  const authenticated = cloudSession?.authenticated === true;
  show('login-form', !authenticated); show('cloud-account-controls', authenticated);
  show('web-session-import', !authenticated);
  if (authenticated) clearOfficialSessionInputs();
  put('login-status', authenticated ? '已登录' : '未登录');
  $('login-status').dataset.phase = authenticated ? 'ready' : 'idle';
  put('cloud-account', authenticated ? `当前账号 · ${cloudSession?.account?.email || '已登录账号'}` : '');
  const selector = $<HTMLSelectElement>('cloud-device'), previous = selector.value;
  const placeholder = document.createElement('option'); placeholder.value = '';
  placeholder.textContent = authenticated && !cloudSession?.devices?.length ? '此账号暂无可用的绑定设备' : '请选择设备';
  selector.replaceChildren(placeholder);
  for (const row of cloudSession?.devices ?? []) {
    const option = document.createElement('option'); option.value = row.serialNumber;
    option.textContent = `${row.name || row.model || 'PLAUD 设备'} · SN 尾号 ${row.serialNumber.slice(-4)}`;
    selector.append(option);
  }
  if (cloudSession?.devices?.some(row => row.serialNumber === previous)) selector.value = previous;
  else if (cloudSession?.devices?.length === 1) selector.value = cloudSession.devices[0].serialNumber;
  renderCloudDeviceDetail();
  void libraryWorkspace.refreshIdentity();
}
function renderCloudDeviceDetail() {
  const row = selectedCloudDevice();
  put('cloud-device-detail', row ? `${row.model || '已绑定设备'}${row.portVersion ? ` · 云端记录协议版本 ${row.portVersion}` : ' · 请从设备广播确认协议版本'}。升级固件后请重新读取广播核对版本。` : '请选择你要连接的同一台设备。');
}
function useManualCredentials() {
  cloudGeneration++; usingCloudCredentials = false; preparedCloudDevice = undefined; rsaPrivateKeyHistory = [];
  $<HTMLSelectElement>('cloud-device').value = '';
  renderCloudDeviceDetail(); render();
}
function clearCloudMaterials() {
  usingCloudCredentials = false; preparedCloudDevice = undefined;
  clearOfficialSessionInputs();
  fill(emptyCredentials());
}
function cloudFailure(e: unknown) {
  const error = e instanceof CloudApiError ? e : new CloudApiError('REQUEST_FAILED');
  if (error.code === 'PREPARATION_CANCELLED') return;
  const action = cloudFailureAction(error.code, error.status, controller.connected && controller.snapshot.phase === 'ready');
  if (action === 'keep-device' && cloudSession) {
    cloudSession = { ...cloudSession, offline: true };
    cacheNotice(error.code === 'CSRF_REJECTED' ? '本地登录校验已更新。当前设备连接继续可用；账号操作请重新提交。' : '云端登录需要更新。当前设备与本机录音密钥继续可用，可稍后重新登录。');
  }
  if (action === 'login' && cloudSession?.authenticated) {
    cloudGeneration++; cloudSession = undefined; clearCloudMaterials();
    accountPreferencesGeneration++; devicePreferences.clear(); chosenFor = undefined; transition({ type: 'logout' });
    invalidateAudioExport(); controller.disconnect(true); renderCloudSession();
  }
  if (flow.screen === 'login' || flow.screen === 'restore') transition({ type: 'restore-error', message: error.message });
  put('cloud-notice', error.message); $('cloud-notice').dataset.error = 'true';
  log(`账号操作未完成 · ${error.code}`);
}
function portForCloudPreparation(): number | undefined {
  const text = val('port').trim();
  if (!text) return;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CloudApiError('INVALID_PROTOCOL_VERSION', 0, '协议版本应为 1–65535 的整数。');
  return port;
}
function beginCloudOperation() { const operation = ++cloudOperation; cloudBusy = true; render(); return operation; }
function finishCloudOperation(operation: number) { if (operation === cloudOperation) { cloudBusy = false; render(); } }
function acceptCloudLogin(session: CloudSession, imported = false): boolean {
  if (!session.authenticated || !session.account?.accountId) throw new CloudApiError('INVALID_SESSION', 0, '登录响应缺少有效账号身份，请重新登录。');
  clearCloudMaterials(); cloudSession = session; renderCloudSession();
  transition({ type: 'session', accountId: session.account.accountId, deviceSerialNumbers: session.devices?.map(row => row.serialNumber) });
  chosenFor = undefined; device = undefined; devicePreferences.clear();
  void loadAccountPreferences().then(render);
  usingCloudCredentials = !!selectedCloudDevice();
  put('cloud-notice', session.devices?.length ? (imported ? '官方 Web 登录态已验证并导入，请选择要连接的账号绑定设备。' : '已登录，请选择你要连接的账号绑定设备。') : '账号授权已验证，但当前账号未返回绑定设备。请确认手机 App 与官方 Web 使用同一账号及登录方式。');
  log(imported ? '官方 Web 登录态导入成功' : 'PLAUD 账号登录成功');
  return usingCloudCredentials;
}
async function importOfficialSession(payload: OfficialWebSessionInput) {
  const generation = ++cloudGeneration, operation = beginCloudOperation();
  put('cloud-notice', '正在校验官方 Web 登录态并读取账号绑定设备…'); $('cloud-notice').dataset.error = 'false'; log('正在导入官方 Web 登录态');
  try {
    const session = await cloud.importSession(payload, input('remember-account').checked);
    if (generation !== cloudGeneration) return;
    acceptCloudLogin(session, true);
  } catch (e) { if (generation === cloudGeneration) cloudFailure(e); }
  finally { finishCloudOperation(operation); }
}
async function prepareCloudCredentials(): Promise<void> {
  const row = selectedCloudDevice();
  if (!row) throw new CloudApiError('DEVICE_REQUIRED', 0, '请先选择账号绑定设备。');
  const port = portForCloudPreparation(), generation = ++cloudGeneration;
  const operation = beginCloudOperation(); put('cloud-notice', '正在准备所选设备的认证材料…');
  $('cloud-notice').dataset.error = 'false'; log('正在准备所选设备的认证材料');
  try {
    const result = await cloud.prepare(row.serialNumber, port);
    if (generation !== cloudGeneration) throw new CloudApiError('PREPARATION_CANCELLED', 0, '设备准备已取消，请重新选择设备。');
    if (result.credentials.serialNumber !== row.serialNumber || result.device.serialNumber !== row.serialNumber) throw new CloudApiError('DEVICE_MISMATCH', 0, '返回的认证材料与所选设备不一致，请重新登录后重试。');
    if (port !== undefined && result.credentials.portVersion !== port) throw new CloudApiError('PROTOCOL_MISMATCH', 0, '返回的协议版本与当前设置不一致，请重新读取广播确认。');
    fill(result.credentials);
    try { validateCredentials(config()); }
    catch (e) { throw new CloudApiError('CREDENTIALS_INCOMPLETE', 0, e instanceof Error ? e.message : '认证材料尚未齐全。'); }
    preparedCloudDevice = { serialNumber: row.serialNumber, portVersion: result.credentials.portVersion };
    usingCloudCredentials = true;
    put('cloud-notice', result.source === 'cache' ? '已从本机加密缓存准备认证材料。' : '设备认证材料已就绪。');
    log('设备认证材料已就绪');
  } finally { finishCloudOperation(operation); }
}
function selectCloudDevice(userInitiated = false) {
  if (userInitiated) selectionRevision++;
  cloudGeneration++; preparedCloudDevice = undefined;
  const row = selectedCloudDevice(); usingCloudCredentials = !!row;
  renderCloudDeviceDetail();
  if (!row) { fill(emptyCredentials()); render(); return; }
  transition({ type: 'select-device', serialNumber: row.serialNumber });
  const c = emptyCredentials(); c.serialNumber = row.serialNumber; c.accountId = cloudSession?.account?.accountId ?? '';
  c.portVersion = row.portVersion ?? (!row.firmware ? devicePreferences.get(row.serialNumber)?.verifiedPortVersion : undefined);
  fill(c);
  put('cloud-notice', '选择设备后点击“连接设备”，工作台会自动准备认证并连接蓝牙。');
  $('cloud-notice').dataset.error = 'false';
}
async function restoreCloudSession() {
  const generation = cloudGeneration;
  try {
    const session = await cloud.session();
    if (generation !== cloudGeneration) return;
    cloudSession = session; renderCloudSession(); usingCloudCredentials = !!selectedCloudDevice();
    transition({ type: 'session', accountId: session.authenticated ? session.account?.accountId : undefined, deviceSerialNumbers: session.devices?.map(row => row.serialNumber) });
    if (session.authenticated) await loadAccountPreferences();
    put('cloud-notice', session.authenticated ? (session.offline ? '当前使用本机保存的账号与设备信息，可尝试直接连接。' : '已恢复账号与设备。选择设备即可连接。') : '登录 PLAUD 账号，开始连接你的设备。');
  } catch (e) { if (generation === cloudGeneration) cloudFailure(e); }
  finally { render(); }
}
function renderProtocol() {
  const p = Number(val('port'));
  show('rsa-fields', p === 20); show('ecc-fields', p === 30);
  put('protocol-note', p === 20 ? 'RSA 认证 · port 20：需要 SN 签名与用户 RSA 密钥。' : p === 30 ? 'ECC 认证 · port 30：支持已绑定设备的本地重连。' : p > 0 ? `传统 token 认证 · port ${p}：使用 ${p >= 9 ? 32 : 16} 字符 token。` : '先填写实际协议版本。设备型号无法单独决定认证方式。');
}
function renderRecordingClock() {
  const view = recordingView(controller.snapshot.recording, Date.now());
  put('recording-duration', view.duration); put('recording-duration-label', view.durationLabel);
  libraryWorkspace.updateDeviceClock(view.duration);
}
function stopRecordingClock() { clearInterval(recordingClock); recordingClock = undefined; }
function syncRecordingClock() {
  const recording = controller.snapshot.recording;
  if (!pageActive || document.hidden || recording.mode !== 'recording' || recording.durationMs === undefined) { stopRecordingClock(); return; }
  if (!recordingClock) recordingClock = setInterval(renderRecordingClock, 1000);
}
function renderRecordings(blocked: boolean) {
  const s = controller.snapshot, ready = s.phase === 'ready';
  const unavailable = blocked || !ready || recordingFilesBlocked(s.recording);
  const recording = recordingView(s.recording, Date.now()), transfer = transferView(s.transfer);
  put('state-value', recording.label); $('state-value').dataset.mode = s.recording.mode;
  renderRecordingClock(); syncRecordingClock();
  put('scene', recording.scene); put('session', recording.session);
  const recordingNotice = s.recording.error || (s.recording.mode === 'recording' || s.recording.mode === 'paused'
    ? `${s.recording.durationMs === undefined ? '设备尚未提供录音时长。' : ''}录音或暂停期间，文件目录和下载暂缓。`
    : '录音状态来自设备响应与通知；时长仅在设备提供后显示。');
  put('recording-notice', recordingNotice); $('recording-notice').dataset.error = String(!!s.recording.error);
  put('files-caption', recordingFilesHint(s.recording, ready));
  $<HTMLButtonElement>('refresh-files').disabled = unavailable || !!s.files.loading;
  put('files-error', s.files.error || ''); show('files-error', !!s.files.error);
  put('files-empty', s.files.loading ? '正在读取设备录音目录…' : s.files.data ? '设备目录中暂无录音文件' : '尚未读取设备文件');
  show('files-empty', !s.files.data?.length); show('files-table-wrapper', !!s.files.data?.length);
  $('recording-files').setAttribute('aria-busy', String(!!s.files.loading));
  if (renderedFiles !== s.files.data) {
    renderedFiles = s.files.data; recordingFileButtons.clear();
    const rows = (s.files.data ?? []).map(file => {
      const view = recordingFileView(file), row = document.createElement('tr');
      const id = document.createElement('td'), size = document.createElement('td'), action = document.createElement('td');
      const identifier = document.createElement('strong'); identifier.className = 'recording-file-id'; identifier.textContent = view.id; id.append(identifier);
      if (view.metadata) { const metadata = document.createElement('small'); metadata.textContent = view.metadata; id.append(metadata); }
      size.className = 'recording-file-size'; size.textContent = formatBytes(BigInt(file.size)); size.title = `${file.size.toLocaleString('zh-CN')} B`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'recording-download';
      button.setAttribute('aria-label', `下载会话 ${view.id} 的录音文件`);
      button.addEventListener('click', () => { void downloadRecording(file.sessionId, { transcribe: true, language: libraryWorkspace.transcriptionLanguage }); });
      const only = document.createElement('button'); only.type = 'button'; only.className = 'recording-download quiet'; only.textContent = '仅下载 Ogg'; only.dataset.downloadOnly = String(file.sessionId); only.onclick = () => { void downloadRecording(file.sessionId, { transcribe: false, language: libraryWorkspace.transcriptionLanguage }); }; action.append(only);
      recordingFileButtons.set(file.sessionId, button); action.append(button); row.append(id, size, action); return row;
    });
    $('recording-files').replaceChildren(...rows);
  }
  for (const [sessionId, button] of recordingFileButtons) {
    button.disabled = unavailable; button.textContent = downloadActionLabel(sessionId, s.transfer).replace(/^下载$/, '下载并转写');
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-download-only]')) button.disabled = unavailable;
  const row = selectedCloudDevice();
  libraryWorkspace.updateDevice({ deviceId: row?.serialNumber, name: row?.name || device?.name || '尚未连接设备', connected: ready, canDownload: ready && !recordingFilesBlocked(s.recording) && !!cloudSession?.authenticated, busy: blocked, status: recording.label, duration: recording.duration, battery: s.battery.data?.level, files: s.files.data || [], transfer: s.transfer, hint: ready ? recordingFilesHint(s.recording, true) : flow.connection === 'connecting' ? '设备连接中…' : '连接设备以读取录音，本机录音仍可使用' });
  put('files-updated', s.files.updated ? `目录更新于 ${new Date(s.files.updated).toLocaleTimeString('zh-CN', { hour12: false })} · ${s.files.data?.length ?? 0} 个文件` : '');
  show('transfer-panel', s.transfer.phase !== 'idle');
  put('transfer-title', transfer.label); put('transfer-session', s.transfer.sessionId === undefined ? '' : `ID ${s.transfer.sessionId}`);
  $<HTMLProgressElement>('download-progress').value = transfer.percent;
  put('transfer-bytes', `${transfer.received.toLocaleString('zh-CN')} B / ${transfer.total.toLocaleString('zh-CN')} B`);
  put('transfer-percent', `${Math.floor(transfer.percent)}%`);
  put('transfer-notice', transfer.detail); $('transfer-notice').dataset.error = String(!!s.transfer.error);
  show('cancel-download', transfer.canCancel || transfer.cancelling);
  $<HTMLButtonElement>('cancel-download').disabled = !transfer.canCancel;
  put('cancel-download', transfer.cancelling ? '正在取消…' : '取消下载');
  put('download-save-notice', downloadSaveNotice); show('download-save-notice', !!downloadSaveNotice);
  show('save-fallback-ogg', !!fallbackOgg); $<HTMLButtonElement>('save-fallback-ogg').disabled = blocked;
  show('cancel-audio-export', audioExportBusy); $<HTMLButtonElement>('cancel-audio-export').disabled = audioExportCancelled;
  put('cancel-audio-export', audioExportCancelled ? '正在结束转换…' : '取消导出');
  $<HTMLButtonElement>('recover-file').disabled = blocked;
  $<HTMLSelectElement>('save-format').disabled = blocked;
  input('recording-file').disabled = blocked;
}
function saveRecording(recording: PlayableRecording, generation: number): boolean {
  if (!activeAudioExport(generation)) return false;
  const blob = new Blob([new Uint8Array(recording.data)], { type: recording.mimeType });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = recording.filename; anchor.hidden = true; document.body.append(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return true;
}
async function exportRecording(recording: PlayableRecording, generation: number, saveFormat: string, saveRaw: boolean) {
  if (!activeAudioExport(generation)) return;
  if (recording.format === 'raw' && !saveRaw) {
    downloadSaveNotice = recording.notice || '此文件尚未恢复为可播放音频。请确认文件完整，并已准备同一账号的 RSA 认证材料。'; return;
  }
  let output = recording;
  if (recording.format === 'ogg' && saveFormat === 'wav') {
    try { output = await toWav(recording); }
    catch (e) {
      if (!activeAudioExport(generation)) return;
      fallbackOgg = { recording, generation };
      downloadSaveNotice = `${e instanceof Error ? e.message : 'WAV 转换未完成。'}已保留完整 Ogg，可点击“保存 Ogg 文件”。`; return;
    }
  }
  if (!activeAudioExport(generation)) return;
  if (saveRecording(output, generation)) {
    const format = output.format === 'wav' ? 'WAV' : output.format === 'ogg' ? 'Ogg' : '原始';
    downloadSaveNotice = `${format}文件已交给浏览器保存。${output.notice || (output.format === 'raw' ? '此文件仍为设备原始数据，尚未恢复为可播放音频。' : '')}`;
  }
}
let unsavedDeviceDownload: { result: PlayableRecording & { originalData: Uint8Array }; deviceId: string; accountId: string; sessionId: number } | undefined;
async function downloadRecording(sessionId: number, options: DownloadOptions) {
  const s = controller.snapshot, row = selectedCloudDevice(), accountId = cloudSession?.account?.accountId;
  if (choosing || watching || cloudBusy || audioExportBusy || s.busy || s.phase !== 'ready' || recordingFilesBlocked(s.recording) || !row || !accountId) return;
  const generation = ++downloadGeneration, deviceId = row.serialNumber; let failed = false;
  fallbackOgg = undefined; downloadSaveNotice = ''; startAudioExport('正在检查本机是否已保存此录音…');
  try {
    if (await libraryWorkspace.reuseDeviceRecording(deviceId, sessionId, options, s.files.data?.find(file => file.sessionId === sessionId)?.size)) { downloadSaveNotice = options.transcribe ? '复用已保存的音频，已按你的选择准备转写。' : '此录音已保存在本机，无需重复下载。'; return; }
    if (!activeAudioExport(generation)) return;
    const pending = unsavedDeviceDownload;
    const reused = pending && pending.deviceId === deviceId && pending.accountId === accountId && pending.sessionId === sessionId;
    const result = reused ? pending.result : await controller.download(sessionId);
    if (!activeAudioExport(generation) || !result) return;
    if (!reused && !canSaveCompletedDownload(controller.snapshot.transfer, sessionId)) { downloadSaveNotice = '下载尚未完整完成，未保存文件。请重试。'; return; }
    unsavedDeviceDownload = { result, deviceId, accountId, sessionId };
    if (cloudSession?.account?.accountId !== accountId || selectedCloudDevice()?.serialNumber !== deviceId) return;
    downloadSaveNotice = '下载完整，正在保存原件和 Ogg 到项目录音目录…'; render();
    const saved = await libraryWorkspace.acceptDeviceDownload(result, deviceId, sessionId, options);
    unsavedDeviceDownload = undefined;
    downloadSaveNotice = saved.processingError?.message || (saved.recording.state === 'stored' ? options.transcribe ? '录音已保存，已按你的选择排队转写。' : 'Ogg 已保存到项目录音目录，尚未转写。' : '原始设备文件已保存，尚未恢复为可播放音频，未启动转写。');
    await libraryWorkspace.showRecording(saved.recording.id, 'account');
  } catch (error) {
    failed = true;
    downloadSaveNotice = `保存或处理未完成：${error instanceof Error ? error.message : '请重试'}。${unsavedDeviceDownload ? '完整录音仍保留在本页，再次操作可重试保存。' : '未保存不完整录音。'}`;
  } finally { if (downloadSaveNotice) libraryWorkspace.reportDownload(downloadSaveNotice, failed); finishAudioExport(); }
}
async function recoverLocalRecording(file: File) {
  if (choosing || watching || cloudBusy || audioExportBusy || controller.snapshot.busy) return;
  if (!file.size || file.size > 256 * 1024 * 1024) {
    fallbackOgg = undefined; downloadSaveNotice = '本机恢复支持非空且不超过 256 MiB 的文件。大文件请保留 Ogg；原文件保持不变。'; render(); return;
  }
  const generation = ++downloadGeneration, saveFormat = $<HTMLSelectElement>('save-format').value;
  const number = Number(file.name.match(/(\d+)(?=\.[^.]+$)/)?.[1]);
  const sessionId = Number.isInteger(number) && number >= 0 && number <= 0xffffffff ? number : 0;
  startAudioExport('正在本机读取并恢复录音文件…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!activeAudioExport(generation)) return;
    const result = await recoverRecording(bytes, { sessionId, privateKeyPem: val('rsa-private'), privateKeyHistory: [...rsaPrivateKeyHistory] });
    if (!activeAudioExport(generation)) return;
    if (result.format === 'ogg' && saveFormat === 'wav') { downloadSaveNotice = '文件已恢复，正在本机转换为 WAV…'; render(); }
    await exportRecording(result, generation, saveFormat, false);
  } catch {
    if (activeAudioExport(generation)) downloadSaveNotice = '文件恢复未完成。请确认文件完整，并已为同一账号准备 RSA 认证材料。原文件保持不变。';
  } finally { finishAudioExport(); }
}
function render() {
  if (wasConnected && !controller.connected) {
    invalidateAudioExport();
    if (flow.accountId && (flow.workspaceSerialNumber || flow.connection === 'connecting')) transition({ type: 'disconnect', message: controller.snapshot.error });
  }
  wasConnected = controller.connected;
  updateFlowFromController();
  const s = controller.snapshot, blocked = choosing || s.busy || watching || cloudBusy || audioExportBusy;
  const phases = { idle: '未连接', credentials: '待准备认证', connecting: '连接中', gatt: '蓝牙已连接', authenticating: '认证中', ready: '可读取', error: '连接异常' };
  put('phase', phases[s.phase]); $('phase').dataset.phase = s.phase;
  put('stage', s.stage); $('stage-dot').classList.toggle('active', controller.connected);
  put('error', s.error ?? ''); show('error', !!s.error);
  for (const [id, disabled] of Object.entries({ choose: !supported || blocked || controller.connected, connect: blocked || !device || controller.connected, disconnect: !controller.connected && !s.busy, authorize: blocked || s.phase !== 'gatt', refresh: blocked || s.phase !== 'ready', advertisement: blocked || !device || controller.connected, import: blocked || controller.connected, 'clear-credentials': blocked || controller.connected, login: blocked || controller.connected, 'import-web-session': blocked || controller.connected, 'import-web-request': blocked || controller.connected, 'copy-session-export': !WEB_SESSION_EXPORT_READY || blocked || controller.connected, logout: blocked })) ($<HTMLButtonElement>(id)).disabled = disabled;
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.auth-panel input:not([type=file]), .auth-panel textarea')) el.disabled = cloudBusy || s.busy || audioExportBusy || controller.connected;
  for (const id of ['login-email', 'login-password', 'web-session-json', 'web-request-authorization', 'web-request-api-domain', 'remember-account']) input(id).disabled = blocked || controller.connected;
  input('all-devices').disabled = blocked || controller.connected;
  $<HTMLSelectElement>('cloud-device').disabled = blocked || controller.connected;
  $('step-select').classList.toggle('done', !!device); $('step-gatt').classList.toggle('done', controller.connected); $('step-auth').classList.toggle('done', s.phase === 'ready');
  const battery = s.battery, storage = s.storage, state = s.state;
  put('battery-value', battery.data ? `${battery.data.level}%` : '—');
  put('battery-detail', battery.error || (battery.loading ? '读取中…' : battery.data ? battery.data.charging === undefined ? '标准电量服务 · 充电状态未提供' : battery.data.charging ? '正在充电' : '未充电' : '未读取'));
  $('battery-meter').style.width = `${battery.data?.level ?? 0}%`;
  put('storage-value', storage.data ? formatBytes(storage.data.free) : '—');
  put('storage-detail', storage.error || (storage.loading ? '读取中…' : storage.data ? `总容量 ${formatBytes(storage.data.total)}` : '未读取'));
  $('storage-meter').style.width = `${storage.data && storage.data.total ? Number(storage.data.free * 100n / storage.data.total) : 0}%`;
  const d = state.data;
  put('state-code', d ? `设备状态码 ${d.stateCode} / 按键状态码 ${d.keyStateCode ?? '未获取'}` : '');
  const bool = (v: boolean | undefined) => v === undefined ? '未获取' : v ? '已开启' : '未开启';
  put('privacy', bool(d?.privacy)); put('usb', d?.usb === undefined ? '未获取' : d.usb ? '已连接' : '未连接');
  for (const [id, value] of Object.entries({ findmy: d?.findMy, http: d?.http, sndp: d?.sndp })) put(id, value ?? '未获取');
  put('signal', d ? `${d.signal ?? '未获取'} / ${d.esim ?? '未获取'}` : '未获取');
  put('last-update', d && state.updated ? `状态更新于 ${new Date(state.updated).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚无设备数据');
  put('status-caption', s.phase === 'ready' ? '已通过设备响应确认认证。各项数据独立读取。' : controller.connected ? '蓝牙连接已建立，认证完成并收到状态响应后显示数据。' : '设备认证完成后，状态将在这里显示。');
  renderRecordings(blocked);
  renderFlow(blocked);
}
function notice(message: string) { put('auth-notice', message); }
function stopWatching() { protocolDetection?.abort(); stopAdvertisement?.(); stopAdvertisement = undefined; clearTimeout(advertisementTimer); watching = false; render(); }
function report(e: unknown) {
  const error = e as Error;
  const message = error.name === 'NotFoundError' ? '设备选择已取消或未完成。若列表中没有目标设备，请关闭手机蓝牙、唤醒设备后重试，或勾选“显示全部 BLE 设备”排查广播兼容性。设备可能显示为 App 中的自定义名称。' : error.name === 'SecurityError' ? '浏览器未允许蓝牙访问，请检查网站权限并使用顶层页面打开。' : error.message || '操作失败';
  notice(message); log(message); return message;
}
async function readConnectionAdvertisement(row: CloudDevice) {
  const abort = new AbortController(); protocolDetection = abort;
  watching = true; render();
  try {
    const detected = await detectDeviceProtocol({ device: device!, serialNumber: row.serialNumber, signal: abort.signal,
      local: (serialNumber, signal) => cloud.detectDevice(serialNumber, signal),
      stage: message => { protocolDetectionStage = message; render(); },
    });
    input('port').value = String(detected.portVersion); input('sn').value = detected.serialNumber; renderProtocol();
    log('已从设备广播自动识别连接协议');
  } finally {
    abort.abort();
    if (protocolDetection === abort) { protocolDetection = undefined; protocolDetectionStage = ''; watching = false; }
    render();
  }
}
async function connectSelectedDevice() {
  const row = selectedCloudDevice(), accountId = cloudSession?.account?.accountId;
  if (!row || !accountId || choosing || watching || cloudBusy || audioExportBusy || controller.snapshot.busy || flow.connection !== 'offline') return;
  if (val('sn').trim() !== row.serialNumber || !usingCloudCredentials) selectCloudDevice();
  const choice = connectionChoice(accountId, row.serialNumber, devicePreferences.get(row.serialNumber), [...authorizedDevices.values()]);
  const existing = chosenFor?.accountId === accountId && chosenFor.serialNumber === row.serialNumber ? device
    : choice.kind === 'reuse' ? authorizedDevices.get(choice.browserDeviceId) : undefined;
  transition({ type: 'connect-start', serialNumber: row.serialNumber, step: existing ? 'preparing' : 'choosing' });
  const operation = flow.operation;
  choosing = true; $('cloud-notice').dataset.error = 'false'; render();
  // requestDevice is invoked in this click before any await or cloud request.
  const selection = existing ? Promise.resolve(existing) : chooseDevice(false);
  try {
    const selected = await selection;
    if (operation !== flow.operation || !pageActive) return;
    device = selected; authorizedDevices.set(selected.id, selected); chosenFor = { accountId, serialNumber: row.serialNumber };
    put('device-name', device.name || '未命名蓝牙设备'); put('device-id', `浏览器设备 ID · ${device.id}`);
    choosing = false; transition({ type: 'connect-progress', operation, step: 'preparing' }); render();
    if (config().portVersion === undefined) await readConnectionAdvertisement(row);
    if (operation !== flow.operation || !pageActive) return;
    if (!preparedCloudDevice || preparedCloudDevice.serialNumber !== row.serialNumber || preparedCloudDevice.portVersion !== config().portVersion) await prepareCloudCredentials();
    if (operation !== flow.operation || !pageActive) return;
    validateCredentials(config());
    controllerFlowOperation = operation; controllerFlowStarted = false;
    await controller.connect(new BrowserBleLink(selected), config());
    if (operation === flow.operation && currentFlow().connection === 'connecting') transition({ type: 'connect-error', operation, message: controller.snapshot.error || '连接未完成，请检查设备后重试。' });
  } catch (e) {
    if (operation !== flow.operation || !pageActive) return;
    if (e instanceof CloudApiError && ['PREPARATION_CANCELLED', 'OPERATION_CANCELLED'].includes(e.code)) return;
    const message = e instanceof CloudApiError ? e.message : report(e);
    if (e instanceof CloudApiError) cloudFailure(e);
    if (operation === flow.operation) transition({ type: 'connect-error', operation, message });
  } finally { choosing = false; render(); }
}
$('flow-connect').addEventListener('click', () => { void connectSelectedDevice(); });
function cancelFlowConnection() {
  cloudGeneration++; controllerFlowOperation = undefined; transition({ type: 'cancel-connect' });
  stopWatching(); controller.disconnect(); put('cloud-notice', cloudBusy ? '连接已取消，正在结束认证材料准备，请稍候。' : '连接已取消，可重新选择设备。'); render();
}
$('flow-cancel').addEventListener('click', cancelFlowConnection);
function switchDevice() {
  invalidateAudioExport(); controller.disconnect(); transition({ type: 'open-devices' }); overlay.open('device'); render();
}
$('flow-switch-device').addEventListener('click', switchDevice);
$('flow-open-settings').addEventListener('click', () => overlay.open('settings'));
$('settings-login').addEventListener('click', () => overlay.open('device'));
$('save-format').addEventListener('change', () => {
  audioFormatRevision++;
  const accountId = cloudSession?.account?.accountId, format = $<HTMLSelectElement>('save-format').value === 'ogg' ? 'ogg' : 'wav';
  if (accountId) void preferences.saveAudioFormat(accountId, format).then(saved => { if (!saved) cacheNotice('保存格式仅在当前页记忆，浏览器未允许持久保存偏好。'); });
});
$('choose').addEventListener('click', async () => {
  choosing = true; render(); notice(''); stopWatching();
  try {
    const showAll = input('all-devices').checked;
    log(showAll ? '开始扫描全部 BLE 设备（诊断模式）' : '开始按 PLAUD 广播产品号 / SN 特征扫描，不按设备名过滤');
    device = await chooseDevice(showAll);
    invalidateAudioExport();
    put('device-name', device.name || '未命名蓝牙设备'); put('device-id', `浏览器设备 ID · ${device.id}`);
    log('已选择蓝牙设备；尚未连接或认证');
  } catch (e) { report(e); }
  finally { choosing = false; render(); }
});
$('connect').addEventListener('click', async () => {
  if (!device) return;
  try {
    stopWatching(); notice('');
    const selected = selectedCloudDevice();
    if (usingCloudCredentials && selected) {
      const currentPort = portForCloudPreparation();
      if (!preparedCloudDevice || preparedCloudDevice.serialNumber !== selected.serialNumber || preparedCloudDevice.portVersion !== currentPort) await prepareCloudCredentials();
    }
    const c = config();
    await controller.connect(new BrowserBleLink(device), c);
    if (controller.snapshot.phase === 'credentials') $<HTMLDetailsElement>('manual-auth-details').open = true;
  } catch (e) {
    if (e instanceof CloudApiError) {
      if (e.code === 'PREPARATION_CANCELLED') return;
      cloudFailure(e); notice('认证材料尚未准备完成，请查看账号区域的提示后重试。');
    }
    else report(e);
  }
});
$('disconnect').addEventListener('click', () => { invalidateAudioExport(); stopWatching(); controller.disconnect(); });
$('authorize').addEventListener('click', async () => { try { notice(''); await controller.authorize(config()); } catch (e) { report(e); } });
$('refresh').addEventListener('click', () => { void controller.refresh(); });
$('refresh-files').addEventListener('click', () => { void controller.listFiles(); });
$('cancel-download').addEventListener('click', () => { invalidateAudioExport(); controller.cancelDownload(); });
$('recover-file').addEventListener('click', () => input('recording-file').click());
$('recording-file').addEventListener('change', () => {
  const file = input('recording-file').files?.[0]; input('recording-file').value = '';
  if (file) void recoverLocalRecording(file);
});
$('cancel-audio-export').addEventListener('click', () => { invalidateAudioExport(); render(); });
$('save-fallback-ogg').addEventListener('click', () => {
  if (audioExportBusy || cloudBusy || controller.snapshot.busy || !fallbackOgg) return;
  const { recording, generation } = fallbackOgg;
  try {
    if (saveRecording(recording, generation)) downloadSaveNotice = `Ogg 文件已交给浏览器保存。${recording.notice || ''}`;
  } catch { downloadSaveNotice = '浏览器未能发起保存，请重试“保存 Ogg 文件”。'; }
  render();
});
$('port').addEventListener('input', () => { selectionRevision++; preparedCloudDevice = undefined; renderProtocol(); });
$('advertisement').addEventListener('click', async () => {
  if (!device) return;
  watching = true; render(); notice('正在等待广播，最多 10 秒…');
  try {
    stopAdvertisement = await observeAdvertisement(device, a => {
      const selected = selectedCloudDevice();
      if (usingCloudCredentials && selected && a.serialNumber !== selected.serialNumber) {
        stopWatching(); notice('蓝牙广播中的设备与所选账号设备不一致，请重新选择同一台设备。'); log('广播设备与所选账号设备不一致'); return;
      }
      preparedCloudDevice = undefined;
      input('port').value = a.portVersion?.toString() ?? ''; input('sn').value = a.serialNumber; renderProtocol();
      notice(a.portVersion === undefined ? `已按 SN 识别为 ${a.model}，此广播未提供可用的协议版本，请手工填写 portVersion。` : `已按 SN 识别为 ${a.model}，portVersion=${a.portVersion}，固件 ${a.firmware}`);
      log(a.portVersion === undefined ? '已识别 PLAUD 广播与 SN；协议版本仍需手工填写' : '已识别 PLAUD 广播中的型号、协议版本与 SN'); stopWatching();
    });
    if (!watching) stopAdvertisement();
    else advertisementTimer = setTimeout(() => { stopWatching(); notice('等待广播超时。请唤醒设备，或手工填写协议版本和 SN。'); }, 10000);
  } catch (e) { stopWatching(); report(e); }
});
$('import').addEventListener('click', () => input('credential-file').click());
$('credential-file').addEventListener('change', async () => {
  const file = input('credential-file').files?.[0]; if (!file) return;
  try {
    if (file.size > 128 * 1024) throw new Error('认证 JSON 超过 128 KiB，请仅保留必要认证字段');
    let parsed: unknown;
    try { parsed = JSON.parse(await file.text()); } catch { throw new Error('JSON 格式无效，请检查文件内容'); }
    const imported = importCredentials(parsed); useManualCredentials(); fill(imported); notice('已切换为手工认证材料，仅保留在本页内存中。请核对账号 ID 和协议版本。'); log('已导入认证配置（不记录字段值）');
  } catch (e) { report(e); }
  finally { input('credential-file').value = ''; render(); }
});
$('clear-credentials').addEventListener('click', () => { useManualCredentials(); fill(emptyCredentials()); notice('认证输入已清空，可重新选择云端设备准备材料或手工导入。'); render(); });
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (cloudBusy || controller.connected || controller.snapshot.busy) return;
  const email = val('login-email').trim(), password = val('login-password');
  input('login-password').value = ''; clearOfficialSessionInputs();
  if (!email || !password) { put('cloud-notice', '请填写 PLAUD 账号邮箱和密码。'); return; }
  const generation = ++cloudGeneration, operation = beginCloudOperation();
  put('cloud-notice', '正在登录 PLAUD 账号…'); $('cloud-notice').dataset.error = 'false'; log('正在登录 PLAUD 账号');
  try {
    const session = await cloud.login(email, password, input('remember-account').checked);
    if (generation !== cloudGeneration) return;
    acceptCloudLogin(session);
  } catch (e) { if (generation === cloudGeneration) cloudFailure(e); }
  finally { finishCloudOperation(operation); }
});
$('copy-session-export').addEventListener('click', async () => {
  if (!WEB_SESSION_EXPORT_READY) return;
  try {
    await navigator.clipboard.writeText(WEB_SESSION_EXPORT_SCRIPT);
    put('session-export-notice', '导出脚本已复制。请到官方 Web 页面的 Console 手动运行，再把复制出的 JSON 粘贴到下方输入框。');
    show('session-export-script', false);
  } catch {
    $<HTMLTextAreaElement>('session-export-script').value = WEB_SESSION_EXPORT_SCRIPT;
    show('session-export-script', true);
    put('session-export-notice', '浏览器未允许写入剪贴板。请手动复制下面的脚本，在官方 Web 的 Console 运行。');
  }
});
$('web-session-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (cloudBusy || controller.connected || controller.snapshot.busy) return;
  const text = val('web-session-json'); clearOfficialSessionInputs(); input('login-password').value = '';
  let payload: OfficialWebSessionInput;
  try { payload = parseWebSessionJson(text); }
  catch (e) { cloudFailure(e); return; }
  await importOfficialSession(payload);
});
$('web-request-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (cloudBusy || controller.connected || controller.snapshot.busy) return;
  const authorization = val('web-request-authorization'), domain = val('web-request-api-domain');
  clearOfficialSessionInputs(); input('login-password').value = '';
  let payload: OfficialWebSessionInput;
  try { payload = parseSuccessfulRequestAuthorization(authorization, domain); }
  catch (e) { cloudFailure(e); return; }
  await importOfficialSession(payload);
});
$('cloud-device').addEventListener('change', () => { selectCloudDevice(true); });
async function logoutAccount(forgetLocalData = false) {
  const accountId = cloudSession?.account?.accountId;
  const generation = ++cloudGeneration, operation = beginCloudOperation();
  accountPreferencesGeneration++; devicePreferences.clear(); chosenFor = undefined; controllerFlowOperation = undefined;
  transition({ type: 'logout' });
  unsavedDeviceDownload = undefined; invalidateAudioExport(); stopWatching(); controller.disconnect(true); device = undefined; clearCloudMaterials();
  cloudSession = undefined; renderCloudSession(); input('login-password').value = '';
  put('device-name', '等待选择设备'); put('device-id', '点击下方按钮打开浏览器设备列表');
  put('cloud-notice', '正在退出本地登录会话…');
  try {
    if (forgetLocalData && accountId) await preferences.clearAccount(accountId);
    const session = await cloud.logout(forgetLocalData);
    if (generation !== cloudGeneration) return;
    cloudSession = session; renderCloudSession(); put('cloud-notice', forgetLocalData ? '已退出并移除账号授权与解密材料，录音库资料已保留。' : '已退出登录，历史录音密钥继续加密保留在本机。'); log('已退出 PLAUD 本地会话');
  } catch (e) { if (generation === cloudGeneration) cloudFailure(e); }
  finally { finishCloudOperation(operation); }
}
$('logout').addEventListener('click', () => { void logoutAccount(); });
$('devices-logout').addEventListener('click', () => { void logoutAccount(); });
$('forget-local-data').addEventListener('click', () => {
  if (window.confirm('确认退出并移除账号授权与解密材料？本机登录授权、RSA 历史密钥和设备偏好将被删除，旧设备文件可能无法解密。录音库中的音频和全文不会删除，可在录音资料中单独移入回收站。')) void logoutAccount(true);
});
for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.auth-panel input:not([type=file]):not(#port), .auth-panel textarea')) {
  field.addEventListener('input', () => {
    if (!usingCloudCredentials || cloudBusy || controller.snapshot.busy || controller.connected) return;
    useManualCredentials(); put('cloud-notice', '已切换为手工认证材料；重新选择账号设备可恢复自动准备。');
  });
}
$('clear-logs').addEventListener('click', () => { logs.length = 0; $('logs').replaceChildren(); put('log-count', '0 条'); });
$('export-logs').addEventListener('click', () => {
  const blob = new Blob([logs.map(x => `${x.time} ${x.message}`).join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'plaud-ble-log.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener('visibilitychange', () => { renderRecordingClock(); syncRecordingClock(); });
window.addEventListener('pageshow', () => { pageActive = true; renderRecordingClock(); syncRecordingClock(); });
window.addEventListener('pagehide', () => { pageActive = false; cloudGeneration++; invalidateAudioExport(); stopRecordingClock(); clearOfficialSessionInputs(); input('login-password').value = ''; stopWatching(); controller.disconnect(true); });
async function environment() {
  $('environment').classList.toggle('unsupported', !supported);
  put('env-text', supported ? '浏览器支持 Web Bluetooth · 安全上下文已就绪' : '当前环境无法使用蓝牙。请在电脑 Chrome / Edge 中通过 localhost 或 HTTPS 打开。');
  $<HTMLButtonElement>('choose').disabled = !supported;
  if (supported && navigator.bluetooth.getAvailability) {
    try { if (!await navigator.bluetooth.getAvailability()) { put('env-text', '蓝牙当前不可用，请打开电脑蓝牙并检查系统权限。'); } } catch { /* 浏览器未开放可用性检测，保留 API 支持提示。 */ }
  }
}
render(); void environment(); void prefetchAuthorizedDevices();
// The workspace is immediately usable; account recovery never replaces the page.
void libraryWorkspace.open();
// Establish the local cookie before the independent, potentially slow cloud restore.
void libraryWorkspace.initialize().catch(() => {}).finally(() => {
  void restoreCloudSession().finally(() => libraryWorkspace.refreshIdentity());
});
