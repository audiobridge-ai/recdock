'use strict';
const { timingSafeEqual } = require('node:crypto');
const { resolve, relative, isAbsolute, extname } = require('node:path');

function tokenEqual(input, token) {
  return typeof input === 'string' && Buffer.byteLength(input) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(input), Buffer.from(token));
}
function staticPath(root, pathname) {
  let name;
  try { name = decodeURIComponent(pathname); } catch { return null; }
  if (name.includes('\0') || name.includes('\\') || name.split('/').includes('..')) return null;
  const path = resolve(root, '.' + (name === '/' ? '/index.html' : name));
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? path : null;
}
function externalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const hosts = ['chatgpt.com', 'web.plaud.ai', 'github.com', 'huggingface.co', 'support.apple.com', 'recdock-plaud-web-chentiansabers-projects.vercel.app'];
    return hosts.includes(url.hostname) ? url.href : null;
  } catch { return null; }
}
function extensionId(key) {
  return require('node:crypto').createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
}
const mime = path => ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' }[extname(path)] || 'application/octet-stream');
module.exports = { tokenEqual, staticPath, externalUrl, extensionId, mime };
