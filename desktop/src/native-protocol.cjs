'use strict';
const MAX_FRAME = 512 * 1024;
const MAX_PACKET = 32 * 1024 * 1024;
function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME) throw Error('NATIVE_FRAME_TOO_LARGE');
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length); return Buffer.concat([prefix, body]);
}
function frameReader(onMessage, onError) {
  let buffered = Buffer.alloc(0), failed = false;
  return bytes => {
    if (failed) return;
    buffered = Buffer.concat([buffered, bytes]);
    try {
      while (buffered.length >= 4) {
        const size = buffered.readUInt32LE(0);
        if (!size || size > MAX_FRAME) throw Error('INVALID_NATIVE_FRAME');
        if (buffered.length < size + 4) return;
        const value = JSON.parse(buffered.subarray(4, 4 + size).toString('utf8'));
        buffered = buffered.subarray(4 + size); onMessage(value);
      }
    } catch (error) { failed = true; buffered = Buffer.alloc(0); onError(error); }
  };
}
function packetFrames(id, action, payload) {
  const body = Buffer.from(JSON.stringify(payload ?? null));
  if (body.length > MAX_PACKET) throw Error('NATIVE_PACKET_TOO_LARGE');
  const frames = [{ kind: 'request', id, action, bytes: body.length, sha256: require('node:crypto').createHash('sha256').update(body).digest('hex') }];
  for (let offset = 0; offset < body.length; offset += 192 * 1024) frames.push({ kind: 'chunk', id, offset, data: body.subarray(offset, offset + 192 * 1024).toString('base64') });
  frames.push({ kind: 'complete', id }); return frames;
}
module.exports = { MAX_FRAME, MAX_PACKET, encodeFrame, frameReader, packetFrames };
