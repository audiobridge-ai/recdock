import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { atomicJson, isMissing } from '../library/common.ts';

export interface SavedGrant { tokenHash: string; origin: string; createdAt: number; expires: number }

/** This file never contains a usable browser credential or a business session. */
export class TrustStore {
  private file: string;
  private writes: Promise<void> = Promise.resolve();
  constructor(file: string) { this.file = file; }
  async load(): Promise<SavedGrant[]> {
    let handle;
    try { handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('TRUST_STORE_UNSAFE');
      const value = JSON.parse(await handle.readFile('utf8'));
      if (value.version !== 1 || !Array.isArray(value.grants) || value.grants.length > 32) throw new Error('TRUST_STORE_INVALID');
      for (const grant of value.grants) {
        if (!/^[a-f0-9]{64}$/.test(grant.tokenHash) || typeof grant.origin !== 'string' || !Number.isSafeInteger(grant.createdAt) || !Number.isSafeInteger(grant.expires) || grant.createdAt >= grant.expires) throw new Error('TRUST_STORE_INVALID');
      }
      return value.grants;
    } finally { await handle.close(); }
  }
  save(grants: SavedGrant[]): Promise<void> {
    const snapshot = { version: 1, grants: grants.map(grant => ({ ...grant })) };
    const next = this.writes.then(() => atomicJson(this.file, snapshot));
    this.writes = next.catch(() => {});
    return next;
  }
}
