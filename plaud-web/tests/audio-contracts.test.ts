import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAudioContract, AudioContractError } from '../server/transcription/contracts.ts';
import type { AudioContractMap } from '../src/library/types.ts';

interface Case { id: string; base: string; valid: boolean; patches: { path: (string | number)[]; value: unknown }[] }
const fixtures: { bases: Record<string, { kind: keyof AudioContractMap; data: unknown }>; cases: Case[] } =
  JSON.parse(readFileSync(new URL('../contracts/fixtures/contract-cases.json', import.meta.url), 'utf8'));

for (const c of fixtures.cases) test(`shared audio contract: ${c.id}`, () => {
  const base = fixtures.bases[c.base];
  const data = structuredClone(base.data);
  for (const patch of c.patches) {
    let target = data as Record<string | number, unknown>;
    for (const key of patch.path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
    target[patch.path.at(-1)!] = patch.value;
  }
  if (c.valid) assert.doesNotThrow(() => assertAudioContract(base.kind, data));
  else assert.throws(() => assertAudioContract(base.kind, data), AudioContractError);
});
