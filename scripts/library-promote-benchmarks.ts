/** Trusted local migration of the two already measured long recordings; no HTTP path input. */
import { constants, createReadStream } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LibraryService } from '../server/library/service.ts';
import { atomicJson, fileSha256, scopeFor, secureDirectory } from '../server/library/common.ts';

const workspace = process.cwd(), service = new LibraryService();
const samples = [
  { id: 'zh-long', language: 'zh' as const, filename: '02-24周会录音-飞飞.mp3' },
  { id: 'en-long', language: 'en' as const, filename: 'Steve Jobs & Bill Gates_ A Conversation That Shaped Technology.mp3' },
];
const output: object[] = [];
try {
  await service.ready;
  for (const sample of samples) {
    const original = join(homedir(), 'Downloads', 'audiobridge素材', '音频测试', sample.filename), directory = join(workspace, '.local-audio', 'benchmarks', sample.id);
    const prepared = JSON.parse(await readFile(join(directory, 'prepare.json'), 'utf8')) as { sourceSha256: string; chunks: { path: string }[] };
    if (await fileSha256(original) !== prepared.sourceSha256) throw Error('BENCHMARK_SOURCE_MISMATCH');
    const { stat } = await import('node:fs/promises');
    const upload = await service.store.createImport(scopeFor(), { filename: sample.filename, bytes: (await stat(original)).size, language: sample.language, source: { kind: 'import', deviceId: null, sessionId: null } });
    const stream = createReadStream(original) as unknown as IncomingMessage;
    await service.store.upload(scopeFor(), upload.id, 'original', stream);
    const { recording } = await service.store.commit(scopeFor(), upload.id);
    const fingerprint = await service.pipelineFingerprint(scopeFor(), recording.id, sample.language), target = join(service.store.recordingDir(scopeFor(), recording.id), 'work', fingerprint);
    await secureDirectory(target);
    const inferenceFiles = ['asr.json', 'align.json', 'diarize.json'];
    const benchmarkHashes = Object.fromEntries(await Promise.all(inferenceFiles.map(async file => [file, await fileSha256(join(directory, file))])));
    for (const file of ['prepare.json', 'decoded.wav', 'asr.json', 'align.json', 'diarize.json', ...prepared.chunks.map(c => c.path)]) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(file)) throw Error('BENCHMARK_ARTIFACT_PATH_INVALID');
      await copyFile(join(directory, file), join(target, file), constants.COPYFILE_FICLONE);
    }
    const job = await service.enqueue(scopeFor(), recording.id, sample.language);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const latest = await service.job(scopeFor(), job.id);
      if (latest.job.state === 'succeeded') break;
      if (latest.job.state === 'failed') throw Error(`BENCHMARK_PROMOTION_FAILED:${latest.job.error?.code}`);
      await new Promise(r => setTimeout(r, 500));
    }
    const completed = (await service.job(scopeFor(), job.id)).job;
    if (completed.state !== 'succeeded') throw Error('BENCHMARK_PROMOTION_TIMEOUT');
    const { transcript } = await service.store.transcript(scopeFor(), recording.id);
    const inferenceArtifacts = await Promise.all(inferenceFiles.map(async file => ({ file, benchmarkSha256: benchmarkHashes[file], publishedSha256: await fileSha256(join(target, file)) })));
    output.push({ sampleId: sample.id, recordingId: recording.id, jobId: job.id, state: completed.state, segments: transcript.segments.length, sourceSha256: recording.sourceSha256, cachePromotedFromMeasuredBenchmark: true, inferenceRerun: inferenceArtifacts.some(a => a.benchmarkSha256 !== a.publishedSha256), inferenceArtifacts });
    process.stdout.write(JSON.stringify(output.at(-1)) + '\n');
  }
  await atomicJson(join(workspace, '.local-audio', 'reports', 'library-benchmark-promotion.json'), output);
} finally { await service.close(); }
