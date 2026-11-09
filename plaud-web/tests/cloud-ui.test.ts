import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { CloudApiError, CloudClient, parseSuccessfulRequestAuthorization, parseWebSessionJson } from '../src/auth/cloud.ts';

interface Call { url: string; method: string; headers: Headers; body?: Record<string, unknown>; credentials?: RequestCredentials; cache?: RequestCache }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function withFetch(handler: (call: Call) => Response | Promise<Response>, run: (calls: Call[]) => Promise<void>) {
  const original = globalThis.fetch, calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const call: Call = {
      url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      credentials: init?.credentials, cache: init?.cache,
    };
    calls.push(call); return handler(call);
  };
  try { await run(calls); }
  finally { globalThis.fetch = original; }
}

test('恢复会话和登录并发时只取一次CSRF，密码仅提交本地登录端点', async () => {
  let release: () => void = () => {};
  const ready = new Promise<void>(resolve => { release = resolve; });
  await withFetch(async call => {
    if (call.url === '/api/session') { await ready; return json({ authenticated: false, csrfToken: 'guest-csrf' }); }
    return json({ authenticated: true, csrfToken: 'account-csrf', account: { accountId: 'test-user', email: 'test@example.invalid' }, devices: [] });
  }, async calls => {
    const client = new CloudClient(), restoring = client.session();
    const login = client.login('test@example.invalid', 'synthetic-password');
    try { assert.equal(calls.length, 1); }
    finally { release(); }
    await Promise.all([restoring, login]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, '/api/login'); assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].headers.get('X-CSRF-Token'), 'guest-csrf');
    assert.deepEqual(calls[1].body, { email: 'test@example.invalid', password: 'synthetic-password', region: 'auto', remember: true });
    for (const call of calls) { assert.equal(call.credentials, 'same-origin'); assert.equal(call.cache, 'no-store'); }
  });
});

test('连接默认自动准备首次RSA材料，不需要额外确认或第二次提交', async () => {
  await withFetch(call => {
    if (call.url === '/api/session') return json({ authenticated: true, csrfToken: 'account-csrf' });
    return call.body?.allowKeyInitialization === true
      ? json({ credentials: {}, device: { serialNumber: 'test-device', name: 'Test' } })
      : json({ error: { code: 'KEY_INITIALIZATION_REQUIRED', message: 'requires explicit consent' } }, 409);
  }, async calls => {
    const client = new CloudClient(); await client.session();
    await client.prepare('test-device', 20);
    assert.equal(calls.length, 2, '连接只提交一次准备请求');
    assert.deepEqual(calls[1].body, { serialNumber: 'test-device', portVersion: 20, allowKeyInitialization: true });
    assert.equal(calls[1].headers.get('X-CSRF-Token'), 'account-csrf');
  });
});

test('MFA不会当作登录成功，非JSON错误不会暴露HTTP原始正文', async () => {
  let htmlError = false;
  await withFetch(call => {
    if (call.url === '/api/session' && !htmlError) return json({ authenticated: false, csrfToken: 'guest-csrf' });
    if (htmlError) return new Response('<html>raw upstream token: synthetic-secret</html>', { status: 502 });
    return json({ error: { code: 'MFA_REQUIRED', message: 'raw upstream token: synthetic-secret' } }, 401);
  }, async () => {
    const client = new CloudClient();
    await assert.rejects(client.login('test@example.invalid', 'synthetic-password'), error => error instanceof CloudApiError && error.code === 'MFA_REQUIRED' && !error.message.includes('synthetic-secret'));
    htmlError = true;
    await assert.rejects(client.session(), error => error instanceof CloudApiError && error.code === 'LOCAL_SERVICE_UNAVAILABLE' && !error.message.includes('synthetic-secret'));
  });
});

test('官方登录态导入仅接受两字段JSON和官方API区域，不回显输入内容', () => {
  const payload = { userToken: 'synthetic-token', userApiDomain: 'https://api-euc1.plaud.ai' };
  assert.deepEqual(parseWebSessionJson(JSON.stringify(payload)), payload);
  assert.deepEqual(parseWebSessionJson(JSON.stringify({ ...payload, userToken: '  bEaReR synthetic-token  ' })), payload);
  for (const data of [
    { ...payload, refreshToken: 'synthetic-refresh-secret' },
    { ...payload, userApiDomain: 'https://unrelated.invalid' },
    { ...payload, userApiDomain: 'http://api.plaud.ai' },
    { ...payload, userApiDomain: 'https://api.plaud.ai@unrelated.invalid' },
    { ...payload, userToken: '' }, [], null,
    { ...payload, userToken: 'x'.repeat(8193) },
    { ...payload, userToken: 'Basic synthetic-token' },
    { ...payload, userToken: 'Bearer Bearer synthetic-token' },
    { ...payload, userToken: 'synthetic-token\r\nInjected-Header' },
  ]) assert.throws(() => parseWebSessionJson(JSON.stringify(data)), error => error instanceof CloudApiError && error.code === 'INVALID_SESSION_JSON' && !error.message.includes('synthetic'));
  assert.throws(() => parseWebSessionJson('synthetic-private-token'), error => error instanceof CloudApiError && !error.message.includes('synthetic-private-token'));
});

test('官方成功请求Authorization支持大小写scheme且只保留一次令牌', () => {
  const domain = 'https://api-euc1.plaud.ai';
  for (const authorization of ['Bearer synthetic-token', 'bearer synthetic-token', 'bEaReR synthetic-token', 'Authorization: bearer synthetic-token']) {
    assert.deepEqual(parseSuccessfulRequestAuthorization(authorization, domain), { userToken: 'synthetic-token', userApiDomain: domain });
  }
  for (const authorization of ['Basic synthetic-token', 'Bearer token\r\nX-Other: secret']) assert.throws(() => parseSuccessfulRequestAuthorization(authorization, domain), error => error instanceof CloudApiError && error.code === 'INVALID_BEARER_IMPORT' && !error.message.includes('synthetic'));
});

test('导出脚本兼容存储scheme及JSON封装，只复制两字段且不输出令牌', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const script = source.split('const WEB_SESSION_EXPORT_SCRIPT = String.raw`')[1]?.split('`;')[0];
  assert.ok(script, '页面需要保留可复制的官方导出脚本');
  for (const wrapped of [false, true]) {
    const token = 'bEaReR synthetic.jwt-value', messages: string[] = [];
    const storage: Record<string, string> = {
      pld_tokenstr: wrapped ? JSON.stringify(token) : token,
      tokenstr: 'bearer old-token',
      pld_plaud_user_api_domain: JSON.stringify({ domain: 'https://api-euc1.plaud.ai', timestamp: 1 }),
      plaud_user_api_domain: JSON.stringify({ domain: 'https://api.plaud.ai', timestamp: 1 }),
    };
    let copied = '';
    runInNewContext(script, {
      location: { hostname: 'web.plaud.ai' }, localStorage: { getItem: (key: string) => storage[key] ?? null },
      copy: (value: string) => { copied = value; }, console: { log: (value: string) => { messages.push(value); } },
    });
    assert.deepEqual(JSON.parse(copied), { userToken: 'synthetic.jwt-value', userApiDomain: 'https://api-euc1.plaud.ai' });
    assert.equal(messages.join(' ').includes('synthetic.jwt-value'), false);
  }
});

test('官方登录态只发本地导入端点，附带CSRF且不转发额外字段', async () => {
  await withFetch(call => call.url === '/api/session'
    ? json({ authenticated: false, csrfToken: 'guest-csrf' })
    : json({ authenticated: true, csrfToken: 'import-csrf', account: { accountId: 'test-user', email: 'test@example.invalid' }, devices: [] }), async calls => {
    const client = new CloudClient();
    const payload = { userToken: 'synthetic-web-token', userApiDomain: 'https://api-euc1.plaud.ai', refreshToken: 'do-not-forward' };
    const session = await client.importSession(payload);
    assert.equal(session.authenticated, true); assert.equal(calls.length, 2);
    assert.equal(calls[1].url, '/api/import-session'); assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].headers.get('X-CSRF-Token'), 'guest-csrf');
    assert.equal(calls[1].headers.get('Authorization'), null);
    assert.deepEqual(calls[1].body, { userToken: 'synthetic-web-token', userApiDomain: 'https://api-euc1.plaud.ai', remember: true });
  });
});

test('服务重启后恢复CSRF但不自动重发密码、导入令牌或密钥初始化请求', async () => {
  for (const mode of ['login', 'import-session', 'prepare-device']) {
    let sessionCount = 0, postCount = 0;
    await withFetch(call => {
      if (call.url === '/api/session') return json({ authenticated: false, csrfToken: `csrf-${++sessionCount}` });
      postCount++;
      return postCount === 1
        ? json({ error: { code: 'CSRF_REJECTED', message: 'stale session' } }, 403)
        : json({ authenticated: true, csrfToken: 'result-csrf', credentials: {}, device: {} });
    }, async calls => {
      const client = new CloudClient(); await client.session();
      const submit = () => mode === 'login'
        ? client.login('test@example.invalid', 'synthetic-password')
        : mode === 'import-session'
          ? client.importSession({ userToken: 'synthetic-web-token', userApiDomain: 'https://api-euc1.plaud.ai' })
          : client.prepare('test-device', 20, true);
      await assert.rejects(submit(), error => error instanceof CloudApiError && error.code === 'CSRF_REJECTED' && error.message.includes('重新提交'));
      assert.equal(postCount, 1, `${mode} 不得自动重发`);
      assert.deepEqual(calls.map(call => call.url), ['/api/session', `/api/${mode}`, '/api/session']);
      assert.equal(sessionCount, 2);
      await submit();
      assert.equal(calls[3].headers.get('X-CSRF-Token'), 'csrf-2');
      assert.equal(postCount, 2, '只有调用方再次明确提交后才发生第二次POST');
    });
  }
});

test('本地服务不可达与结构化云端错误分别提示', async () => {
  let unavailable = true;
  await withFetch(() => {
    if (unavailable) throw new TypeError('synthetic-local-private-error');
    return json({ error: { code: 'NETWORK_ERROR', message: 'PLAUD 云服务暂时不可达，请稍后重试。' } }, 503);
  }, async () => {
    const client = new CloudClient();
    await assert.rejects(client.session(), error => error instanceof CloudApiError && error.code === 'LOCAL_SERVICE_UNREACHABLE' && !error.message.includes('synthetic-local-private-error'));
    unavailable = false;
    await assert.rejects(client.session(), error => error instanceof CloudApiError && error.code === 'NETWORK_ERROR' && error.message.includes('PLAUD 云服务'));
  });
});

test('退出请求不携带登录密码或材料，后续请求使用退出后新CSRF', async () => {
  await withFetch(call => {
    if (call.url === '/api/session') return json({ authenticated: false, csrfToken: 'guest-csrf' });
    if (call.url === '/api/logout') return json({ authenticated: false, csrfToken: 'logout-csrf' });
    return json({ authenticated: true, csrfToken: 'account-csrf', account: { accountId: 'test-user', email: 'test@example.invalid' }, devices: [] });
  }, async calls => {
    const client = new CloudClient(); await client.login('test@example.invalid', 'synthetic-password');
    const session = await client.logout();
    assert.equal(session.authenticated, false);
    assert.equal(calls[2].url, '/api/logout'); assert.deepEqual(calls[2].body, { forgetLocalData: false });
    assert.equal(calls[2].headers.get('X-CSRF-Token'), 'account-csrf');
    await client.login('another@example.invalid', 'another-synthetic-password');
    assert.equal(calls[3].headers.get('X-CSRF-Token'), 'logout-csrf');
  });
});

test('不记住登录、清除本机数据与成功协议缓存参数明确透传', async () => {
  await withFetch(call => call.url === '/api/session' ? json({ authenticated: false, csrfToken: 'test-csrf' })
    : json({ authenticated: true, csrfToken: 'test-csrf', devices: [] }), async calls => {
    const client = new CloudClient();
    await client.login('test@example.invalid', 'synthetic-password', false);
    await client.importSession({ userToken: 'synthetic-web-token', userApiDomain: 'https://api-euc1.plaud.ai' }, false);
    await client.rememberDevice('synthetic-device', 20, '1.2.3');
    await client.logout(true);
    assert.equal(calls[1].body?.remember, false); assert.equal(calls[2].body?.remember, false);
    assert.equal(calls[3].url, '/api/device-memory');
    assert.deepEqual(calls[3].body, { serialNumber: 'synthetic-device', portVersion: 20, firmware: '1.2.3' });
    assert.equal(calls[3].headers.get('X-CSRF-Token'), 'test-csrf');
    assert.deepEqual(calls[4].body, { forgetLocalData: true });
  });
});

test('自动识别只将所选SN提交同源受CSRF保护接口，不要求用户填写版本', async () => {
  await withFetch(call => call.url === '/api/session' ? json({ authenticated: true, csrfToken: 'synthetic-csrf' }) : json({ serialNumber: '888TEST', portVersion: 20, firmware: 'V123', source: 'native-advertisement' }), async calls => {
    const client = new CloudClient(); await client.session();
    const result = await client.detectDevice('888TEST', new AbortController().signal);
    assert.equal(result.portVersion, 20); assert.equal(calls[1].url, '/api/detect-device');
    assert.deepEqual(calls[1].body, { serialNumber: '888TEST' });
    assert.equal(calls[1].headers.get('X-CSRF-Token'), 'synthetic-csrf');
  });
});

test('取消自动识别会中断fetch，提示取消而不是localhost拒绝访问', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  try {
    const abort = new AbortController(), task = new CloudClient().detectDevice('888TEST', abort.signal);
    abort.abort();
    await assert.rejects(task, error => error instanceof CloudApiError && error.code === 'OPERATION_CANCELLED');
  } finally { globalThis.fetch = original; }
});
