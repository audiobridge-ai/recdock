'use strict';
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');

class Runtime extends EventEmitter {
  constructor({ resources, support, models, token, workspace, publicRoot }) {
    super(); Object.assign(this, { resources, support, models, token }); this.workspace = workspace || join(resources, 'workspace'); this.publicRoot = publicRoot || join(resources, 'public'); this.task = null; this.taskState = { running: false }; this.child = null;
  }
  environment() {
    const r = this.resources, s = this.support;
    return { PATH: join(r, 'runtime/bin') + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: require('node:os').homedir(), LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
      PYTHONPATH: join(this.workspace, 'worker'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
      HF_HOME: join(s, 'huggingface'), HF_HUB_DISABLE_XET: '1', HF_HUB_DOWNLOAD_TIMEOUT: '60', HF_HUB_ETAG_TIMEOUT: '30',
      XDG_CACHE_HOME: join(s, 'cache'), MPLCONFIGDIR: join(s, 'matplotlib'), RECDOCK_LIBRARY_DIR: join(s, 'library'), RECDOCK_VAULT_FILE: join(s, 'vault/accounts.json'),
      RECDOCK_AUDIO_PYTHON: join(r, 'runtime/python/bin/python3.11'), RECDOCK_AUDIO_MODELS: this.models,
      RECDOCK_FFMPEG: join(r, 'runtime/bin/ffmpeg'), RECDOCK_FFPROBE: join(r, 'runtime/bin/ffprobe'),
      RECDOCK_BROADCAST_HELPER: join(r, 'native/BroadcastScanner.app/Contents/MacOS/BroadcastScanner'), RECDOCK_FILELOCK_HELPER: join(r, 'native/FileLock') };
  }
  async start() {
    if (this.child) throw Error('SERVICE_ALREADY_RUNNING');
    const child = spawn(join(this.resources, 'runtime/node'), [join(__dirname, 'service.cjs')], { cwd: this.workspace, env: { ...this.environment(), RECDOCK_WORKSPACE: this.workspace, RECDOCK_PUBLIC_ROOT: this.publicRoot, RECDOCK_DESKTOP_TOKEN: this.token }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    return new Promise((yes, no) => {
      let buffered = '', ready = false, failureCode = '', stderr = '';
      const timer = setTimeout(() => { void this.stop(); no(Error('SERVICE_START_TIMEOUT')); }, 30000);
      const fail = () => { clearTimeout(timer); if (!ready) { const error = Error('SERVICE_START_FAILED'); error.code = failureCode || 'START_FAILED'; no(error); } };
      child.once('error', error => { failureCode = error.code || 'SPAWN_FAILED'; fail(); });
      child.stderr.on('data', data => {
        if (stderr.length < 65536) stderr += data.toString();
        for (const line of stderr.split('\n')) { try { const row = JSON.parse(line); if (row.event === 'failed' && /^[A-Z0-9_]{1,80}$/.test(row.code)) failureCode = row.code; } catch {} }
      });
      child.stdout.on('data', data => {
        buffered += data.toString(); if (buffered.length > 65536) { fail(); void this.stop(); return; }
        const lines = buffered.split('\n'); buffered = lines.pop();
        for (const line of lines) { try { const value = JSON.parse(line); if (value.event === 'ready' && Number.isInteger(value.port) && !ready) { ready = true; clearTimeout(timer); this.port = value.port; yes(value.port); } } catch {} }
      });
      child.once('exit', (code, signal) => { if (!failureCode) failureCode = signal || (code === 0 ? 'EARLY_EXIT' : 'EXIT_' + code); this.child = null; fail(); if (ready && !this.stopping) this.emit('service-exited'); });
    });
  }
  async stop() {
    const child = this.child; if (!child) return; this.stopping = true;
    await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 15000); child.once('exit', () => { clearTimeout(timer); this.stopping = false; resolve(); }); child.kill('SIGTERM'); });
  }
  prepare({ verify = false, probe = false, token = '' } = {}) {
    if (this.task) throw Error('已有模型或环境检查任务正在运行。');
    const args = ['-m', 'recdock_audio.desktop', '-m', probe ? 'recdock_audio.preflight' : 'recdock_audio.models', ...(probe ? ['environment', '--workspace', this.workspace, '--accelerators'] : ['--root', this.models, ...(verify ? ['--verify'] : [])])];
    const child = spawn(join(this.resources, 'runtime/python/bin/python3.11'), args, { cwd: this.workspace, env: { ...this.environment(), ...(token ? { HF_TOKEN: token } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.task = child; this.taskState = { running: true, kind: probe ? 'probe' : verify ? 'verify' : 'download', message: probe ? '正在检查处理环境…' : verify ? '正在完整校验模型…' : '正在准备模型…' };
    const decoder = new StringDecoder('utf8'); let output = '', pending = '', finished = false;
    child.stdout.on('data', bytes => {
      const text = decoder.write(bytes); if (output.length < 2 * 1024 * 1024) output += text; pending += text;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) { try { const row = JSON.parse(line); if (row.phase && row.model) { const names = { asr: '转写模型', aligner: '时间对齐模型', diarizer: '说话人模型' }; const phases = { checking: '检查中', downloading: '下载中', verifying: '校验中', retrying: '重试中', ready: '已就绪', failed: '未完成' }; this.taskState.message = `${names[row.model] || '模型'} · ${phases[row.phase] || '处理中'}`; this.taskState.model = row.model; this.taskState.phase = row.phase; this.emit('setup', this.taskState); } } catch {} }
    });
    child.stderr.on('data', () => {});
    const finish = code => {
      if (finished) return; finished = true;
      this.task = null;
      let report; if (probe && code === 0) { try { report = JSON.parse(output); } catch {} }
      const blockers = probe && report ? report.blockers || [] : [];
      const ok = code === 0 && (!probe || !!report) && blockers.length === 0;
      this.taskState = { ...this.taskState, running: false, ok, message: ok ? (probe ? '环境检查完成，处理工具与加速环境可用。' : '模型准备与校验完成。') : blockers.length ? '环境仍有问题：' + blockers.join('、') : code === 130 || this.taskState.cancelled ? '已取消；已下载部分保留，下次可继续。' : '未完成。请检查网络、模型许可和磁盘空间后重试。', ...(report ? { report } : {}) };
      this.emit('setup', this.taskState);
    };
    child.once('error', () => finish(-1)); child.once('exit', code => finish(code));
    this.emit('setup', this.taskState); return this.taskState;
  }
  async cancelSetup() {
    const child = this.task; if (!child) return;
    this.taskState.cancelled = true;
    await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 8000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
  }
}
module.exports = { Runtime };
