// Only the exact local workspace may issue tasks; no general file or URL access.
if (location.origin === 'http://localhost:5173' && window.top === window && !globalThis.__recdockChatgptBridge) {
  globalThis.__recdockChatgptBridge = true;
  window.addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== 'recdock-chatgpt-v1' || data.type !== 'request' || typeof data.requestId !== 'string' || !['info', 'bind', 'start', 'status', 'open'].includes(data.action)) return;
    try {
      const response = await chrome.runtime.sendMessage({ source: 'recdock-workspace', action: data.action, payload: data.payload });
      window.postMessage({ channel: 'recdock-chatgpt-v1', type: 'response', requestId: data.requestId, ...response }, location.origin);
    } catch { window.postMessage({ channel: 'recdock-chatgpt-v1', type: 'response', requestId: data.requestId, error: '扩展已更新，请刷新工作台页面后重试。' }, location.origin); }
  });
}
