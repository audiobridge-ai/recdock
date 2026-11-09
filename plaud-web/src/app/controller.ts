import { authenticate } from '../auth/handshake.ts';
import { tokenSource, validateCredentials } from '../auth/credentials.ts';
import type { Credentials } from '../auth/credentials.ts';
import { ReplayError } from '../auth/session.ts';
import type { Codec } from '../auth/session.ts';
import type { BleLink } from '../ble/transport.ts';
import { FrameInbox } from '../ble/inbox.ts';
import { command, feCommand, request } from '../protocol/bytes.ts';
import { decodeBattery, decodeHandshake, decodeState, decodeStorage } from '../protocol/status.ts';
import type { Battery, DeviceState, Storage } from '../protocol/status.ts';
import { applyRecordingEvent, decodeRecordingEvent, recordingFromState } from '../protocol/recording.ts';
import type { RecordingStatus } from '../protocol/recording.ts';
import { decodeFileStop, stopRecordingSyncRequest } from '../protocol/files.ts';
import type { RecordingFile } from '../protocol/files.ts';
import { recoverRecording } from '../audio/recovery.ts';
import type { PlayableRecording } from '../audio/ogg.ts';
import { FileStopError, receiveRecording, receiveRecordingList, TransferCancelled } from './file-transfer.ts';
import type { FileIO, TransferBuffer } from './file-transfer.ts';

export interface Result<T> { data?: T; updated?: number; error?: string; loading?: boolean }
export interface Snapshot {
  phase: 'idle' | 'credentials' | 'connecting' | 'gatt' | 'authenticating' | 'ready' | 'error';
  busy: boolean; stage: string; error?: string;
  state: Result<DeviceState>; battery: Result<Battery>; storage: Result<Storage>;
  recording: RecordingStatus;
  files: Result<RecordingFile[]>;
  transfer: { phase: 'idle' | 'downloading' | 'cancelling' | 'complete' | 'cancelled' | 'paused' | 'error'; sessionId?: number; received: number; total: number; error?: string; notice?: string; filename?: string };
}
interface ControllerOptions { monitorInterval?: number; fileTimeout?: number; stopTimeout?: number }
type Pending = { cmd: number; resolve: (p: Uint8Array) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
export class PlaudController {
  snapshot: Snapshot = { phase: 'idle', busy: false, stage: '选择设备后即可连接', state: {}, battery: {}, storage: {}, recording: { mode: 'unknown' }, files: {}, transfer: { phase: 'idle', received: 0, total: 0 } };
  private link?: BleLink; private codec?: Codec; private inbox = new FrameInbox();
  private pending?: Pending; private epoch = 0; private activeOperation = false;
  private timedOut = new Set<number>();
  private port = 0; private timeout: number;
  private update: () => void; private log: (s: string) => void;
  private options: ControllerOptions;
  private serialNumber = ''; private identity = '';
  private audioMetadata: { channels?: number; isOggAudio?: boolean } = {};
  private audioPrivateKey = '';
  private audioPrivateKeyHistory: string[] = [];
  private writeTail: Promise<void> = Promise.resolve();
  private monitor?: ReturnType<typeof setInterval>; private filesDirty = false;
  private lastListRequestId = 0; private closedSessions = new Set<number>();
  private fileInbox?: FrameInbox; private fileTask?: 'list' | 'download';
  private fileStreamActive = false; private stoppingFile = false;
  private fileCancelled = false; private pauseForRecording = false;
  private checkpoint?: TransferBuffer & { identity: string };
  constructor(update: () => void, log: (s: string) => void, timeout = 7000, options: ControllerOptions = {}) { this.update = update; this.log = log; this.timeout = timeout; this.options = options; }
  get connected() { return !!this.link?.connected; }
  private stage(message: string) { this.snapshot.stage = message; this.log(message); this.update(); }
  private check(epoch: number) { if (epoch !== this.epoch || !this.connected) throw new Error('连接已取消'); }
  private reset() {
    if (this.checkpoint && !this.checkpoint.identity) this.checkpoint = undefined;
    clearInterval(this.monitor); this.monitor = undefined; this.filesDirty = false;
    this.fileCancelled = true; this.fileInbox?.close(new TransferCancelled()); this.fileInbox = undefined; this.fileTask = undefined;
    this.fileStreamActive = false; this.stoppingFile = false;
    this.writeTail = Promise.resolve(); this.audioMetadata = {}; this.audioPrivateKey = ''; this.audioPrivateKeyHistory = []; this.closedSessions.clear();
    this.epoch++; this.inbox.close(); this.inbox = new FrameInbox(); this.codec?.dispose(); this.codec = undefined; this.timedOut.clear();
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('蓝牙连接已断开')); this.pending = undefined; }
    this.link?.close(); this.link = undefined;
    this.snapshot.state = {}; this.snapshot.battery = {}; this.snapshot.storage = {};
    this.snapshot.recording = { mode: 'unknown' }; this.snapshot.files = {};
    this.snapshot.transfer = this.checkpoint?.received ? { phase: 'paused', sessionId: this.checkpoint.file.sessionId, received: this.checkpoint.received, total: this.checkpoint.file.size, notice: '连接已断开，重连同一设备并刷新目录后可继续下载' } : { phase: 'idle', received: 0, total: 0 };
  }
  disconnect(forgetDownloads = false) {
    if (forgetDownloads) this.checkpoint = undefined;
    this.reset(); this.snapshot.phase = 'idle'; this.snapshot.error = undefined;
    this.stage(this.activeOperation ? '正在结束当前操作…' : '已断开连接，设备状态已清空');
  }
  private lost = () => {
    const previous = this.snapshot.stage;
    const message = this.snapshot.phase === 'authenticating' ? `设备在认证阶段断开（${previous}），请核对账号与认证材料后重连` : '设备连接已断开，请重新连接';
    this.reset(); this.snapshot.phase = 'error'; this.snapshot.error = message; this.stage(message);
  };
  private onFrame(epoch: number, p: Uint8Array) {
    if (epoch !== this.epoch) return;
    if (!this.codec) {
      // 只记录协议编号、长度与分片元数据，不输出签名、SN、密文或密钥。
      const fe = feCommand(p);
      if (fe !== undefined && [0xfe10, 0xfe11, 0xfe12, 0xfe20, 0xfe30, 0xfe31, 0xfe34].includes(fe)) {
        const fragment = fe === 0xfe12 && p.length >= 4 ? ` · 分片 ${p[3] + 1}/${p[2]}` : '';
        this.log(`收到认证通知 · ${fe.toString(16).toUpperCase()} · ${p.length} 字节${fragment}`);
      } else this.log(`收到认证通知 · ${p.length} 字节`);
      this.inbox.push(p); return;
    }
    let decoded: Uint8Array;
    try { decoded = this.codec.decode(p); }
    catch (e) { if (!(e instanceof ReplayError)) this.log('收到无法校验的设备数据，已忽略'); return; }
    const cmd = command(decoded);
    if (cmd === 3) {
      try { this.acceptState(decoded); } catch { this.log('忽略格式无效的状态推送'); }
    } else if (cmd !== undefined && [19, 20, 21, 22, 23].includes(cmd)) {
      try {
        const { event, ack } = decodeRecordingEvent(decoded, this.serialNumber);
        if (ack) void this.send(ack, epoch).catch(() => {
          if (epoch !== this.epoch) return;
          if (!this.connected) this.lost(); else this.log('录音事件确认未能写入，请检查连接');
        });
        if (event) {
          if (event.kind === 'start' && event.sessionId) this.closedSessions.delete(event.sessionId);
          if (event.kind === 'stop') {
            const session = event.sessionId || this.snapshot.recording.sessionId;
            if (session) { this.closedSessions.add(session); if (this.closedSessions.size > 32) this.closedSessions.delete(this.closedSessions.values().next().value!); }
          }
          if (event.kind !== 'duration' || !this.closedSessions.has(event.sessionId)) {
            const before = this.snapshot.recording;
            this.snapshot.recording = applyRecordingEvent(before, event, Date.now());
            if (event.kind === 'new-file' || event.kind === 'stop') this.filesDirty = true;
            this.recordingChanged(before);
          }
        }
      } catch { this.log('忽略格式无效的录音事件'); }
    }
    if (this.fileInbox && (decoded[0] === 2 || (cmd !== undefined && [26, 28, 29, 30].includes(cmd)))) {
      this.fileInbox.push(decoded); return;
    }
    if (cmd === 1) {
      try { if (decodeHandshake(decoded).status !== 0) { this.lost(); return; } }
      catch { this.log('忽略长度无效的认证确认'); }
    }
    if (this.pending && this.pending.cmd === cmd) {
      const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer); pending.resolve(decoded);
    }
    // 录音事件与状态推送独立处理，普通查询仍只匹配当前等待的命令。
  }
  private acceptState(packet: Uint8Array) {
    const data = decodeState(packet), before = this.snapshot.recording;
    this.snapshot.state = { data, updated: Date.now() };
    if (data.stateCode === 4099 && data.sessionId) this.closedSessions.delete(data.sessionId);
    this.snapshot.recording = recordingFromState(data, before, Date.now());
    this.recordingChanged(before);
  }
  private recordingChanged(before: RecordingStatus) {
    const mode = this.snapshot.recording.mode;
    if (mode === 'recording' || mode === 'paused') {
      if (this.fileTask) {
        this.pauseForRecording = true; this.fileCancelled = true;
        if (!this.stoppingFile) this.fileInbox?.close(new TransferCancelled());
      }
    } else if (before.mode === 'recording' || before.mode === 'paused') this.filesDirty = true;
    this.update();
  }
  private async send(packet: Uint8Array, epoch: number, guard?: () => void) {
    const task = this.writeTail.then(async () => {
      this.check(epoch); guard?.();
      const link = this.link!, codec = this.codec!;
      await link.write(codec.encode(packet)); this.check(epoch);
    });
    this.writeTail = task.catch(() => {}); return task;
  }
  private async operation(fn: () => Promise<void>) {
    if (this.activeOperation) return;
    this.activeOperation = true; this.snapshot.busy = true; this.snapshot.error = undefined; this.update();
    try { await fn(); }
    catch (e) {
      if (this.snapshot.phase === 'idle' && !this.connected) { this.stage('已断开连接，当前操作已取消'); return; }
      if (this.snapshot.phase === 'error' && !this.connected && this.snapshot.error) return;
      const message = e instanceof Error ? e.message : '操作失败';
      this.reset(); this.snapshot.phase = 'error'; this.snapshot.error = message; this.stage(message);
    } finally { this.activeOperation = false; this.snapshot.busy = false; this.update(); }
  }
  async connect(link: BleLink, c: Credentials) {
    if (this.activeOperation) return;
    // App 在 CCC 成功后立即认证，不能连上硬件后再等待用户填材料。
    try { validateCredentials(c); }
    catch (e) {
      const message = (e as Error).message;
      if (!this.connected) this.snapshot.phase = 'credentials';
      this.snapshot.error = message; this.stage(`连接前检查未通过：${message}`); return;
    }
    await this.operation(async () => {
      this.reset(); this.link = link; const epoch = this.epoch;
      this.serialNumber = c.serialNumber;
      this.audioPrivateKey = c.rsa.privateKeyPem;
      this.audioPrivateKeyHistory = [...(c.rsa.privateKeyHistory ?? [])];
      this.identity = c.serialNumber ? JSON.stringify([c.serialNumber, tokenSource(c)]) : '';
      if (this.checkpoint && this.checkpoint.identity !== this.identity) {
        this.checkpoint = undefined; this.snapshot.transfer = { phase: 'idle', received: 0, total: 0 };
      }
      this.snapshot.phase = 'connecting'; this.stage('正在连接 GATT 并订阅设备通知');
      await link.connect(p => this.onFrame(epoch, p), this.lost, message => {
        if (epoch !== this.epoch) throw new Error('连接已取消');
        this.stage(message);
      }); this.check(epoch);
      this.snapshot.phase = 'gatt'; this.stage('GATT 已连接，等待设备认证');
      await this.authenticateOnce(c, epoch);
    });
  }
  async authorize(c: Credentials) {
    // 缺少输入属于可修正的表单问题，保留 GATT 连接。
    validateCredentials(c);
    await this.operation(async () => {
      if (!this.connected || this.codec) throw new Error('请先连接设备，或断开后重新认证');
      await this.authenticateOnce(c, this.epoch);
    });
  }
  private async authenticateOnce(c: Credentials, epoch: number) {
    this.snapshot.phase = 'authenticating'; this.port = c.portVersion!;
    const codec = await authenticate({
      send: async b => { this.check(epoch); await this.link!.write(b); this.check(epoch); },
      receive: (p, t) => this.inbox.next(p, t),
      stage: s => { this.check(epoch); this.stage(s); },
      handshake: details => {
        this.audioMetadata = { channels: details.audioChannels, isOggAudio: details.isOggAudio };
        this.log(`设备音频格式 · 声道 ${details.audioChannels ?? '未提供'} · Ogg ${details.isOggAudio === undefined ? '未提供' : details.isOggAudio ? '是' : '否'}`);
      },
    }, c);
    if (epoch !== this.epoch || !this.connected) { codec.dispose(); throw new Error('连接已取消'); }
    this.codec = codec; this.inbox.clear();
    this.stage('正在读取实际设备状态以确认认证结果');
    this.acceptState(await this.query(3, epoch)); this.check(epoch);
    this.snapshot.phase = 'ready'; this.stage('认证已验证，正在读取电量和存储');
    await this.readRemaining(epoch);
    this.filesDirty = true; this.startMonitor();
  }
  private async query(cmd: number, epoch: number, quiet = false): Promise<Uint8Array> {
    this.check(epoch);
    if (this.timedOut.has(cmd)) throw new Error(`命令 ${cmd} 上次响应超时，请重连后再读取此项`);
    if (this.pending) throw new Error('另一个设备查询尚未完成');
    const response = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.timer === timer) { this.pending = undefined; this.timedOut.add(cmd); }
        reject(new Error(`命令 ${cmd} 响应超时`));
      }, this.timeout);
      this.pending = { cmd, resolve, reject, timer };
    });
    // 写入与响应可同时完成；预先挂载 rejection handler 防止断开时出现未处理拒绝。
    void response.catch(() => {});
    try {
      if (!quiet) this.log(`发送状态查询 · 命令 ${cmd}`);
      await this.send(request(cmd), epoch); this.check(epoch);
      return await response;
    } catch (e) {
      const pending = this.pending as Pending | undefined;
      if (pending?.cmd === cmd) { clearTimeout(pending.timer); pending.reject(e as Error); this.pending = undefined; }
      throw e;
    }
  }
  private async readRemaining(epoch: number) {
    this.snapshot.battery = { loading: true }; this.update();
    try {
      const data: Battery = this.port < 5 ? { level: await this.link!.battery() } : decodeBattery(await this.query(9, epoch));
      this.check(epoch); this.snapshot.battery = { data, updated: Date.now() };
    } catch (e) { this.check(epoch); this.snapshot.battery = { error: (e as Error).message }; }
    this.snapshot.storage = { loading: true }; this.update();
    try {
      const data = decodeStorage(await this.query(6, epoch)); this.check(epoch);
      this.snapshot.storage = { data, updated: Date.now() };
    } catch (e) { this.check(epoch); this.snapshot.storage = { error: (e as Error).message }; }
    this.stage('读取完成，可手动刷新');
  }
  async refresh() {
    if (this.snapshot.phase !== 'ready') return;
    await this.operation(async () => {
      const epoch = this.epoch; this.snapshot.state = { loading: true }; this.stage('正在刷新设备状态');
      // 首个状态命令超时后保守断开，避免无请求序号的旧响应污染下一轮查询。
      this.acceptState(await this.query(3, epoch)); this.check(epoch); await this.readRemaining(epoch);
    });
  }
  private startMonitor() {
    clearInterval(this.monitor);
    const interval = this.options.monitorInterval ?? 5000;
    if (interval <= 0) return;
    this.monitor = setInterval(() => {
      if (this.activeOperation || this.snapshot.phase !== 'ready' || (typeof document !== 'undefined' && document.hidden)) return;
      if (this.filesDirty && this.snapshot.recording.mode !== 'recording' && this.snapshot.recording.mode !== 'paused') { void this.listFiles(); return; }
      void this.operation(async () => { const epoch = this.epoch; this.acceptState(await this.query(3, epoch, true)); this.check(epoch); });
    }, interval);
    (this.monitor as unknown as { unref?: () => void }).unref?.();
  }
  private async requireIdle(epoch: number) {
    this.acceptState(await this.query(3, epoch, true)); this.check(epoch);
    const mode = this.snapshot.recording.mode;
    if (mode === 'recording' || mode === 'paused') throw new Error('设备正在录音或暂停中，录音结束后再读取目录和下载');
    if (mode !== 'idle') throw new Error('设备当前状态尚不适合文件传输，请刷新状态后重试');
  }
  private fileIO(epoch: number): FileIO {
    return {
      send: p => this.send(p, epoch, () => {
        if (this.fileCancelled || this.snapshot.recording.mode === 'recording' || this.snapshot.recording.mode === 'paused') throw new TransferCancelled();
        if (command(p) === 28) this.fileStreamActive = true;
      }),
      receive: (p, t) => this.fileInbox!.next(p, t),
      stop: () => this.stopFileTransfer(epoch),
      cancelled: () => this.fileCancelled || epoch !== this.epoch || !this.connected,
      progress: (received, notice) => {
        this.check(epoch); this.snapshot.transfer.received = received;
        if (notice) this.snapshot.transfer.notice = notice;
        const now = Date.now();
        if (received === this.snapshot.transfer.total || now - this.lastProgressUpdate >= 100 || notice) { this.lastProgressUpdate = now; this.update(); }
      },
    };
  }
  private lastProgressUpdate = 0;
  private async stopFileTransfer(epoch: number) {
    this.check(epoch);
    if (!this.fileStreamActive) return;
    this.stoppingFile = true;
    this.fileInbox?.close(new TransferCancelled()); this.fileInbox = new FrameInbox(2048);
    try {
      await this.send(stopRecordingSyncRequest(), epoch);
      decodeFileStop(await this.fileInbox.next(p => command(p) === 30, this.options.stopTimeout ?? 5000));
      this.check(epoch); this.fileInbox.clear(); this.fileStreamActive = false;
    } catch {
      throw new FileStopError('设备未确认停止传输，已断开连接；重连后可继续下载');
    } finally { if (epoch === this.epoch) this.stoppingFile = false; }
  }
  async listFiles(): Promise<void> {
    if (this.activeOperation || this.snapshot.phase !== 'ready') return;
    await this.operation(async () => {
      const epoch = this.epoch; this.filesDirty = false;
      this.snapshot.files = { ...this.snapshot.files, loading: true, error: undefined }; this.update();
      try {
        await this.requireIdle(epoch);
        this.fileCancelled = false; this.pauseForRecording = false; this.fileTask = 'list'; this.fileInbox = new FrameInbox(2048);
        this.lastListRequestId = Math.max(Math.floor(Date.now() / 1000), this.lastListRequestId + 1);
        const data = await receiveRecordingList(this.fileIO(epoch), this.lastListRequestId, this.port, this.options.fileTimeout ?? 10000);
        this.check(epoch); if (this.fileCancelled) throw new TransferCancelled();
        this.snapshot.files = { data, updated: Date.now() };
        this.log(`录音目录读取完成 · ${data.length} 个文件`);
        if (this.checkpoint && !data.some(f => f.sessionId === this.checkpoint!.file.sessionId && f.size === this.checkpoint!.file.size)) {
          this.checkpoint = undefined; this.snapshot.transfer = { phase: 'idle', received: 0, total: 0 };
        }
      } catch (e) {
        if (epoch !== this.epoch) return;
        if (!this.connected) { this.lost(); return; }
        if (this.timedOut.has(3)) throw e;
        const error = this.pauseForRecording ? '录音已开始，目录读取已暂缓' : e instanceof Error ? e.message : '录音目录读取失败';
        this.snapshot.files = { ...this.snapshot.files, loading: false, error }; this.log(error);
      } finally {
        if (epoch === this.epoch) { this.fileInbox?.close(); this.fileInbox = undefined; this.fileTask = undefined; }
      }
    });
  }
  cancelDownload(): void {
    if (this.fileTask !== 'download' || this.fileCancelled) return;
    this.fileCancelled = true; this.snapshot.transfer.phase = 'cancelling';
    if (!this.stoppingFile) this.fileInbox?.close(new TransferCancelled());
    this.update();
  }
  async download(sessionId: number): Promise<(PlayableRecording & { originalData: Uint8Array }) | undefined> {
    if (this.activeOperation || this.snapshot.phase !== 'ready') return;
    let output: (PlayableRecording & { originalData: Uint8Array }) | undefined;
    await this.operation(async () => {
      const epoch = this.epoch;
      let started = false;
      let requestedSize = 0;
      try {
        const file = this.snapshot.files.data?.find(f => f.sessionId === sessionId);
        if (!file) throw new Error('请先刷新录音目录，再选择要下载的文件');
        requestedSize = file.size;
        if (!file.size) throw new Error('此录音文件为空，请稍后刷新目录');
        if (file.size > 256 * 1024 * 1024) throw new Error('当前浏览器单文件下载上限为256 MiB');
        await this.requireIdle(epoch);
        if (!this.identity || !this.checkpoint || this.checkpoint.identity !== this.identity || this.checkpoint.file.sessionId !== file.sessionId || this.checkpoint.file.size !== file.size) {
          this.checkpoint = { identity: this.identity, file, data: new Uint8Array(file.size), received: 0 };
        }
        const buffer = this.checkpoint;
        this.fileCancelled = false; this.pauseForRecording = false; this.fileTask = 'download'; this.fileInbox = new FrameInbox(2048); started = true;
        this.snapshot.transfer = { phase: 'downloading', sessionId, received: buffer.received, total: file.size };
        this.stage(buffer.received ? '正在继续接收录音文件' : '正在通过蓝牙接收录音文件');
        const bytes = await receiveRecording(this.fileIO(epoch), buffer, this.port, this.options.fileTimeout ?? 12000);
        this.check(epoch); this.fileStreamActive = false;
        if (this.fileCancelled) throw new TransferCancelled();
        const candidate = await recoverRecording(bytes, { ...this.audioMetadata, sessionId, privateKeyPem: this.audioPrivateKey, privateKeyHistory: this.audioPrivateKeyHistory });
        if (epoch !== this.epoch || !this.connected || this.fileCancelled) {
          if (candidate.data !== bytes) candidate.data.fill(0);
          throw new TransferCancelled();
        }
        output = { ...candidate, originalData: bytes };
        this.snapshot.transfer = { phase: 'complete', sessionId, received: file.size, total: file.size, filename: output.filename, notice: output.notice };
        this.checkpoint = undefined; this.stage('录音文件已完整接收并通过长度检查');
      } catch (e) {
        if (epoch !== this.epoch) return;
        if (!this.connected) { this.lost(); return; }
        if (this.timedOut.has(3)) throw e;
        const cancelled = e instanceof TransferCancelled || this.fileCancelled;
        const error = e instanceof Error ? e.message : '文件下载失败';
        let stopFailed = e instanceof FileStopError;
        if (started && !stopFailed && this.connected) {
          try { await this.stopFileTransfer(epoch); } catch { stopFailed = true; }
        }
        if (epoch !== this.epoch) return;
        const buffer = this.checkpoint?.file.sessionId === sessionId ? this.checkpoint : undefined;
        const received = buffer?.received ?? 0, total = buffer?.file.size ?? requestedSize;
        const notice = this.pauseForRecording ? '设备开始录音，下载已暂停；录音结束后可继续' : cancelled ? '下载已取消，已接收的部分保留在本页内存' : undefined;
        if (stopFailed) this.reset();
        this.snapshot.transfer = { phase: stopFailed || this.pauseForRecording ? 'paused' : cancelled ? 'cancelled' : 'error', sessionId, received, total,
          error: cancelled && !stopFailed ? undefined : stopFailed ? '设备未确认停止传输，已断开连接；重连后可继续' : error, notice };
        if (stopFailed) { this.snapshot.phase = 'error'; this.snapshot.error = this.snapshot.transfer.error; }
        this.log(stopFailed ? '下载已暂停，停止确认未收到，连接已释放' : cancelled ? '录音下载已停止' : `录音下载未完成：${error}`);
      } finally {
        if (epoch === this.epoch) { this.fileInbox?.close(); this.fileInbox = undefined; this.fileTask = undefined; }
      }
    });
    return output;
  }
}
