'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFrame, frameReader, packetFrames, MAX_FRAME } = require('../src/native-protocol.cjs');

test('native framing survives fragmented and coalesced transport without losing Chinese text', () => {
  const input = [{ kind: 'hello', text: '完整转写稿' }, { kind: 'response', id: 'one', result: { bound: true } }];
  const bytes = Buffer.concat(input.map(encodeFrame)), output = [];
  const read = frameReader(value => output.push(value), error => { throw error; });
  for (let i = 0; i < bytes.length; i += 3) read(bytes.subarray(i, i + 3));
  assert.deepEqual(output, input);
});
test('native frames reject oversized or malformed lengths before processing JSON', () => {
  let errors = 0, output = 0; const read = frameReader(() => output++, () => errors++);
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(MAX_FRAME + 1); read(prefix); read(encodeFrame({ later: true }));
  assert.equal(errors, 1); assert.equal(output, 0);
});
test('a multi-megabyte full transcript travels in bounded frames and is validated before assembly', async () => {
  const { createAssembler } = await import('../../plaud-web/extensions/chatgpt-bridge/native-client.mjs');
  const original = { content: '这是不能截断的录音全文。\n'.repeat(150000), prompt: '请保留时间与说话人。' };
  const frames = packetFrames('large-test', 'start', original), receive = createAssembler(); let result;
  assert.ok(frames.length > 10);
  for (const frame of frames) { assert.ok(encodeFrame(frame).length < MAX_FRAME); result = await receive(frame) || result; }
  assert.deepEqual(result, { id: 'large-test', action: 'start', payload: original });
});
test('missing, duplicated or modified transcript chunks never become a send request', async () => {
  const { createAssembler } = await import('../../plaud-web/extensions/chatgpt-bridge/native-client.mjs');
  const frames = packetFrames('tamper-test', 'start', { content: '不可篡改的稿件' });
  const missing = createAssembler(); await missing(frames[0]); await assert.rejects(() => missing(frames.at(-1)), /Incomplete/);
  const duplicate = createAssembler(); await duplicate(frames[0]); await duplicate(frames[1]); await assert.rejects(() => duplicate(frames[1]), /Invalid native chunk/);
  const tampered = createAssembler(); await tampered({ ...frames[0], sha256: '0'.repeat(64) }); await tampered(frames[1]); await assert.rejects(() => tampered(frames.at(-1)), /integrity/);
});
