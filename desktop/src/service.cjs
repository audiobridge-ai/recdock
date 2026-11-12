'use strict';
const { createServer } = require('node:http');
const { createReadStream } = require('node:fs');
const { realpath, stat } = require('node:fs/promises');
const { resolve, relative, isAbsolute } = require('node:path');
const { pathToFileURL } = require('node:url');
const { tokenEqual, staticPath, mime } = require('./security.cjs');

async function startService({ workspace, publicRoot, token, port = 43128 }) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw Error('DESKTOP_TOKEN_REQUIRED');
  const { createApplication } = await import(pathToFileURL(resolve(workspace, 'server/application.js')).href);
  const { Vault } = await import(pathToFileURL(resolve(workspace, 'server/vault.js')).href);
  const app = createApplication({ library: { workspace }, store: new Vault({ filePath: process.env.RECDOCK_VAULT_FILE }) });
  await app.library.ready;
  const root = await realpath(publicRoot);
  const server = createServer((req, res) => {
    void (async () => {
      if (!tokenEqual(req.headers['x-recdock-desktop'], token)) { res.writeHead(403); res.end(); return; }
      const host = req.headers.host || '';
      if (!/^127\.0\.0\.1:\d+$/.test(host)) { res.writeHead(403); res.end(); return; }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        await app.middleware(req, res, () => { res.writeHead(404); res.end(); }); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      const path = staticPath(root, url.pathname);
      if (!path) { res.writeHead(404); res.end(); return; }
      let canonical, info;
      try { canonical = await realpath(path); info = await stat(canonical); } catch { res.writeHead(404); res.end(); return; }
      const rel = relative(root, canonical);
      if (!info.isFile() || rel.startsWith('..') || isAbsolute(rel)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', mime(canonical));
      res.setHeader('Content-Length', info.size);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if (req.method === 'HEAD') res.end();
      else createReadStream(canonical).on('error', () => res.destroy()).pipe(res);
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 15_000;
  await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  let closing;
  async function close() {
    closing ??= (async () => { server.close(); server.closeIdleConnections(); await app.close(); server.closeAllConnections(); })();
    return closing;
  }
  return { port: server.address().port, close };
}
if (require.main === module) {
  let service;
  const stop = () => { void service?.close().finally(() => process.exit(0)); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  startService({ workspace: process.env.RECDOCK_WORKSPACE, publicRoot: process.env.RECDOCK_PUBLIC_ROOT, token: process.env.RECDOCK_DESKTOP_TOKEN }).then(value => {
    service = value; process.stdout.write(JSON.stringify({ event: 'ready', port: value.port }) + '\n');
  }).catch(error => { process.stderr.write(JSON.stringify({ event: 'failed', code: error.code || 'START_FAILED' }) + '\n'); process.exit(1); });
}
module.exports = { startService };
