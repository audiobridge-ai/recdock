'use strict';
const { constants } = require('node:fs');
const { lstat, open, rename, unlink } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');

class ModelToken {
  constructor(file, storage) { this.file = file; this.storage = storage; }
  async saved() {
    try { const info = await lstat(this.file); return info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 65536; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async read() {
    if (!await this.saved()) return '';
    let handle;
    try {
      handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const encrypted = await handle.readFile();
      if (!this.storage.isEncryptionAvailable()) throw Error('STORAGE_UNAVAILABLE');
      return this.storage.decryptString(encrypted);
    } catch {
      throw Error('无法读取已保存的模型下载令牌。可以重新保存授权；已有模型仍可离线使用。');
    } finally { await handle?.close(); }
  }
  async save(value) {
    if (typeof value !== 'string' || !/^hf_[A-Za-z0-9]{10,200}$/.test(value.trim())) throw Error('请输入有效的 Hugging Face 访问令牌。');
    if (!this.storage.isEncryptionAvailable()) throw Error('系统安全存储暂不可用，请稍后重试。');
    let encrypted;
    try { encrypted = this.storage.encryptString(value.trim()); }
    catch { throw Error('未能加密保存下载授权。已有模型仍可离线使用。'); }
    const temporary = this.file + '.' + randomBytes(8).toString('hex') + '.tmp';
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(encrypted); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, this.file);
    } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
    return { saved: true };
  }
  async remove() { await unlink(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; }); return { removed: true }; }
}
module.exports = { ModelToken };
