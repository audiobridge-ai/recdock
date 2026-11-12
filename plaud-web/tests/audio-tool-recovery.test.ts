import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { LibraryStore, subprocess } from '../server/library/store.ts';

function wav() {
  const b = Buffer.alloc(32044); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(32000, 40); return b;
}
test('音频工具按显式路径启动，信号中止不误判为坏音频', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recdock-tool-')), before = process.env.RECDOCK_FFMPEG;
  try {
    const tool = join(root, 'killed-tool'); await writeFile(tool, '#!/bin/sh\nkill -KILL $$\n', { mode: 0o700 }); process.env.RECDOCK_FFMPEG = tool;
    await assert.rejects(subprocess('ffmpeg', [], 5000), (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'FFMPEG_UNAVAILABLE');
  } finally { if (before === undefined) delete process.env.RECDOCK_FFMPEG; else process.env.RECDOCK_FFMPEG = before; await rm(root, { recursive: true, force: true }); }
});
test('工具恢复后重新导入相同原件会重新检查，并复用原录音而不永久停留在不支持状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recdock-tool-recovery-')), before = process.env.RECDOCK_FFMPEG;
  try {
    const store = new LibraryStore(join(root, 'library')); await store.init(); const bytes = wav();
    const failing = join(root, 'failing-tool'); await writeFile(failing, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    async function upload() {
      const meta = await store.createImport('scope_personal', { filename: 'real.wav', bytes: bytes.length, language: 'zh', source: { kind: 'import', deviceId: null, sessionId: null } });
      await store.upload('scope_personal', meta.id, 'original', Readable.from([bytes]) as unknown as IncomingMessage);
      return store.commit('scope_personal', meta.id);
    }
    process.env.RECDOCK_FFMPEG = failing; const first = await upload(); assert.equal(first.recording.state, 'unsupported');
    if (before === undefined) delete process.env.RECDOCK_FFMPEG; else process.env.RECDOCK_FFMPEG = before;
    const recovered = await upload(); assert.equal(recovered.recording.state, 'stored'); assert.equal(recovered.recording.id, first.recording.id); assert.equal(recovered.duplicate, true); assert.equal(recovered.recording.durationMs, 1000);
  } finally { if (before === undefined) delete process.env.RECDOCK_FFMPEG; else process.env.RECDOCK_FFMPEG = before; await rm(root, { recursive: true, force: true }); }
});
