import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../application.ts';
import { CompanionBridge } from './bridge.ts';
import { Vault } from '../vault.ts';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.RECDOCK_COMPANION_PORT || 43127);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RECDOCK_COMPANION_PORT 必须在 1024–65535 之间。');
const bridge = new CompanionBridge((process.env.RECDOCK_WEB_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean), Date.now,
  process.env.RECDOCK_CONTROL_TOKEN && process.env.RECDOCK_TRUST_FILE ? { token: process.env.RECDOCK_CONTROL_TOKEN, trustFile: process.env.RECDOCK_TRUST_FILE, status: async () => app.library.environment() } : undefined);
const app = createApplication({ library: { workspace }, store: process.env.RECDOCK_VAULT_FILE ? new Vault({ filePath: process.env.RECDOCK_VAULT_FILE }) : undefined, authorizeRemote: bridge.authorize });
const server = createServer((req, res) => {
  void (async () => {
    if (await bridge.handle(req, res)) return;
    await app.middleware(req, res, () => { res.statusCode = 404; res.end(); });
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
});
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 15_000;
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? '助手端口已被占用，请使用已启动的助手，或更换 RECDOCK_COMPANION_PORT。' : ['EPERM', 'EACCES'].includes(error.code || '') ? '当前执行环境不允许监听本机端口，助手未启动。' : '助手启动失败。');
  void app.close().finally(() => process.exit(1));
});
async function stop() { server.close(); server.closeIdleConnections(); await app.close(); server.closeAllConnections(); }
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
server.listen(port, '127.0.0.1', () => {
  console.log(`RecDock 本地助手：http://127.0.0.1:${port}/`);
  console.log('请打开以上地址查看一次性配对码。助手仅监听本机，不提供公网转写。');
});
