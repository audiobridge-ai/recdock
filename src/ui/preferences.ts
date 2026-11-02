import { parseBrowserDeviceBinding, savedAudioFormat } from './flow.ts';
import type { BrowserDeviceBinding } from './flow.ts';

export interface DevicePreference extends BrowserDeviceBinding {
  origin: string;
  verifiedPortVersion: number;
  lastUsed: number;
}
type FormatPreference = { kind: 'format'; origin: string; accountId: string; format: 'wav' | 'ogg' };
const DATABASE = 'plaud-workspace-preferences', STORE = 'entries', DEADLINE = 1200;

export function parseDevicePreference(value: unknown, origin: string, accountId: string, serialNumber: string): DevicePreference | undefined {
  const binding = parseBrowserDeviceBinding(value, accountId, serialNumber);
  if (!binding || binding.verifiedPortVersion === undefined) return;
  const data = value as Record<string, unknown>;
  if (data.origin !== origin || typeof data.lastUsed !== 'number' || !Number.isFinite(data.lastUsed) || data.lastUsed < 0) return;
  return { origin, accountId, serialNumber, browserDeviceId: binding.browserDeviceId,
    verifiedPortVersion: binding.verifiedPortVersion, lastUsed: data.lastUsed };
}

/** Best effort, non-secret preferences. IDB failures fall back to this page's memory. */
export class WorkspacePreferences {
  private origin: string;
  private factory: IDBFactory | undefined;
  private now: () => number;
  private database?: Promise<IDBDatabase | undefined>;
  private disabled = false;
  private memory = new Map<string, unknown>();
  constructor(origin: string, factory: IDBFactory | undefined = globalThis.indexedDB, now: () => number = Date.now) {
    this.origin = origin; this.factory = factory; this.now = now;
  }
  get persistent(): boolean { return !!this.factory && !this.disabled; }
  private deviceKey(accountId: string, serialNumber: string) { return JSON.stringify([this.origin, 'device', accountId, serialNumber]); }
  private formatKey(accountId: string) { return JSON.stringify([this.origin, 'format', accountId]); }
  private async open(): Promise<IDBDatabase | undefined> {
    if (!this.factory || this.disabled) return;
    if (!this.database) this.database = new Promise(resolve => {
      let finished = false;
      const finish = (database?: IDBDatabase) => {
        if (finished) { database?.close(); return; }
        finished = true; clearTimeout(timer); if (!database) this.disabled = true; resolve(database);
      };
      const timer = setTimeout(() => finish(), DEADLINE);
      try {
        const request = this.factory!.open(DATABASE, 1);
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
        request.onsuccess = () => { const database = request.result; database.onversionchange = () => { database.close(); this.disabled = true; }; finish(database); };
        request.onerror = () => finish(); request.onblocked = () => finish();
      } catch { finish(); }
    });
    return this.database;
  }
  private async run<T>(mode: IDBTransactionMode, initial: T, action: (store: IDBObjectStore, set: (value: T) => void) => void): Promise<{ ok: boolean; value: T }> {
    const database = await this.open();
    if (!database || this.disabled) return { ok: false, value: initial };
    return new Promise(resolve => {
      let finished = false, value = initial, transaction: IDBTransaction | undefined;
      const finish = (ok: boolean) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (!ok) { this.disabled = true; database.close(); }
        resolve({ ok, value: ok ? value : initial });
      };
      const timer = setTimeout(() => { try { transaction?.abort(); } catch { /* already complete */ } finish(false); }, DEADLINE);
      try {
        transaction = database.transaction(STORE, mode);
        transaction.oncomplete = () => finish(true); transaction.onabort = () => finish(false); transaction.onerror = () => finish(false);
        action(transaction.objectStore(STORE), result => { value = result; });
      } catch { finish(false); }
    });
  }
  async loadDevice(accountId: string, serialNumber: string): Promise<DevicePreference | undefined> {
    const key = this.deviceKey(accountId, serialNumber);
    const result = await this.run<unknown>('readonly', undefined, (store, set) => { const request = store.get(key); request.onsuccess = () => set(request.result); });
    const stored = parseDevicePreference(result.ok ? result.value : this.memory.get(key), this.origin, accountId, serialNumber);
    if (stored) this.memory.set(key, stored);
    return stored;
  }
  async loadDevices(accountId: string): Promise<DevicePreference[]> {
    const result = await this.run<unknown[]>('readonly', [], (store, set) => { const request = store.getAll(); request.onsuccess = () => set(request.result); });
    const devices = new Map<string, DevicePreference>();
    for (const value of [...this.memory.values(), ...(result.ok ? result.value : [])]) {
      if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).serialNumber !== 'string') continue;
      const serialNumber = (value as { serialNumber: string }).serialNumber;
      const parsed = parseDevicePreference(value, this.origin, accountId, serialNumber);
      if (parsed) { devices.set(serialNumber, parsed); this.memory.set(this.deviceKey(accountId, serialNumber), parsed); }
    }
    return [...devices.values()].sort((a, b) => b.lastUsed - a.lastUsed);
  }
  /** Call only after that account/SN has actually authenticated using this port. */
  async rememberDevice(accountId: string, serialNumber: string, browserDeviceId: string, verifiedPortVersion: number): Promise<boolean> {
    const value = parseDevicePreference({ origin: this.origin, accountId, serialNumber, browserDeviceId, verifiedPortVersion, lastUsed: this.now() }, this.origin, accountId, serialNumber);
    if (!value) return false;
    const key = this.deviceKey(accountId, serialNumber); this.memory.set(key, value);
    return (await this.run('readwrite', undefined, store => { store.put(value, key); })).ok;
  }
  async loadAudioFormat(accountId: string): Promise<'wav' | 'ogg'> {
    const key = this.formatKey(accountId);
    const result = await this.run<unknown>('readonly', undefined, (store, set) => { const request = store.get(key); request.onsuccess = () => set(request.result); });
    const value = (result.ok ? result.value : this.memory.get(key)) as Partial<FormatPreference> | undefined;
    if (value?.kind !== 'format' || value.origin !== this.origin || value.accountId !== accountId) return 'wav';
    const format = savedAudioFormat(value.format);
    this.memory.set(key, { kind: 'format', origin: this.origin, accountId, format });
    return format;
  }
  async saveAudioFormat(accountId: string, format: 'wav' | 'ogg'): Promise<boolean> {
    if (!accountId) return false;
    const key = this.formatKey(accountId), value: FormatPreference = { kind: 'format', origin: this.origin, accountId, format: savedAudioFormat(format) };
    this.memory.set(key, value);
    return (await this.run('readwrite', undefined, store => { store.put(value, key); })).ok;
  }
  async clearAccount(accountId: string): Promise<boolean> {
    const belongs = (key: unknown) => {
      if (typeof key !== 'string') return false;
      try { const data: unknown = JSON.parse(key); return Array.isArray(data) && data[0] === this.origin && data[2] === accountId; } catch { return false; }
    };
    for (const key of this.memory.keys()) if (belongs(key)) this.memory.delete(key);
    return (await this.run('readwrite', undefined, store => {
      const request = store.openCursor();
      request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if (belongs(cursor.key)) cursor.delete(); cursor.continue(); };
    })).ok;
  }
  async clearAll(): Promise<boolean> {
    this.memory.clear();
    return (await this.run('readwrite', undefined, store => { store.clear(); })).ok;
  }
}
