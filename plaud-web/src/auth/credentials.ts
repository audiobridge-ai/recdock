export interface Credentials {
  portVersion?: number;
  accountId: string;
  bindingToken: string;
  serialNumber: string;
  rsa: { snSignature: string; publicKeyPem: string; privateKeyPem: string; privateKeyHistory?: string[]; alternateCommand: boolean };
  ecc: { devicePublicKeyHex: string; userPrivateKeyHex: string };
  secondHandshake: { extra8: string; extraText: string };
}
export const emptyCredentials = (): Credentials => ({
  accountId: '', bindingToken: '', serialNumber: '',
  rsa: { snSignature: '', publicKeyPem: '', privateKeyPem: '', alternateCommand: false },
  ecc: { devicePublicKeyHex: '', userPrivateKeyHex: '' },
  secondHandshake: { extra8: '', extraText: '' },
});
const str = (v: unknown) => typeof v === 'string' ? v : '';
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function importCredentials(input: unknown): Credentials {
  const x = obj(input), data = obj(x.data), rsa = obj(x.rsa), ecc = obj(x.ecc), second = obj(x.secondHandshake);
  const c = emptyCredentials();
  if (x.portVersion !== undefined) {
    if (!Number.isInteger(x.portVersion) || Number(x.portVersion) < 1 || Number(x.portVersion) > 65535) throw new Error('portVersion 应为 1–65535 的整数');
    c.portVersion = Number(x.portVersion);
  }
  c.accountId = str(x.accountId) || str(x.user_id) || str(data.user_id) || str(x.uid) || str(data.uid);
  c.bindingToken = str(x.bindingToken);
  c.serialNumber = str(x.serialNumber) || str(x.sn);
  c.rsa = {
    snSignature: str(rsa.snSignature), publicKeyPem: str(rsa.publicKeyPem), privateKeyPem: str(rsa.privateKeyPem),
    alternateCommand: rsa.alternateCommand === true,
  };
  c.ecc = { devicePublicKeyHex: str(ecc.devicePublicKeyHex), userPrivateKeyHex: str(ecc.userPrivateKeyHex) };
  c.secondHandshake = { extra8: str(second.extra8), extraText: str(second.extraText) };
  if (!c.accountId && !c.bindingToken && ('access_token' in x || 'access_token' in data)) {
    throw new Error('该文件只有云端登录凭据。还需要当前绑定账号的 accountId / user_id，不能直接把 access_token 用作 BLE token。');
  }
  return c;
}
export const tokenSource = (c: Credentials) => c.bindingToken || c.accountId;
export function validateCredentials(c: Credentials): void {
  if (!Number.isInteger(c.portVersion) || !c.portVersion || c.portVersion < 1 || c.portVersion > 65535) throw new Error('请先准备设备实际的 portVersion，可从设备广播、账号绑定设备记录或手工导入获取');
  const token = tokenSource(c);
  if (!token) throw new Error('请填写绑定账号 ID 或 BLE token');
  if (/^(?:Bearer\s|eyJ[^.]*\.)/.test(token)) throw new Error('这里需要账号 ID / BLE token，不能使用登录 access_token');
  if (!/^[\x20-\x7e]+$/.test(token)) throw new Error('本工具要求账号 ID / BLE token 为 ASCII 字符串');
  if (c.portVersion === 20 && !c.serialNumber) throw new Error('port 20 需要目标设备 SN，请先选择账号绑定设备或导入认证配置');
  if (c.portVersion === 20 && (!c.rsa.snSignature || !c.rsa.publicKeyPem || !c.rsa.privateKeyPem)) throw new Error('port 20 需要先准备 SN 签名、RSA 公钥和私钥，再连接设备');
  if (c.portVersion === 30 && (!c.serialNumber || !c.ecc.devicePublicKeyHex || !c.ecc.userPrivateKeyHex)) throw new Error('port 30 重连需要 SN、设备长期公钥和用户 ECC 私钥');
}
