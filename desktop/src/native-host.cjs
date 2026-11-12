'use strict';
const net = require('node:net');
const { readFileSync, lstatSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { encodeFrame, frameReader } = require('./native-protocol.cjs');

function runHost(configPath) {
  const info = lstatSync(configPath);
  if (!info.isFile() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077)) throw Error('UNSAFE_NATIVE_CONFIGURATION');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const origin = process.argv.find(value => /^chrome-extension:\/\/[a-p]{32}\/$/.test(value));
  if (origin !== config.origin || !/^[a-f0-9]{64}$/.test(config.token)) throw Error('NATIVE_ORIGIN_REJECTED');
  const socket = net.connect(config.socketPath);
  let ready = false;
  const timer = setTimeout(() => { if (!ready) process.exit(1); }, 5000);
  const output = value => process.stdout.write(encodeFrame(value));
  socket.once('connect', () => socket.write(encodeFrame({ kind: 'hello', origin, token: config.token })));
  socket.on('data', frameReader(value => { if (value.kind === 'ready') { ready = true; clearTimeout(timer); } else if (ready) output(value); }, () => process.exit(1)));
  process.stdin.on('data', frameReader(value => { if (ready && value.kind === 'response') socket.write(encodeFrame(value)); }, () => process.exit(1)));
  socket.on('error', () => process.exit(1)); socket.on('close', () => process.exit(0));
  process.stdin.once('end', () => { socket.end(); });
}
if (require.main === module) {
  const support = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/RecDock') : join(process.env.APPDATA || homedir(), 'RecDock');
  try { runHost(join(support, 'desktop/native-config.json')); } catch { process.stderr.write('RecDock native bridge unavailable.\n'); process.exit(1); }
}
module.exports = { runHost };
