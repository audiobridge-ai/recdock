import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createECDH, createHmac, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { CloudError, PlaudCloudClient } from '../server/cloud-client.ts';
import type { CloudSession } from '../server/cloud-client.ts';

const SN = '888FIXTURE000001';
const EMAIL = 'fixture@example.com';
const PASSWORD = 'PRIVATE-password&汉字=+#';
const UT = 'PRIVATE-user-token';
const WT = 'PRIVATE-workspace-token';
const RT = 'PRIVATE-refresh-token';
const SIGNATURE = Buffer.from('fixture-device-signature').toString('base64');
const keyPair = () => generateKeyPairSync('rsa', {
  modulusLength: 1024,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
const keys = keyPair();
const otherKeys = keyPair();
const deviceList = (portVersion: number | undefined = 20) => ({ status: 0, data_devices: [{ sn: SN, name: '改名后的设备', model: 'NOTE', ...(portVersion === undefined ? {} : { prot_version: portVersion }), version_number: '1.2.3' }] });
const signed = () => ({ status: 0, data: { signature: { [SN]: SIGNATURE } } });
const session = (): CloudSession => ({ userToken: UT, userBaseUrl: 'https://api.plaud.ai', account: { accountId: 'fixture-account-id', email: EMAIL }, devices: [] });
const cache = () => ({ publicKeyPem: keys.publicKey, privateKeyPem: keys.privateKey, snSignature: SIGNATURE, alternateCommand: false });
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unavailableSecurity = () => new Response(null, { status: 503 });
type Call = { url: string; init: RequestInit; headers: Headers };
type MockReply = unknown | ((call: Call) => Response);
function mockFetch(...replies: MockReply[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const call: Call = { url: String(input), init, headers: new Headers(init.headers) };
    calls.push(call);
    if (!replies.length) throw new Error('Unexpected mock request');
    const reply = replies.shift();
    if (typeof reply === 'function') return reply(call);
    return reply instanceof Response ? reply : jsonResponse(reply);
  };
  return { fetchImpl, calls };
}
async function rejectsCode(promise: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CloudError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.httpStatus, status);
    return true;
  });
}
function encryptedResponse(body: unknown, corrupt = false) {
  // 独立编码 Fernet 帧，确保测试覆盖公开协议而非调用生产解密实现。
  const key = Buffer.from('8rRmMCskL3NaUiGr-UsmEEeI8NKH-ZfeGbpRGqSLpuI=', 'base64url');
  assert.equal(key.length, 32);
  const iv = Buffer.alloc(16, 0x29), timestamp = Buffer.alloc(8);
  const cipher = createCipheriv('aes-128-cbc', key.subarray(16), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
  const payload = Buffer.concat([Buffer.from([0x80]), timestamp, iv, ciphertext]);
  const signature = createHmac('sha256', key.subarray(0, 16)).update(payload).digest();
  const token = Buffer.concat([payload, signature]);
  if (corrupt) token[26] ^= 0x40;
  return new Response(token.toString('base64url'), { headers: { 'x-encrypt-response': '1' } });
}

test('官方配置503时登录按APK兼容form契约取得真实user_id和设备', async () => {
  const mock = mockFetch(unavailableSecurity(), { status: 0, access_token: UT }, { status: 0, data: { basic: { user_id: 'fixture-account-id' }, user_id: 'wrong-flat-id' } }, deviceList());
  const result = await new PlaudCloudClient(mock.fetchImpl).login(` ${EMAIL} `, PASSWORD);
  assert.deepEqual(result.account, { accountId: 'fixture-account-id', email: EMAIL });
  assert.equal(result.devices[0].serialNumber, SN);
  assert.equal(result.devices[0].name, '改名后的设备');
  assert.equal(result.devices[0].portVersion, 20);
  assert.equal(result.devices[0].firmware, '1.2.3');
  assert.equal(mock.calls.length, 4);
  const [config, login, profile, devices] = mock.calls;
  assert.equal(config.url, 'https://api.plaud.ai/config/security'); assert.equal(config.init.method, 'GET');
  assert.equal(config.init.body, undefined); assert.equal(config.headers.get('authorization'), null);
  assert.equal(login.url, 'https://api.plaud.ai/auth/access-token');
  assert.equal(login.init.method, 'POST');
  assert.equal(login.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(login.init.body))), { username: EMAIL, password: PASSWORD, password_encrypted: 'false', client_id: 'android' });
  assert.equal(login.headers.get('authorization'), null);
  assert.equal(login.headers.get('app-platform'), 'android');
  assert.equal(profile.url, 'https://api.plaud.ai/user-app/profile/account/me?setting&passport');
  assert.equal(profile.headers.get('authorization'), `Bearer ${UT}`);
  assert.equal(devices.url, 'https://api.plaud.ai/device-app/device/list');
  assert.ok(mock.calls.every(call => call.init.redirect === 'manual'));
  assert.equal(result.workspaceToken, undefined);
});

test('优先用secp256k1完整共享点和HKDF封装密码，服务器可解密pass/time，公共配置可复用', async () => {
  const serverPrivate = Buffer.alloc(32); serverPrivate[31] = 7;
  const serverPublic = secp256k1.getPublicKey(serverPrivate, false);
  const native = createECDH('secp256k1'); native.setPrivateKey(serverPrivate);
  assert.deepEqual(native.getPublicKey(), Buffer.from(serverPublic));
  const submitted: string[] = [], before = Math.floor(Date.now() / 1000);
  const acceptEncryptedLogin = (call: Call) => {
    assert.equal(call.url, 'https://api.plaud.ai/auth/access-token');
    assert.equal(call.headers.get('authorization'), null);
    const form = new URLSearchParams(String(call.init.body));
    assert.equal(form.get('password_encrypted'), 'true'); assert.equal(form.get('client_id'), 'android');
    assert.equal(form.get('username'), EMAIL);
    const value = form.get('password')!; assert.notEqual(value, PASSWORD); submitted.push(value);
    const sealed = Buffer.from(value, 'base64'), ephemeral = sealed.subarray(0, 65);
    assert.equal(sealed.toString('base64'), value); assert.equal(ephemeral[0], 4);
    const sharedPoint = secp256k1.getSharedSecret(serverPrivate, ephemeral, false);
    assert.equal(sharedPoint.length, 65);
    assert.deepEqual(native.computeSecret(ephemeral), Buffer.from(sharedPoint.subarray(1, 33)));
    const key = Buffer.from(hkdfSync('sha256', Buffer.concat([ephemeral, sharedPoint]), Buffer.alloc(0), Buffer.alloc(0), 32));
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(65, 81));
    decipher.setAuthTag(sealed.subarray(81, 97));
    const plaintext = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(97)), decipher.final()]).toString('utf8'));
    assert.deepEqual(Object.keys(plaintext), ['pass', 'time']); assert.equal(plaintext.pass, PASSWORD);
    assert.ok(Number.isSafeInteger(plaintext.time)); assert.ok(plaintext.time >= before && plaintext.time <= Math.floor(Date.now() / 1000));
    return jsonResponse({ status: 0, access_token: UT });
  };
  const profile = { status: 0, data: { basic: { user_id: 'fixture-account-id' } } };
  const mock = mockFetch(
    { status: 0, data: { pass_pub_key: Buffer.from(serverPublic).toString('hex'), pass_algorithm: 'secp256k1' } },
    acceptEncryptedLogin, profile, deviceList(), acceptEncryptedLogin, profile, deviceList(),
  );
  const client = new PlaudCloudClient(mock.fetchImpl);
  await client.login(EMAIL, PASSWORD); await client.login(EMAIL, PASSWORD);
  assert.equal(mock.calls.filter(call => call.url.endsWith('/config/security')).length, 1);
  assert.equal(submitted.length, 2); assert.notEqual(submitted[0], submitted[1]);
});

test('配置算法不支持时使用兼容回退，Fernet校验失败时绝不继续提交密码', async () => {
  const unsupported = mockFetch(
    { status: 0, data: { pass_algorithm: 'unknown', pass_pub_key: '04bad' } },
    { status: 0, access_token: UT }, { status: 0, data: { basic: { user_id: 'fixture-account-id' } } }, deviceList(),
  );
  await new PlaudCloudClient(unsupported.fetchImpl).login(EMAIL, PASSWORD);
  const fallback = new URLSearchParams(String(unsupported.calls[1].init.body));
  assert.equal(fallback.get('password_encrypted'), 'false'); assert.equal(fallback.get('password'), PASSWORD);
  const bad = mockFetch(encryptedResponse({ status: 0, data: { pass_algorithm: 'secp256k1' } }, true));
  await rejectsCode(new PlaudCloudClient(bad.fetchImpl).login(EMAIL, PASSWORD), 'ENCRYPTED_RESPONSE_INVALID');
  assert.equal(bad.calls.length, 1); assert.equal(bad.calls[0].url, 'https://api.plaud.ai/config/security');
  assert.equal(bad.calls[0].init.body, undefined);
});

test('profile缺少data.basic.user_id时不以flat user_id或token假装登录成功', async () => {
  const mock = mockFetch(unavailableSecurity(), { status: 0, access_token: UT }, { status: 0, user_id: 'wrong', data: { user_id: 'wrong' } });
  await rejectsCode(new PlaudCloudClient(mock.fetchImpl).login(EMAIL, PASSWORD), 'ACCOUNT_ID_MISSING', 409);
  assert.equal(mock.calls.length, 3);
});

test('导入官方网页登录态：在指定官方区域验证APP身份和设备，不请求密码或密钥', async () => {
  const mock = mockFetch({ status: 0, data: { basic: { user_id: 'verified-account' }, passport: { email: EMAIL } } }, deviceList());
  const imported = await new PlaudCloudClient(mock.fetchImpl).importSession(UT, 'https://api-euc1.plaud.ai/');
  assert.deepEqual(imported.account, { accountId: 'verified-account', email: EMAIL });
  assert.equal(imported.devices[0].serialNumber, SN);
  assert.equal(imported.userBaseUrl, 'https://api-euc1.plaud.ai');
  assert.equal(imported.workspaceToken, undefined); assert.equal(imported.rsaCache, undefined);
  assert.deepEqual(mock.calls.map(call => new URL(call.url).pathname), ['/user-app/profile/account/me', '/device-app/device/list']);
  assert.ok(mock.calls.every(call => call.headers.get('authorization') === `Bearer ${UT}` && call.init.method === 'GET'));
  const empty = mockFetch({ status: 0, data: { basic: { user_id: 'verified-account' } } }, { status: 0, data_devices: [] });
  const noDevices = await new PlaudCloudClient(empty.fetchImpl).importSession(UT, 'https://api-euc1.plaud.ai');
  assert.equal(noDevices.account.accountId, 'verified-account'); assert.deepEqual(noDevices.devices, []);
});

test('官方存储已有bearer前缀时只发送一次Bearer，401即失败且不推测调用重签或密钥接口', async () => {
  for (const value of [`bearer ${UT}`, `Bearer ${UT}`, `  bEaReR ${UT}  `]) {
    const mock = mockFetch({ status: 0, data: { basic: { user_id: 'verified-account' } } }, deviceList());
    const imported = await new PlaudCloudClient(mock.fetchImpl).importSession(value, 'https://api-euc1.plaud.ai');
    assert.equal(imported.userToken, UT);
    assert.ok(mock.calls.every(call => call.headers.get('authorization') === `Bearer ${UT}`));
    assert.equal(mock.calls.length, 2);
  }
  const rejected = mockFetch(new Response(null, { status: 401 }));
  await rejectsCode(new PlaudCloudClient(rejected.fetchImpl).importSession(UT, 'https://api-euc1.plaud.ai'), 'SESSION_EXPIRED', 401);
  assert.equal(rejected.calls.length, 1);
});

test('导入仅信云端校验结果，拒绝注入、非官方域名和不完整身份，不用JWT声明或旧缓存伪造成功', async () => {
  for (const token of ['', 'Basic injected', 'token\r\nInjected: yes', 't'.repeat(8193)]) {
    const mock = mockFetch();
    await rejectsCode(new PlaudCloudClient(mock.fetchImpl).importSession(token, 'https://api.plaud.ai'), 'SESSION_INPUT_INVALID', 400);
    assert.equal(mock.calls.length, 0);
  }
  const unsafe = mockFetch();
  await rejectsCode(new PlaudCloudClient(unsafe.fetchImpl).importSession(UT, 'https://api.plaud.ai.evil.example'), 'UNSAFE_API_HOST');
  assert.equal(unsafe.calls.length, 0);
  const missing = mockFetch({ status: 0, data: { user_id: 'untrusted-flat-id' } });
  await rejectsCode(new PlaudCloudClient(missing.fetchImpl).importSession(UT, 'https://api.plaud.ai'), 'ACCOUNT_ID_MISSING', 409);
  const noDevices = mockFetch({ status: 0, data: { basic: { user_id: 'verified' } } }, new Response(null, { status: 401 }));
  await rejectsCode(new PlaudCloudClient(noDevices.fetchImpl).importSession(UT, 'https://api.plaud.ai'), 'SESSION_EXPIRED', 401);
  assert.equal(noDevices.calls.length, 2);
});

test('云端403网页拦截与本地跨域拒绝分开报告，不暴露网页原文或登录材料', async () => {
  const mock = mockFetch(new Response(`<html>${UT}</html>`, { status: 403, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(new PlaudCloudClient(mock.fetchImpl).importSession(UT, 'https://api.plaud.ai'), (error: unknown) => {
    assert.ok(error instanceof CloudError); assert.equal(error.code, 'UPSTREAM_ACCESS_DENIED');
    assert.match(error.message, /403/); assert.match(error.message, /localhost/); assert.doesNotMatch(error.message, /PRIVATE-user-token|<html>/);
    return true;
  });
  assert.equal(mock.calls.length, 1);
});

test('缺失登录token与MFA分别失败，不把云端原文和密码放进异常', async () => {
  for (const [reply, code] of [
    [{ status: 0, msg: PASSWORD }, 'LOGIN_TOKEN_MISSING'],
    [{ status: 10001, msg: PASSWORD, data: { pre_token: UT, email_masked: EMAIL } }, 'MFA_REQUIRED'],
    [{ status: 12345, msg: `${PASSWORD}${EMAIL}${UT}` }, 'CLOUD_REQUEST_REJECTED'],
  ] as const) {
    const mock = mockFetch(unavailableSecurity(), reply);
    await assert.rejects(new PlaudCloudClient(mock.fetchImpl).login(EMAIL, PASSWORD), (error: unknown) => {
      assert.ok(error instanceof CloudError); assert.equal(error.code, code);
      for (const secret of [PASSWORD, EMAIL, UT]) assert.equal(error.message.includes(secret), false);
      return true;
    });
    assert.equal(mock.calls.length, 2);
  }
});

test('官方JSON区域指引最多重试一次，并把后续请求切换到该区域', async () => {
  const mock = mockFetch(unavailableSecurity(), { status: -302, data: { api: 'https://api-us.plaud.ai/' } }, { status: 0, access_token: UT }, { status: 0, data: { basic: { user_id: 'fixture-account-id' } } }, deviceList());
  const result = await new PlaudCloudClient(mock.fetchImpl).login(EMAIL, PASSWORD);
  assert.equal(result.userBaseUrl, 'https://api-us.plaud.ai');
  assert.equal(mock.calls[1].url, 'https://api.plaud.ai/auth/access-token');
  assert.ok(mock.calls.slice(2).every(call => call.url.startsWith('https://api-us.plaud.ai/')));
  const looping = mockFetch({ status: -302, data: { api: 'https://api-us.plaud.ai' } }, { status: -302, data: { api: 'https://api-eu.plaud.ai' } });
  await rejectsCode(new PlaudCloudClient(looping.fetchImpl).login(EMAIL, PASSWORD), 'REGION_REDIRECT_LIMIT');
  assert.equal(looping.calls.length, 2);
});

test('区域地址拒绝外域、非API子域、端口、凭据、路径、query以及非HTTPS', async () => {
  for (const api of [
    'https://evil.example', 'https://api.plaud.ai.evil.example', 'https://www.plaud.ai',
    'https://api.plaud.ai:443', 'https://user:password@api.plaud.ai',
    'https://api.plaud.ai/path', 'https://api.plaud.ai?api=evil',
    'http://api.plaud.ai', '//api.plaud.ai', 'https://api-.plaud.ai',
  ]) {
    const mock = mockFetch({ status: -302, data: { api } });
    await rejectsCode(new PlaudCloudClient(mock.fetchImpl).login(EMAIL, PASSWORD), 'UNSAFE_API_HOST');
    assert.equal(mock.calls.length, 1);
  }
});

test('HTTP302永不带凭据自动跟随，HTTP401明确要求重新登录', async () => {
  const redirect = mockFetch(new Response(null, { status: 302, headers: { location: 'https://evil.example' } }));
  await rejectsCode(new PlaudCloudClient(redirect.fetchImpl).login(EMAIL, PASSWORD), 'HTTP_REDIRECT_BLOCKED');
  assert.equal(redirect.calls.length, 1); assert.equal(redirect.calls[0].init.redirect, 'manual');
  const expired = mockFetch(new Response(null, { status: 401 }));
  await rejectsCode(new PlaudCloudClient(expired.fetchImpl).devices(session()), 'SESSION_EXPIRED', 401);
});

test('按APK Fernet协议验证HMAC后解密，篡改响应拒绝处理', async () => {
  const good = mockFetch(encryptedResponse(deviceList()));
  assert.equal((await new PlaudCloudClient(good.fetchImpl).devices(session()))[0].serialNumber, SN);
  const bad = mockFetch(encryptedResponse(deviceList(), true));
  await rejectsCode(new PlaudCloudClient(bad.fetchImpl).devices(session()), 'ENCRYPTED_RESPONSE_INVALID');
});

test('响应读取设置1MiB上限，底层网络错误不外泄原文', async () => {
  const tooLarge = mockFetch(new Response('x', { headers: { 'content-length': String(1024 * 1024 + 1) } }));
  await rejectsCode(new PlaudCloudClient(tooLarge.fetchImpl).devices(session()), 'RESPONSE_TOO_LARGE');
  const streamed = mockFetch(new Response('x'.repeat(1024 * 1024 + 1)));
  await rejectsCode(new PlaudCloudClient(streamed.fetchImpl).devices(session()), 'RESPONSE_TOO_LARGE');
  const broken = mockFetch(() => { throw new Error(`${PASSWORD} ${UT}`); });
  await assert.rejects(new PlaudCloudClient(broken.fetchImpl).devices(session()), (error: unknown) => {
    assert.ok(error instanceof CloudError); assert.equal(error.code, 'CLOUD_NETWORK_ERROR');
    assert.equal(error.message.includes(PASSWORD), false); assert.equal(error.message.includes(UT), false);
    return true;
  });
});

test('prepare会刷新绑定列表，已解绑SN不能准备认证材料', async () => {
  const current = session(); current.devices = [{ serialNumber: SN, name: '旧绑定', portVersion: 20 }];
  const mock = mockFetch({ status: 0, data_devices: [] });
  await rejectsCode(new PlaudCloudClient(mock.fetchImpl).prepare(current, SN, 20, true), 'DEVICE_NOT_BOUND', 403);
  assert.equal(mock.calls.length, 1); assert.deepEqual(current.devices, []);
});

test('显式指定只读缓存时不发签名、工作区或gen_key，正常连接不使用此选项', async () => {
  const mock = mockFetch(deviceList());
  await rejectsCode(new PlaudCloudClient(mock.fetchImpl).prepare(session(), SN, undefined, false), 'KEY_INITIALIZATION_REQUIRED', 409);
  assert.deepEqual(mock.calls.map(call => new URL(call.url).pathname), ['/device-app/device/list']);
});

test('复用会话RSA密钥时只刷新SN签名，不请求gen_key或工作区', async () => {
  const current = session(); current.rsaCache = cache();
  const mock = mockFetch(deviceList(), signed());
  const { credentials } = await new PlaudCloudClient(mock.fetchImpl).prepare(current, SN);
  assert.equal(credentials.accountId, 'fixture-account-id'); assert.equal(credentials.bindingToken, '');
  assert.equal(credentials.rsa.privateKeyPem, keys.privateKey); assert.equal(credentials.rsa.snSignature, SIGNATURE);
  assert.equal(credentials.portVersion, 20);
  assert.deepEqual(mock.calls.map(call => new URL(call.url).pathname), ['/device-app/device/list', '/device-app/device/sn-sign']);
  assert.equal(mock.calls[1].headers.get('authorization'), `Bearer ${UT}`);
  assert.deepEqual(JSON.parse(String(mock.calls[1].init.body)), { sns: [SN] });
});

test('首次连接默认按个人工作区UT→WT流程自动取得RSA；后续准备复用，不重复gen_key', async () => {
  const current = session();
  const mock = mockFetch(deviceList(), signed(), {
    status: 0, data: { workspaces: [
      { workspace_id: 'team-not-selected', workspace_type: 1 },
      { workspace_id: 'also-team', workspace_type: 0, type: 'TEAM' },
      { workspace_id: 'personal-fixture', workspace_type: 2, api_domain: 'api-us.plaud.ai' },
    ] },
  }, { status: 0, data: { workspace_token: WT, refresh_token: 'fixture-refresh-token' } }, {
    status: 0, data: {
      public_key: '', private_key: '',
      public_key_base64: Buffer.from(keys.publicKey).toString('base64'),
      private_key_base64: Buffer.from(keys.privateKey).toString('base64'),
    },
  }, deviceList(), signed());
  const client = new PlaudCloudClient(mock.fetchImpl);
  const { credentials } = await client.prepare(current, SN, 20);
  assert.equal(credentials.rsa.publicKeyPem, keys.publicKey); assert.equal(credentials.rsa.privateKeyPem, keys.privateKey);
  assert.deepEqual(current.rsaCache, credentials.rsa);
  assert.equal(current.workspaceToken, WT); assert.equal(current.workspaceId, 'personal-fixture');
  assert.equal(current.workspaceBaseUrl, 'https://api-us.plaud.ai');
  const workspaces = mock.calls[2], mint = mock.calls[3], gen = mock.calls[4];
  assert.equal(workspaces.url, 'https://api.plaud.ai/team-app/workspaces/list?need_personal_workspace=true&include_details=true');
  assert.equal(workspaces.headers.get('authorization'), `Bearer ${UT}`);
  assert.equal(mint.url, 'https://api-us.plaud.ai/user-app/auth/workspace/token/personal-fixture');
  assert.equal(mint.init.method, 'POST'); assert.equal(mint.init.body, undefined);
  assert.equal(mint.headers.get('authorization'), `Bearer ${UT}`);
  assert.equal(mint.headers.get('x-region-workspace-id'), 'personal-fixture');
  assert.equal(gen.url, 'https://api-us.plaud.ai/device-app/e2ee/gen_key');
  assert.equal(gen.headers.get('authorization'), `Bearer ${WT}`);
  assert.equal(gen.headers.get('content-type'), 'application/json'); assert.equal(gen.init.body, '{}');
  assert.equal((await client.prepare(current, SN, 20)).credentials.rsa.privateKeyPem, keys.privateKey);
  assert.equal(mock.calls.filter(call => new URL(call.url).pathname === '/device-app/e2ee/gen_key').length, 1);
});

test('工作区授权缺refresh_token时不拿UT冒充WT继续gen_key', async () => {
  const mock = mockFetch(deviceList(), signed(), { status: 0, data: [{ id: 'personal', type: 'PERSONAL', api_domain: '' }] }, { status: 0, data: { access_token: WT } });
  const current = session();
  await rejectsCode(new PlaudCloudClient(mock.fetchImpl).prepare(current, SN, 20, true), 'WORKSPACE_REQUIRED', 409);
  assert.equal(current.workspaceToken, undefined); assert.equal(mock.calls.length, 4);
  assert.ok(mock.calls.every(call => !call.url.includes('gen_key')));
});

test('仅有团队工作区或恶意workspace地址时停止，不自动授权团队', async () => {
  const team = mockFetch(deviceList(), signed(), { status: 0, data: [{ id: 'team', workspace_type: 1 }] });
  await rejectsCode(new PlaudCloudClient(team.fetchImpl).prepare(session(), SN, 20, true), 'WORKSPACE_SELECTION_REQUIRED', 409);
  assert.equal(team.calls.length, 3);
  const unsafe = mockFetch(deviceList(), signed(), { status: 0, data: [{ id: 'personal', type: 'PERSONAL', domains: { api: 'evil.example' } }] });
  await rejectsCode(new PlaudCloudClient(unsafe.fetchImpl).prepare(session(), SN, 20, true), 'UNSAFE_API_HOST');
  assert.equal(unsafe.calls.length, 3);
});

test('workspace JSON区域指引只更新工作区host和WT请求，不覆盖账号host', async () => {
  const current = session(); current.workspaceToken = WT; current.workspaceBaseUrl = 'https://api-us.plaud.ai';
  const mock = mockFetch(deviceList(), signed(), { status: -302, data: { domains: { api: 'https://api-eu.plaud.ai' } } }, { status: 0, data: { public_key: keys.publicKey, private_key: keys.privateKey } });
  await new PlaudCloudClient(mock.fetchImpl).prepare(current, SN, 20, true);
  assert.equal(current.userBaseUrl, 'https://api.plaud.ai'); assert.equal(current.workspaceBaseUrl, 'https://api-eu.plaud.ai');
  assert.equal(mock.calls[3].url, 'https://api-eu.plaud.ai/device-app/e2ee/gen_key');
  assert.equal(mock.calls[3].headers.get('authorization'), `Bearer ${WT}`);
});

test('公私钥不匹配时拒绝返回材料，已有损坏缓存不自动生成替代密钥', async () => {
  const current = session(); current.rsaCache = { ...cache(), privateKeyPem: otherKeys.privateKey };
  const mock = mockFetch(deviceList(), signed());
  await rejectsCode(new PlaudCloudClient(mock.fetchImpl).prepare(current, SN, 20, true), 'RSA_KEYS_INVALID', 409);
  assert.equal(mock.calls.length, 2);
});

test('非法或超过255个BLE分片的SN签名在返回浏览器前失败', async () => {
  for (const signature of ['not-valid-base64!', Buffer.alloc(25501, 1).toString('base64')]) {
    const current = session(); current.rsaCache = cache();
    const mock = mockFetch(deviceList(), { status: 0, data: { signature: { [SN]: signature } } });
    await rejectsCode(new PlaudCloudClient(mock.fetchImpl).prepare(current, SN), 'SN_SIGNATURE_INVALID', 409);
    assert.equal(mock.calls.length, 2);
  }
});

test('协议版本来自实参或云prot_version，未知版本不按型号猜测，ECC明确提示手工配置', async () => {
  const unknown = mockFetch({ status: 0, data_devices: [{ sn: SN, model: 'NOTE' }] });
  await rejectsCode(new PlaudCloudClient(unknown.fetchImpl).prepare(session(), SN), 'PORT_VERSION_REQUIRED', 409);
  const legacy = mockFetch(deviceList(9));
  const { credentials } = await new PlaudCloudClient(legacy.fetchImpl).prepare(session(), SN);
  assert.equal(credentials.portVersion, 9); assert.equal(credentials.accountId, 'fixture-account-id'); assert.equal(legacy.calls.length, 1);
  const ecc = mockFetch(deviceList(30));
  await rejectsCode(new PlaudCloudClient(ecc.fetchImpl).prepare(session(), SN), 'UNSUPPORTED_AUTO_ECC', 409);
  assert.equal(ecc.calls.length, 1);
});

test('仅接受auto区域，任意用户API URL不能进入登录请求', async () => {
  const mock = mockFetch();
  await rejectsCode(new PlaudCloudClient(mock.fetchImpl).login(EMAIL, PASSWORD, 'https://api.plaud.ai'), 'UNSUPPORTED_REGION', 400);
  assert.equal(mock.calls.length, 0);
});

const profile = (accountId = 'fixture-account-id') => ({ status: 0, data: { basic: { user_id: accountId }, passport: { email: EMAIL } } });
const renewed = (expiry?: number) => ({ status: 0, access_token: 'renewed-user-token', refresh_token: 'renewed-refresh-token', token_type: 'bearer', ...(expiry === undefined ? {} : { ut_expire_at: expiry }) });

test('登录保留refresh_token和Unix秒ut_expire_at，旧access-only登录仍兼容', async () => {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const mock = mockFetch(unavailableSecurity(), { status: 0, access_token: UT, refresh_token: RT, ut_expire_at: expires }, profile(), deviceList());
  const loggedIn = await new PlaudCloudClient(mock.fetchImpl).login(EMAIL, PASSWORD);
  assert.equal(loggedIn.refreshToken, RT); assert.equal(loggedIn.utExpireAt, expires);
  assert.equal(mock.calls.length, 4);
  assert.ok(mock.calls.every(call => call.headers.get('app-refresh-token-flag') === '1'));
});

test('refresh按APK用RT Bearer和空JSON体请求，Fernet响应原子旋转完整token对', async () => {
  const current = session(); current.refreshToken = RT; current.rsaCache = cache();
  current.utExpireAt = 1;
  const rsa = current.rsaCache, mock = mockFetch(encryptedResponse(renewed(2000000000)));
  await new PlaudCloudClient(mock.fetchImpl).refreshUserToken(current);
  assert.equal(current.userToken, 'renewed-user-token'); assert.equal(current.refreshToken, 'renewed-refresh-token');
  assert.equal(current.utExpireAt, 2000000000); assert.equal(current.rsaCache, rsa);
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0]; assert.equal(call.url, 'https://api.plaud.ai/auth/refresh-user-token');
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.body, '');
  assert.equal(call.headers.get('content-type'), 'application/json');
  assert.equal(call.headers.get('authorization'), `Bearer ${RT}`);
  assert.equal(call.headers.get('x-plaud-internal-override-authtoken'), null);
});

test('refresh成功缺少任一token、非法token或加密校验失败均不覆盖旧token/RSA', async () => {
  for (const reply of [
    { status: 0, access_token: 'new-ut' }, { status: 0, refresh_token: 'new-rt' },
    { status: 0, access_token: 'new-ut', refresh_token: 'Bearer bad' },
    encryptedResponse(renewed(), true),
  ]) {
    const current = session(); current.refreshToken = RT; current.utExpireAt = 123; current.rsaCache = cache();
    const before = structuredClone(current), mock = mockFetch(reply);
    await assert.rejects(new PlaudCloudClient(mock.fetchImpl).refreshUserToken(current), CloudError);
    assert.deepEqual(current, before); assert.equal(mock.calls.length, 1);
  }
});

test('缺少RT、RT失效401及网络错误不删除RSA，也不尝试其他刷新端点', async () => {
  const noRefresh = session(); noRefresh.rsaCache = cache(); const noCalls = mockFetch();
  await rejectsCode(new PlaudCloudClient(noCalls.fetchImpl).refreshUserToken(noRefresh), 'SESSION_EXPIRED', 401);
  assert.equal(noCalls.calls.length, 0); assert.ok(noRefresh.rsaCache);
  for (const [reply, code] of [
    [new Response(null, { status: 401 }), 'SESSION_EXPIRED'],
    [new Response(null, { status: 503 }), 'UPSTREAM_HTTP_ERROR'],
    [() => { throw new Error(`${UT} ${RT} ${PASSWORD}`); }, 'CLOUD_NETWORK_ERROR'],
  ] as const) {
    const current = session(); current.refreshToken = RT; current.rsaCache = cache();
    const before = structuredClone(current), mock = mockFetch(reply);
    await rejectsCode(new PlaudCloudClient(mock.fetchImpl).refreshUserToken(current), code);
    assert.deepEqual(current, before); assert.equal(mock.calls.length, 1);
    assert.ok(mock.calls[0].url.endsWith('/auth/refresh-user-token'));
  }
});

test('refresh的409/-4302有限重试，其他409不自动重试', async () => {
  const conflict = () => jsonResponse({ status: -4302, msg: `${RT}${PASSWORD}` }, 409);
  const current = session(); current.refreshToken = RT;
  const mock = mockFetch(conflict(), conflict(), conflict());
  await rejectsCode(new PlaudCloudClient(mock.fetchImpl).refreshUserToken(current), 'TOKEN_REFRESH_CONFLICT', 409);
  assert.equal(mock.calls.length, 3); assert.equal(current.refreshToken, RT);
  assert.ok(mock.calls.every(call => call.headers.get('authorization') === `Bearer ${RT}`));
  const other = mockFetch(jsonResponse({ status: -4301 }, 409));
  await rejectsCode(new PlaudCloudClient(other.fetchImpl).refreshUserToken(current), 'CLOUD_REQUEST_REJECTED', 409);
  assert.equal(other.calls.length, 1);
});

test('同RT跨CloudSession对象并发续期共享一次请求，各自接收rotation结果', async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl: typeof fetch = async () => { calls++; await gate; return jsonResponse(renewed()); };
  const first = session(), second = session(); first.refreshToken = RT; second.refreshToken = RT;
  const client = new PlaudCloudClient(fetchImpl);
  const tasks = [client.refreshUserToken(first), client.refreshUserToken(first), client.refreshUserToken(second)];
  assert.equal(calls, 1); release(); await Promise.all(tasks);
  assert.equal(first.refreshToken, 'renewed-refresh-token'); assert.equal(second.userToken, 'renewed-user-token');
});

test('续期期间被替换的登录会话不被迟到成功或401覆盖', async () => {
  for (const response of [jsonResponse(renewed()), new Response(null, { status: 401 })]) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const current = session(); current.refreshToken = RT;
    const client = new PlaudCloudClient(async () => { await gate; return response; });
    const pending = client.refreshUserToken(current);
    current.userToken = 'replacement-ut'; current.refreshToken = 'replacement-rt';
    release(); await rejectsCode(pending, 'SESSION_CHANGED', 409);
    assert.equal(current.userToken, 'replacement-ut'); assert.equal(current.refreshToken, 'replacement-rt');
  }
});

test('UT scope GET 401仅续期并回放一次，回放仍401时明确会话过期', async () => {
  const current = session(); current.refreshToken = RT;
  const mock = mockFetch(new Response(null, { status: 401 }), renewed(), deviceList());
  assert.equal((await new PlaudCloudClient(mock.fetchImpl).devices(current))[0].serialNumber, SN);
  assert.deepEqual(mock.calls.map(call => new URL(call.url).pathname), ['/device-app/device/list', '/auth/refresh-user-token', '/device-app/device/list']);
  assert.deepEqual(mock.calls.map(call => call.headers.get('authorization')), [`Bearer ${UT}`, `Bearer ${RT}`, 'Bearer renewed-user-token']);
  const twice = session(); twice.refreshToken = RT;
  const rejected = mockFetch(new Response(null, { status: 401 }), renewed(), new Response(null, { status: 401 }));
  await rejectsCode(new PlaudCloudClient(rejected.fetchImpl).devices(twice), 'SESSION_EXPIRED', 401);
  assert.equal(rejected.calls.length, 3);
});

test('提前300秒续期按秒换算，60秒内不因短expiry重复主动续期', async t => {
  let now = 2000000000000; t.mock.method(Date, 'now', () => now);
  const current = session(); current.refreshToken = RT; current.utExpireAt = now / 1000 + 120;
  const mock = mockFetch(renewed(now / 1000 + 120), deviceList(), deviceList(), renewed(now / 1000 + 600), deviceList());
  const client = new PlaudCloudClient(mock.fetchImpl);
  await client.devices(current); await client.devices(current);
  assert.equal(mock.calls.filter(call => call.url.endsWith('/refresh-user-token')).length, 1);
  now += 61000; await client.devices(current);
  assert.equal(mock.calls.filter(call => call.url.endsWith('/refresh-user-token')).length, 2);
  assert.equal(current.utExpireAt, 2000000600);
});

test('restore在线重新核验身份和设备，保留同账号RSA/最近连接时间且丢弃持久WT', async () => {
  const current = session(); current.rsaCache = cache(); current.workspaceToken = WT;
  current.workspaceId = 'personal'; current.workspaceBaseUrl = 'https://api-us.plaud.ai';
  current.devices = [{ serialNumber: SN, name: '旧名', lastConnectedAt: 123456 }];
  const rsa = current.rsaCache, mock = mockFetch(profile(), deviceList());
  assert.equal(await new PlaudCloudClient(mock.fetchImpl).restore(current), current);
  assert.equal(current.rsaCache, rsa); assert.equal(current.devices[0].name, '改名后的设备');
  assert.equal(current.devices[0].lastConnectedAt, 123456); assert.equal(current.workspaceToken, undefined);
  assert.deepEqual(mock.calls.map(call => new URL(call.url).pathname), ['/user-app/profile/account/me', '/device-app/device/list']);
  assert.ok(mock.calls.every(call => call.init.method === 'GET'));
});

test('restore身份不一致或缺少身份不能复用保存的RSA，网络失败也不销毁材料', async () => {
  for (const [reply, code] of [
    [profile('another-account'), 'SESSION_ACCOUNT_MISMATCH'],
    [{ status: 0, data: { user_id: 'fixture-account-id' } }, 'ACCOUNT_ID_MISSING'],
    [new Response(null, { status: 401 }), 'SESSION_EXPIRED'],
    [() => { throw new Error('offline'); }, 'CLOUD_NETWORK_ERROR'],
  ] as const) {
    const current = session(); current.rsaCache = cache(); const before = structuredClone(current);
    const mock = mockFetch(reply);
    await rejectsCode(new PlaudCloudClient(mock.fetchImpl).restore(current), code);
    assert.deepEqual(current, before); assert.equal(mock.calls.length, 1);
  }
});

test('restore后续验证失败时仍可原地取得已旋转token供vault finally保存，绝不生成RSA', async () => {
  const current = session(); current.refreshToken = RT; current.utExpireAt = 1; current.rsaCache = cache();
  const rsa = current.rsaCache, mock = mockFetch(renewed(), () => { throw new Error('offline after rotation'); });
  await rejectsCode(new PlaudCloudClient(mock.fetchImpl).restore(current), 'CLOUD_NETWORK_ERROR');
  assert.equal(current.userToken, 'renewed-user-token'); assert.equal(current.refreshToken, 'renewed-refresh-token');
  assert.equal(current.rsaCache, rsa); assert.equal(current.utExpireAt, undefined);
  assert.equal(mock.calls.length, 2); assert.ok(mock.calls.every(call => !call.url.includes('gen_key')));
});

test('prepare临近过期先续期，SN签名POST收到401不盲目重放', async () => {
  const current = session(); current.refreshToken = RT; current.utExpireAt = 1; current.rsaCache = cache();
  const mock = mockFetch(renewed(), deviceList(), new Response(null, { status: 401 }));
  await rejectsCode(new PlaudCloudClient(mock.fetchImpl).prepare(current, SN), 'SESSION_EXPIRED', 401);
  assert.deepEqual(mock.calls.map(call => new URL(call.url).pathname), ['/auth/refresh-user-token', '/device-app/device/list', '/device-app/device/sn-sign']);
  assert.equal(mock.calls[2].headers.get('authorization'), 'Bearer renewed-user-token');
  assert.equal(current.refreshToken, 'renewed-refresh-token'); assert.ok(current.rsaCache);
});

test('WT scope gen_key 401只失效WT，不拿UT/RT重放；下次显式prepare可重新授予WT', async () => {
  const current = session(); current.refreshToken = RT; current.workspaceToken = WT; current.workspaceBaseUrl = 'https://api-us.plaud.ai';
  const mock = mockFetch(deviceList(), signed(), new Response(null, { status: 401 }),
    deviceList(), signed(), { status: 0, data: [{ workspace_id: 'personal', type: 'PERSONAL', api_domain: 'api-us.plaud.ai' }] },
    { status: 0, data: { workspace_token: 'new-workspace-token', refresh_token: 'workspace-refresh-token' } },
    { status: 0, data: { public_key: keys.publicKey, private_key: keys.privateKey } });
  const client = new PlaudCloudClient(mock.fetchImpl);
  await rejectsCode(client.prepare(current, SN, 20, true), 'WORKSPACE_SESSION_EXPIRED', 409);
  assert.equal(mock.calls.length, 3); assert.equal(current.workspaceToken, undefined); assert.equal(current.refreshToken, RT);
  assert.equal(current.rsaCache, undefined);
  assert.equal((await client.prepare(current, SN, 20, true)).credentials.rsa.privateKeyPem, keys.privateKey);
  assert.equal(mock.calls[7].headers.get('authorization'), 'Bearer new-workspace-token');
  assert.ok(mock.calls.every(call => !call.url.includes('/auth/refresh-user-token')));
});
