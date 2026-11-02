// Paste in the LOCAL workspace console only. All API and BLE operations here are synthetic.
// Reloading removes all overrides; cleanup removes only this synthetic account's preferences.
void (async () => {
  if (location.origin !== 'http://localhost:5173') throw new Error('Local preview required');
  const needsProtocol = new URL(import.meta.url).searchParams.get('auto') === '1';
  const accountId = 'ui-verification-account', serialNumber = 'UITEST0001';
  const trace = [];
  const session = { authenticated: true, csrfToken: 'synthetic-csrf', account: { accountId, email: 'ui-test@example.invalid' },
    devices: [{ serialNumber, name: '交互验证设备', model: 'PLAUD · 模拟', ...(needsProtocol ? {} : { portVersion: 9 }) }], persistence: { available: true, hasSavedAccount: true } };
  const device = Object.assign(new EventTarget(), { id: 'synthetic-browser-device', name: '交互验证设备' });
  const bluetooth = {
    async getDevices() { return [device]; }, async getAvailability() { return true; },
    requestDevice() { trace.push({ type: 'choose', active: navigator.userActivation.isActive }); return Promise.resolve(device); },
  };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: bluetooth });
  const { WorkspacePreferences } = await import('/src/ui/preferences.ts');
  const preferences = new WorkspacePreferences(location.origin);
  await preferences.clearAccount(accountId);
  const originalFetch = window.fetch;
  window.fetch = async (input, options) => {
    const path = typeof input === 'string' ? input : input.url;
    if (!path.startsWith('/api/')) return originalFetch(input, options);
    trace.push({ type: path.split('/').at(-1), ...(path === '/api/prepare-device' ? { automatic: JSON.parse(options.body).allowKeyInitialization === true } : {}) });
    const data = path === '/api/detect-device' ? { serialNumber, portVersion: 9, firmware: 'V123', source: 'native-advertisement' } : path === '/api/prepare-device' ? {
      device: session.devices[0], source: 'cache', portSource: 'verified',
      credentials: { accountId, serialNumber, portVersion: 9, bindingToken: '', rsa: { snSignature: '', publicKeyPem: '', privateKeyPem: '', alternateCommand: false },
        ecc: { devicePublicKeyHex: '', userPrivateKeyHex: '' }, secondHandshake: { extra8: '', extraText: '' } },
    } : session;
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { BrowserBleLink } = await import('/src/ble/transport.ts');
  Object.defineProperty(BrowserBleLink.prototype, 'connected', { configurable: true, get() { return !!this.__mockConnected; } });
  BrowserBleLink.prototype.connect = async function(frame, lost, stage) { trace.push({ type: 'gatt' }); this.__mockConnected = true; this.__frame = frame; this.__lost = lost; window.__uiVerification.link = this; stage?.('正在订阅设备通知'); };
  BrowserBleLink.prototype.close = function() { this.__mockConnected = false; };
  BrowserBleLink.prototype.battery = async () => 75;
  const decode = hex => Uint8Array.from(hex.match(/../g).map(byte => parseInt(byte, 16)));
  BrowserBleLink.prototype.write = async function(bytes) {
    const cmd = bytes[1] | bytes[2] << 8; trace.push({ type: 'command', cmd });
    const packets = { 1: '010100000900', 3: '01030000000000000000', 9: '010900014b', 6: '01060000040000000000000008000000000000' };
    if (packets[cmd]) this.__frame(decode(packets[cmd]));
    if (cmd === 26) { const empty = new Uint8Array(11); empty.set(bytes.subarray(0, 7)); this.__frame(empty); }
  };
  window.__uiVerification = { trace, session, lose() { const link=this.link; if(link?.__mockConnected){link.__mockConnected=false;link.__lost();} },
    async cleanup() { await preferences.clearAccount(accountId); } };
  await import('/src/main.ts?ui-verification=' + Date.now());
  console.log('PLAUD_UI_TEST_STATUS', JSON.stringify({ prepared: true }));
})().catch(() => console.log('PLAUD_UI_TEST_STATUS', JSON.stringify({ prepared: false })));
