const MAX_PACKET = 32 * 1024 * 1024;
export function createAssembler() {
  const requests = new Map();
  return async frame => {
    if (typeof frame?.id !== 'string' || frame.id.length > 80) throw Error('Invalid native request');
    if (frame.kind === 'request') {
      if (requests.size >= 16 || requests.has(frame.id) || !['info', 'bind', 'start', 'status', 'open'].includes(frame.action) || !Number.isInteger(frame.bytes) || frame.bytes < 1 || frame.bytes > MAX_PACKET || !/^[a-f0-9]{64}$/.test(frame.sha256)) throw Error('Invalid native request');
      requests.set(frame.id, { ...frame, bytesReceived: 0, chunks: [], at: Date.now() });
      return;
    }
    const request = requests.get(frame.id);
    if (!request || Date.now() - request.at > 30000) { requests.delete(frame.id); throw Error('Native request expired'); }
    if (frame.kind === 'chunk') {
      if (frame.offset !== request.bytesReceived || typeof frame.data !== 'string' || frame.data.length > 300000) throw Error('Invalid native chunk');
      const chunk = Uint8Array.from(atob(frame.data), char => char.charCodeAt(0));
      if (!chunk.length || request.bytesReceived + chunk.length > request.bytes) throw Error('Invalid native chunk length');
      request.chunks.push(chunk); request.bytesReceived += chunk.length; return;
    }
    if (frame.kind !== 'complete') throw Error('Invalid native frame');
    requests.delete(frame.id);
    if (request.bytesReceived !== request.bytes) throw Error('Incomplete native packet');
    const bytes = new Uint8Array(request.bytes); let offset = 0;
    for (const chunk of request.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== request.sha256) throw Error('Native packet integrity failed');
    return { id: request.id, action: request.action, payload: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  };
}
export function installNativeClient(handle) {
  if (typeof chrome.runtime.connectNative !== 'function') return;
  let port, timer, stopped = false, retryDelay = 3000;
  const connect = () => {
    if (port || stopped) return;
    const current = chrome.runtime.connectNative('ai.recdock.desktop'); port = current;
    const assemble = createAssembler(); let chain = Promise.resolve();
    current.onMessage.addListener(frame => {
      retryDelay = 3000;
      chain = chain.then(async () => {
        try {
          const request = await assemble(frame); if (!request) return;
          const result = await handle(request.action, request.payload);
          current.postMessage({ kind: 'response', id: request.id, result });
        } catch (error) { if (typeof frame?.id === 'string') current.postMessage({ kind: 'response', id: frame.id, error: error instanceof Error ? error.message.slice(0, 600) : '桌面连接未完成。' }); }
      }).catch(() => {});
    });
    current.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (port === current) port = null; if (!stopped) { timer = setTimeout(connect, retryDelay); retryDelay = Math.min(60000, Math.round(retryDelay * 1.8)); } });
  };
  chrome.runtime.onStartup?.addListener(connect); chrome.runtime.onInstalled?.addListener(connect);
  connect(); return { reconnect: () => { clearTimeout(timer); retryDelay = 3000; connect(); }, close: () => { stopped = true; clearTimeout(timer); port?.disconnect(); } };
}
