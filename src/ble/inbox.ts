interface Waiter {
  predicate: (b: Uint8Array) => boolean;
  resolve: (b: Uint8Array) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}
export class FrameInbox {
  private maximum: number;
  constructor(maximum = 64) { this.maximum = maximum; }
  private frames: Uint8Array[] = [];
  private waiter?: Waiter;
  private closed?: Error;
  push(frame: Uint8Array) {
    if (this.closed) return;
    if (this.waiter?.predicate(frame)) {
      const w = this.waiter; this.waiter = undefined; w.cleanup(); w.resolve(frame); return;
    }
    this.frames.push(frame.slice());
    // 文件传输不能静默丢帧；由调用方保留连续偏移并在重连后恢复。
    if (this.frames.length > this.maximum) this.close(new Error('设备接收队列已满，请重试传输'));
  }
  next(predicate: (b: Uint8Array) => boolean = () => true, timeout = 10000): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(this.closed);
    if (this.waiter) return Promise.reject(new Error('已有一个接收操作正在等待'));
    const index = this.frames.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = undefined; reject(new Error('设备响应超时')); }, timeout);
      this.waiter = { predicate, resolve, reject, cleanup: () => clearTimeout(timer) };
    });
  }
  clear() { this.frames = []; }
  close(e = new Error('连接已断开')) {
    this.closed = e; this.frames = [];
    const w = this.waiter; this.waiter = undefined;
    if (w) { w.cleanup(); w.reject(e); }
  }
}
