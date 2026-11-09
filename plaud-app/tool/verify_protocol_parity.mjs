// Executes real Web and Dart codecs on the same valid/truncated/malformed frames.
// No test server, account, Bluetooth device or Flutter engine is required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { identifyPlaudAdvertisement, decodeAdvertisement } from '../../plaud-web/src/protocol/advertisement.ts';
import { decodeRecordingPage, decodeFileData } from '../../plaud-web/src/protocol/files.ts';
import { decodeBattery, decodeStorage, decodeHandshake } from '../../plaud-web/src/protocol/status.ts';

const cases = [];
const add = (op, hex, port) => cases.push({op, hex, ...(port === undefined ? {} : {port})});
const truncated = (op, hex, port) => {
  add(op, hex, port);
  for (let length = 2; length < hex.length; length += 2) add(op, hex.slice(0, length), port);
};
truncated('advertisement', '027803045608020209888001234567890000140000000000000101');
add('advertisement', '0278030456010000081234001234567890001e000100');
for (const project of ['888', '880', '881', '883', '882', '860']) {
  for (const length of [1, 3, 4, 5]) {
    for (const serial of [Buffer.from(`${project}0012345678900`, 'hex'), Buffer.from(`${project}0012345678900`)]) {
      add('advertisement', Buffer.concat([Buffer.from([length, 0x52]), Buffer.alloc(length - 1),
        Buffer.from([serial.length]), serial, Buffer.alloc(8)]).toString('hex'));
    }
  }
}
truncated('page', '011a00785634120200000004030201080706050209ffffffff000000000104', 20);
add('page', '011a0001000000010000000403020108070605', 1);
add('page', '011a000100000001000000040302010807060507', 6);
add('page', '011a000100000000000000', 20);
for (const port of [0, -1, 65536]) add('page', '011a000100000000000000', port);
truncated('data', '02ffffffff7856341203616263', 20);
add('data', '027856341203616263', 6);
for (const hex of ['0207000000ffffffff0005', '0207000000ffffffff01',
  '020700000000000000036162', '020700000000000000016162',
  '0207000000feffffff026162']) add('data', hex, 20);
truncated('battery', '0109000100');
add('battery', '0109000065');
truncated('storage', '0106000100000000000000ffffffffffffffff');
add('storage', '01060002000000000000000100000000000000');
truncated('handshake', '010100001400');

const expected = cases.map(row => {
  const frame = new Uint8Array(Buffer.from(row.hex, 'hex'));
  try {
    if (row.op === 'advertisement') {
      const identity = identifyPlaudAdvertisement(frame);
      if (!identity) return null;
      const protocol = decodeAdvertisement(frame);
      return {...identity, ...(protocol ? {portVersion: protocol.portVersion} : {})};
    }
    if (row.op === 'page') return decodeRecordingPage(frame, row.port);
    if (row.op === 'data') {
      const decoded = decodeFileData(frame, row.port);
      return {...decoded, data: Buffer.from(decoded.data).toString('hex')};
    }
    if (row.op === 'battery') return decodeBattery(frame);
    if (row.op === 'storage') return decodeStorage(frame);
    if (row.op === 'handshake') {
      const {status, portVersion} = decodeHandshake(frame);
      return {status, ...(portVersion === undefined ? {} : {portVersion})};
    }
    throw new Error('Unknown operation');
  } catch { return {error: true}; }
});
const result = spawnSync(process.env.RECDOCK_DART || 'dart', ['tool/protocol_probe.dart'], {
  cwd: new URL('..', import.meta.url), input: JSON.stringify(cases), encoding: 'utf8', timeout: 60000,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
const actual = JSON.parse(result.stdout);
const normalized = JSON.parse(JSON.stringify(expected, (_, value) => typeof value === 'bigint' ? String(value) : value));
assert.equal(actual.length, normalized.length);
actual.forEach((value, index) => assert.deepEqual(value, normalized[index], JSON.stringify(cases[index])));
console.log(`Web / Dart protocol parity: ${cases.length}/${cases.length} passed`);
