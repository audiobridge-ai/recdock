'use strict';
const { join } = require('node:path');
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { privateJson } = require('./settings.cjs');
const { extensionId } = require('./security.cjs');
const HOST_NAME = 'ai.recdock.desktop';

async function registerNative({ support, resources, home, appSource, extensionSource }) {
  const manifest = JSON.parse(await readFile(join(extensionSource || join(resources, 'extension'), 'manifest.json'), 'utf8'));
  const id = extensionId(manifest.key), origin = `chrome-extension://${id}/`, folder = join(support, 'desktop');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const socketPath = join(folder, 'bridge.sock');
  const token = randomBytes(32).toString('hex');
  await privateJson(join(folder, 'native-config.json'), { socketPath, token, origin });
  if (process.platform !== 'darwin') throw Error('NATIVE_REGISTRATION_PLATFORM_NOT_READY');
  const launcher = join(folder, 'native-host-launcher.sh');
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  await writeFile(launcher, '#!/bin/sh\nexec ' + quote(join(resources, 'runtime/node')) + ' ' + quote(join(appSource, 'native-host.cjs')) + ' "$@"\n', { mode: 0o700 });
  const hostManifest = { name: HOST_NAME, description: 'RecDock desktop ChatGPT connection', path: launcher, type: 'stdio', allowed_origins: [origin] };
  for (const browser of ['Microsoft Edge', 'Google/Chrome']) {
    const destination = join(home, 'Library/Application Support', browser, 'NativeMessagingHosts');
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await privateJson(join(destination, HOST_NAME + '.json'), hostManifest);
  }
  return { socketPath, token, origin, extensionId: id };
}
module.exports = { registerNative, HOST_NAME };
