'use strict';
const net = require('node:net');
const { chmod, unlink } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { encodeFrame, frameReader, packetFrames } = require('./native-protocol.cjs');
const { tokenEqual } = require('./security.cjs');

class NativeBroker {
  constructor({ socketPath, token, origin }) { Object.assign(this, { socketPath, token, origin }); this.pending = new Map(); this.client = null; }
  async start() {
    await unlink(this.socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    this.server = net.createServer(socket => {
      let authorized = false;
      const helloTimer = setTimeout(() => socket.destroy(), 3000);
      const read = frameReader(value => {
        if (!authorized) {
          if (value.kind !== 'hello' || value.origin !== this.origin || !tokenEqual(value.token, this.token)) { socket.destroy(); return; }
          authorized = true; clearTimeout(helloTimer);
          if (this.client && this.client !== socket) this.client.destroy();
          this.client = socket; socket.write(encodeFrame({ kind: 'ready', protocol: 1 })); return;
        }
        if (this.client !== socket || value.kind !== 'response' || typeof value.id !== 'string') return;
        const request = this.pending.get(value.id);
        if (request) { clearTimeout(request.timer); this.pending.delete(value.id); value.error ? request.reject(Error(String(value.error).slice(0, 600))) : request.resolve(value.result); }
      }, () => socket.destroy());
      socket.on('data', read); socket.on('error', () => {});
      socket.once('close', () => { clearTimeout(helloTimer); if (this.client === socket) { this.client = null; this.rejectPending('浏览器扩展连接已断开，请打开 Edge 并检查扩展。'); } });
    });
    await new Promise((yes, no) => { this.server.once('error', no); this.server.listen(this.socketPath, yes); });
    if (process.platform !== 'win32') await chmod(this.socketPath, 0o600);
  }
  get connected() { return !!this.client && !this.client.destroyed; }
  request(action, payload) {
    if (!['info', 'bind', 'start', 'status', 'open'].includes(action)) return Promise.reject(Error('不支持此扩展操作。'));
    if (!this.connected) return Promise.reject(Error('请在 Edge 安装并启用 RecDock 扩展，保持浏览器打开，再检查连接。'));
    if (this.pending.size >= 16) return Promise.reject(Error('扩展请求过多，请稍后重试。'));
    const id = randomUUID(), socket = this.client;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('等待扩展回执超时，请核对 ChatGPT 页面；不会自动重复发送。')); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      try { for (const frame of packetFrames(id, action, payload)) socket.write(encodeFrame(frame)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  rejectPending(message) { for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error(message)); } this.pending.clear(); }
  async close() { this.rejectPending('RecDock 已退出，请重开后核对发送状态。'); this.client?.destroy(); await new Promise(resolve => this.server?.close(resolve) || resolve()); await unlink(this.socketPath).catch(() => {}); }
}
module.exports = { NativeBroker };
