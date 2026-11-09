import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import type { CloudDevice, CloudSession } from './cloud-client.ts';
import type { Credentials } from '../src/auth/credentials.ts';
import { validateCredentials } from '../src/auth/credentials.ts';
import type { VaultAccount, VaultData } from './vault.ts';

export type PersistenceStore = {
  load(): Promise<VaultData>;
  update(mutator: (draft: VaultData) => void | Promise<void>): Promise<void>;
};
export const safeAccountId = (id: string) => !!id && id.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(id);
export const offlineLifetime = 30 * 24 * 60 * 60 * 1000;
export function savedAccount(data: VaultData, id: string): VaultAccount | undefined {
  return safeAccountId(id) && Object.hasOwn(data.accounts, id) ? data.accounts[id] : undefined;
}
export function accountEntry(data: VaultData, auth: CloudSession): VaultAccount {
  const id = auth.account.accountId;
  if (!safeAccountId(id)) throw new Error('Invalid account');
  return savedAccount(data, id) ?? (data.accounts[id] = { account: auth.account, rsaKeys: [], devices: {} });
}
export function retainKey(account: VaultAccount, rsa: Credentials['rsa'] | undefined, now: number) {
  if (!rsa?.privateKeyPem || !rsa.publicKeyPem) return;
  const pub = createPublicKey(rsa.publicKeyPem), priv = createPrivateKey(rsa.privateKeyPem);
  if (pub.asymmetricKeyType !== 'rsa' || priv.asymmetricKeyType !== 'rsa') throw new Error('Invalid key');
  const der = pub.export({ type: 'spki', format: 'der' });
  if (!der.equals(createPublicKey(priv).export({ type: 'spki', format: 'der' }))) throw new Error('Invalid key pair');
  const fingerprint = createHash('sha256').update(der).digest('hex');
  if (!account.rsaKeys.some(key => key.fingerprint === fingerprint)) account.rsaKeys.push({ fingerprint, publicKeyPem: rsa.publicKeyPem, privateKeyPem: rsa.privateKeyPem, createdAt: now });
}
export function injectAccountKeys(auth: CloudSession, account: VaultAccount | undefined) {
  if (!account) return;
  const latest = account.rsaKeys.at(-1);
  if (latest) auth.rsaCache = { publicKeyPem: latest.publicKeyPem, privateKeyPem: latest.privateKeyPem, snSignature: '', alternateCommand: false };
}
export function withKeyHistory(credentials: Credentials, account: VaultAccount | undefined): Credentials {
  const result = structuredClone(credentials);
  result.rsa.privateKeyHistory = [...new Set(account?.rsaKeys.map(k => k.privateKeyPem).filter(key => key !== result.rsa.privateKeyPem) ?? [])];
  return result;
}
export function compatibleMemory(device: CloudDevice, memory: VaultAccount['devices'][string] | undefined) {
  return memory && (device.firmware ? memory.verifiedFirmware === device.firmware : !memory.verifiedFirmware);
}
export function publicDevices(auth: CloudSession, account: VaultAccount | undefined) {
  return auth.devices.map(device => {
    const memory = account?.devices[device.serialNumber];
    return { ...device,
      ...(compatibleMemory(device, memory) && memory?.verifiedPortVersion ? { portVersion: memory.verifiedPortVersion } : {}),
      ...(memory?.verifiedAt ? { lastConnectedAt: memory.verifiedAt } : {}) };
  });
}
export function cachedDevice(auth: CloudSession, account: VaultAccount | undefined, serialNumber: string, portVersion?: number) {
  const device = auth.devices.find(row => row.serialNumber === serialNumber);
  const memory = account?.devices[serialNumber];
  const credentials = memory?.credentials;
  if (!device || !memory || !credentials || credentials.accountId !== auth.account.accountId || credentials.serialNumber !== serialNumber) return;
  if (device.firmware !== memory.device.firmware) return;
  const verified = compatibleMemory(device, memory) ? memory.verifiedPortVersion : undefined;
  const port = portVersion ?? verified ?? device.portVersion;
  if (!port || credentials.portVersion !== port) return;
  try { validateCredentials(credentials); } catch { return; }
  return { credentials: withKeyHistory(credentials, account), device, source: 'cache' as const,
    portSource: portVersion !== undefined ? 'provided' as const : verified ? 'verified' as const : 'cloud' as const };
}
