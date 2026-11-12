'use strict';
const { t, setLocale, getLocale } = require('./i18n.cjs');
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell, clipboard, safeStorage, session } = require('electron');
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');
const { mkdir, readFile, writeFile, cp, statfs } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { Runtime } = require('./runtime.cjs');
const { readSettings, privateJson } = require('./settings.cjs');
const { externalUrl } = require('./security.cjs');
const { registerNative } = require('./native-registration.cjs');
const { NativeBroker } = require('./native-broker.cjs');
const { ModelToken } = require('./model-token.cjs');

app.setName('RecDock');
const support = join(app.getPath('appData'), 'RecDock');
app.setPath('userData', join(support, 'desktop/chromium'));
let resources = app.isPackaged ? process.resourcesPath : process.env.RECDOCK_RESOURCES;
if (!app.isPackaged) {
  try { resources = JSON.parse(require('node:fs').readFileSync(resolve(__dirname, '../vendor/dev-runtime.json'), 'utf8')).resources; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const extensionSource = app.isPackaged ? join(resources, 'extension') : resolve(__dirname, '../../plaud-web/extensions/chatgpt-bridge');
const branding = app.isPackaged ? join(resources, 'branding') : resolve(__dirname, '../assets');
const version = require('../package.json').version;
let window, tray, runtime, broker, settings, origin, closing = false, shutdown = false;
const token = randomBytes(32).toString('hex');
const modelTokens = new ModelToken(join(support, 'desktop/huggingface.enc'), safeStorage);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => show());
  app.whenReady().then(start).catch(async error => {
    const code = /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'APP_START_FAILED';
    await mkdir(join(support, 'desktop'), { recursive: true, mode: 0o700 }).catch(() => {});
    await writeFile(join(support, 'desktop/startup-status.json'), JSON.stringify({ time: new Date().toISOString(), code, stage: error.message === 'SERVICE_START_FAILED' ? 'service' : 'application', detail: String(error.message || '').slice(0, 300) }), { mode: 0o600 }).catch(() => {});
    const message = code === 'LIBRARY_LOCKED' ? t("旧版 RecDock 服务仍在使用录音库。请退出旧助手后重开；不要同时运行两个版本。") : code === 'EADDRINUSE' ? t("本机处理端口被其他程序占用，请关闭旧的 RecDock 桌面版本后重试。") : ['SIGKILL', 'EPERM', 'EACCES'].includes(code) ? t("内置处理进程被系统或保护软件阻止。请核对系统与公司保护提示后重试，录音资料已保留。") : t("内置处理环境未能启动。请确认安装包完整，并查看资料目录中的启动诊断。");
    await Promise.allSettled([runtime?.cancelSetup(), runtime?.stop(), broker?.close()]);
    dialog.showErrorBox(t("RecDock 无法启动"), message + t("\n诊断代码：") + code); app.exit(1);
  });
}
function show() { if (!window) return; window.show(); window.focus(); }
function ownFrame(event) { try { return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin; } catch { return false; } }
function handle(channel, callback) { ipcMain.handle(channel, async (event, value) => { if (!ownFrame(event)) throw Error(t("拒绝不受信任的页面。")); return callback(value); }); }
async function desktopInfo() {
  const disk = await statfs(support);
  let models = false;
  try { const lock = JSON.parse(await readFile(join(runtime.models, 'models.lock.json'), 'utf8')); models = ['asr', 'aligner', 'diarizer'].every(name => lock.models?.[name]?.revision); } catch {}
  return { version, platform: process.platform, modelsDirectory: runtime.models, modelsPrepared: models, freeBytes: Number(disk.bavail) * Number(disk.bsize), setup: runtime.taskState, extensionConnected: broker.connected, extensionDirectory: join(support, 'desktop/extension'), loginAtStart: app.getLoginItemSettings().openAtLogin, tokenSaved: await modelTokens.saved(), distribution: t("未公证 · 发布候选版") };
}
async function start() {
  if (!resources) throw Error('RESOURCES_REQUIRED');
  settings = await readSettings(support); setLocale(settings.uiLanguage);
  await mkdir(join(support, 'desktop'), { recursive: true, mode: 0o700 });
  runtime = new Runtime({ resources, support, models: settings.modelsDirectory || join(support, 'models'), token, ...(!app.isPackaged ? { workspace: resolve(__dirname, '../vendor/dev-workspace'), publicRoot: resolve(__dirname, '../../plaud-web/dist') } : {}) });
  const native = await registerNative({ support, resources, home: homedir(), appSource: __dirname, extensionSource });
  broker = new NativeBroker(native); await broker.start();
  await cp(extensionSource, join(support, 'desktop/extension'), { recursive: true, force: true, filter: source => !source.endsWith('.DS_Store') });
  const port = await runtime.start(); origin = `http://127.0.0.1:${port}`;
  const ses = session.fromPartition('persist:recdock-desktop');
  ses.webRequest.onBeforeSendHeaders({ urls: [origin + '/*'] }, (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, 'X-RecDock-Desktop': token } }));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && details.isMainFrame !== false && ['bluetooth', 'bluetooth-scanning', 'clipboard-sanitized-write'].includes(permission)));
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => contents === window?.webContents && requestingOrigin === origin && ['bluetooth', 'bluetooth-scanning', 'clipboard-sanitized-write'].includes(permission));
  ses.setDevicePermissionHandler(details => details.deviceType === 'bluetooth' && details.origin === origin);
  window = new BrowserWindow({ width: 1320, height: 880, minWidth: 980, minHeight: 640, title: 'RecDock', backgroundColor: '#f5f5f2', show: false, webPreferences: { session: ses, preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false, devTools: !app.isPackaged } });
  window.on('close', event => { if (!closing) { event.preventDefault(); window.hide(); } });
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== origin) { event.preventDefault(); const url = externalUrl(target); if (url) void shell.openExternal(url); } });
  window.webContents.setWindowOpenHandler(({ url }) => { const target = externalUrl(url); if (target) void shell.openExternal(target); return { action: 'deny' }; });
  window.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    window.webContents.send('recdock:bluetooth-devices', devices.map(row => ({ id: row.deviceId, name: row.deviceName || t("未命名设备") })));
    if (window.bluetoothSelection) return;
    const timeout = setTimeout(() => { window.bluetoothSelection = null; callback(''); window.webContents.send('recdock:bluetooth-devices', []); }, 60000);
    window.bluetoothSelection = id => { clearTimeout(timeout); window.bluetoothSelection = null; callback(id); };
  });
  ses.setBluetoothPairingHandler((details, callback) => { void dialog.showMessageBox(window, { type: 'question', title: t("蓝牙设备配对"), message: t("是否允许与 {0} 配对？", details.deviceId), detail: details.pin ? t("请核对设备上的配对码：{0}", details.pin) : t("请核对你选择的录音设备。"), buttons: [t("取消"), t("允许")], defaultId: 0, cancelId: 0 }).then(result => callback({ confirmed: result.response === 1, pin: details.pin })); });
  handle('recdock:get-locale', () => getLocale());
  handle('recdock:set-locale', async value => {
    if (!['en', 'zh-CN'].includes(value)) throw Error('INVALID_UI_LANGUAGE');
    const next = { ...settings, uiLanguage: value };
    await privateJson(join(support, 'settings.json'), next); settings = next;
    setLocale(value); refreshNativeUI(); return getLocale();
  });
  handle('recdock:info', desktopInfo);
  handle('recdock:choose-models', async () => {
    if (runtime.task) throw Error(t("请等待或取消当前准备任务。"));
    const { response } = await dialog.showMessageBox(window, { message: t("切换模型目录会重启本地处理服务。"), detail: t("正在处理的任务会保留并在重启后恢复。"), buttons: [t("取消"), t("选择目录")], defaultId: 1, cancelId: 0 });
    if (!response) return desktopInfo();
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: t("选择含 models.lock.json 的 RecDock 模型目录") });
    if (result.canceled) return desktopInfo();
    const selected = result.filePaths[0];
    settings.modelsDirectory = selected; await privateJson(join(support, 'settings.json'), settings);
    await runtime.stop(); runtime.models = selected; const port = await runtime.start(); if (`http://127.0.0.1:${port}` !== origin) throw Error('SERVICE_ORIGIN_CHANGED');
    window.webContents.reload(); return desktopInfo();
  });
  handle('recdock:setup', async value => {
    if (!['download', 'verify', 'probe'].includes(value)) throw Error(t("不支持此准备任务。"));
    if (value === 'download' && (await desktopInfo()).freeBytes < 6 * 1024 ** 3) throw Error(t("可用磁盘空间不足 6 GiB，请先释放空间，或选择已有模型目录。"));
    return runtime.prepare({ verify: value === 'verify', probe: value === 'probe', token: value === 'download' ? await modelTokens.read() : '' });
  });
  handle('recdock:cancel-setup', () => runtime.cancelSetup());
  handle('recdock:save-token', value => modelTokens.save(value));
  handle('recdock:remove-token', () => modelTokens.remove());
  handle('recdock:reveal', async value => { const path = value === 'extension' ? join(support, 'desktop/extension') : value === 'models' ? runtime.models : support; const error = await shell.openPath(path); if (error) throw Error(t("暂时无法打开目录。")); });
  handle('recdock:copy-extension-path', () => { clipboard.writeText(join(support, 'desktop/extension')); return true; });
  handle('recdock:external', value => { const url = externalUrl(value); if (!url) throw Error(t("链接不受支持。")); return shell.openExternal(url); });
  handle('recdock:login', value => { if (typeof value !== 'boolean') throw Error(t("设置不正确。")); app.setLoginItemSettings({ openAtLogin: value }); return app.getLoginItemSettings().openAtLogin; });
  handle('recdock:chatgpt', value => { if (!value || typeof value !== 'object') throw Error(t("请求不正确。")); return broker.request(value.action, value.payload); });
  handle('recdock:bluetooth-select', value => { if (typeof value !== 'string' || value.length > 200) throw Error(t("设备不正确。")); window.bluetoothSelection?.(value); return true; });
  runtime.on('setup', state => {
    if (state.report) void privateJson(join(support, 'desktop/environment-status.json'), state.report).catch(() => {});
    if (!window.isDestroyed()) window.webContents.send('recdock:setup-state', state);
  });
  runtime.on('service-exited', () => { if (!closing && !runtime.restarting) dialog.showErrorBox(t("本地处理服务已停止"), t("请退出并重新打开 RecDock。录音与任务记录会保留。")); });
  const icon = nativeImage.createFromPath(join(branding, 'Tray.png')); icon.setTemplateImage(true);
  tray = new Tray(icon); tray.on('click', show);
  refreshNativeUI();
  if (!app.isPackaged) app.dock?.setIcon(join(branding, 'RecDock.png'));
  await window.loadURL(origin); show();
  app.on('activate', show);
}
function refreshNativeUI() {
  const menuTemplate = [ { label: 'RecDock', submenu: [{ label: t("关于 RecDock"), role: 'about' }, { label: t("打开工作台"), click: show }, { type: 'separator' }, { role: 'hide', label: t('隐藏 RecDock') }, { role: 'hideOthers', label: t('隐藏其他应用') }, { role: 'unhide', label: t('全部显示') }, { type: 'separator' }, { role: 'quit', label: t("退出 RecDock") }] }, { label: t("文件"), submenu: [{ role: 'close', label: t("关闭窗口") }] }, { label: t('编辑'), submenu: [{ role: 'undo', label: t('撤销') }, { role: 'redo', label: t('重做') }, { type: 'separator' }, { role: 'cut', label: t('剪切') }, { role: 'copy', label: t('复制') }, { role: 'paste', label: t('粘贴') }, { role: 'selectAll', label: t('全选') }] }, { label: t('显示'), submenu: [{ role: 'reload', label: t('重新载入') }, { role: 'resetZoom', label: t('实际大小') }, { role: 'zoomIn', label: t('放大') }, { role: 'zoomOut', label: t('缩小') }, { role: 'togglefullscreen', label: t('切换全屏') }] }, { label: t('窗口'), submenu: [{ role: 'minimize', label: t('最小化') }, { role: 'zoom', label: t('缩放') }, { role: 'front', label: t('前置全部窗口') }] }, { label: t("帮助"), submenu: [{ label: t("项目与安装帮助"), click: () => shell.openExternal('https://github.com/audiobridge-ai/recdock') }, { label: t("检查新版本"), click: () => shell.openExternal('https://github.com/audiobridge-ai/recdock/releases') }] } ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  tray.setToolTip(t("RecDock · 本地录音工作台")); tray.setContextMenu(Menu.buildFromTemplate([{ label: t("打开 RecDock"), click: show }, { label: t("任务在后台继续；退出后可恢复"), enabled: false }, { type: 'separator' }, { label: t("退出 RecDock"), click: () => app.quit() }]));

  app.setAboutPanelOptions({ applicationName: 'RecDock', applicationVersion: version, copyright: '© 2026 audiobridge-ai · MIT', credits: t("本地优先的开源录音工作台。模型：Qwen / mlx-community / pyannote。当前版本未进行 Apple 公证。") });
}
app.on('before-quit', event => {
  if (shutdown) return;
  event.preventDefault(); if (closing) return; closing = true;
  window?.bluetoothSelection?.('');
  void Promise.allSettled([runtime?.cancelSetup(), runtime?.stop(), broker?.close()]).finally(() => { shutdown = true; app.quit(); });
});
app.on('window-all-closed', () => {});
