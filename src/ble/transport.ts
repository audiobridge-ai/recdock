import { decodeAdvertisement, identifyPlaudAdvertisement } from '../protocol/advertisement.ts';
import type { Advertisement, PlaudIdentity } from '../protocol/advertisement.ts';
import { discoveryOptions, KNOWN_MANUFACTURERS } from './discovery.ts';
import { SERVICE, RX, TX, BATTERY_SERVICE } from './uuids.ts';

export { SERVICE, RX, TX, BATTERY_SERVICE } from './uuids.ts';
const BATTERY = '00002a19-0000-1000-8000-00805f9b34fb';

export interface BleLink {
  readonly connected: boolean;
  connect(onFrame: (b: Uint8Array) => void, onLost: () => void, onStage?: (message: string) => void): Promise<void>;
  write(b: Uint8Array): Promise<void>;
  battery(): Promise<number>;
  close(): void;
}
export async function chooseDevice(showAll = false): Promise<BluetoothDevice> {
  if (!navigator.bluetooth || !isSecureContext) throw new Error('请用电脑 Chrome / Edge，通过 localhost 或 HTTPS 打开');
  return navigator.bluetooth.requestDevice(discoveryOptions(showAll));
}
export class BrowserBleLink implements BleLink {
  private static opening = new WeakSet<BluetoothDevice>();
  private device: BluetoothDevice;
  private server?: BluetoothRemoteGATTServer;
  private rx?: BluetoothRemoteGATTCharacteristic;
  private tx?: BluetoothRemoteGATTCharacteristic;
  private listener?: (e: Event) => void;
  private lost?: () => void;
  private closed = false;
  constructor(device: BluetoothDevice) { this.device = device; }
  get connected() { return !this.closed && !!this.server?.connected; }
  private async deadline<T>(operation: Promise<T>, label: string, timeout = 15000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.close(); reject(new Error(`${label}超时，请重试；若浏览器仍在连接，请刷新页面`)); }, timeout);
      })]);
    } finally { clearTimeout(timer); }
  }
  async connect(onFrame: (b: Uint8Array) => void, onLost: () => void, onStage: (message: string) => void = () => {}) {
    this.closed = false; this.lost = onLost;
    this.device.addEventListener('gattserverdisconnected', this.onLost);
    try {
      if (!this.device.gatt) throw new Error('所选设备不提供 GATT');
      if (BrowserBleLink.opening.has(this.device)) throw new Error('上次 GATT 连接操作尚未结束，请稍后重试或刷新页面');
      BrowserBleLink.opening.add(this.device);
      onStage('正在建立 GATT 连接');
      const opening = this.device.gatt.connect();
      // 超时后迟到的连接也需释放，避免后台残留 GATT 连接。
      void opening.then(server => {
        if (this.closed) server.disconnect();
        BrowserBleLink.opening.delete(this.device);
      }, () => { BrowserBleLink.opening.delete(this.device); });
      this.server = await this.deadline(opening, 'GATT 连接', 20000); this.assertOpen();
      onStage('GATT 已建立，正在发现设备控制服务');
      const service = await this.deadline(this.server.getPrimaryService(SERVICE), '发现服务'); this.assertOpen();
      onStage('正在发现设备通知与写入特征');
      // Web Bluetooth 的 GATT 操作按顺序执行。
      this.rx = await this.deadline(service.getCharacteristic(RX), '发现接收特征'); this.assertOpen();
      this.tx = await this.deadline(service.getCharacteristic(TX), '发现发送特征'); this.assertOpen();
      if (!this.rx.properties.notify && !this.rx.properties.indicate) throw new Error('接收特征不支持通知');
      if (!this.tx.properties.write && !this.tx.properties.writeWithoutResponse) throw new Error('发送特征不支持写入');
      this.listener = () => {
        const value = this.rx?.value;
        if (this.connected && value) onFrame(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
      };
      this.rx.addEventListener('characteristicvaluechanged', this.listener);
      onStage('正在订阅设备通知');
      await this.deadline(this.rx.startNotifications(), '订阅通知'); this.assertOpen();
    } catch (e) { this.close(); throw e; }
  }
  private assertOpen() {
    if (this.closed) { this.server?.disconnect(); throw new Error('连接已取消'); }
  }
  private onLost = () => { if (!this.closed) { this.closed = true; this.lost?.(); } };
  async write(b: Uint8Array) {
    if (!this.connected || !this.tx) throw new Error('蓝牙连接已断开');
    const data = new Uint8Array(b);
    if (this.tx.properties.write) await this.deadline(this.tx.writeValueWithResponse(data), '蓝牙写入');
    else await this.deadline(this.tx.writeValueWithoutResponse(data), '蓝牙写入');
  }
  async battery() {
    if (!this.connected || !this.server) throw new Error('蓝牙连接已断开');
    const service = await this.deadline(this.server.getPrimaryService(BATTERY_SERVICE), '读取电量服务');
    const characteristic = await this.deadline(service.getCharacteristic(BATTERY), '读取电量特征');
    const value = await this.deadline(characteristic.readValue(), '读取电量');
    if (!value.byteLength || value.getUint8(0) > 100) throw new Error('标准电量响应无效');
    return value.getUint8(0);
  }
  close() {
    this.closed = true;
    this.device.removeEventListener('gattserverdisconnected', this.onLost);
    if (this.rx && this.listener) this.rx.removeEventListener('characteristicvaluechanged', this.listener);
    this.device.gatt?.disconnect(); this.tx = undefined; this.rx = undefined; this.lost = undefined;
  }
}

export type DetectedAdvertisement = PlaudIdentity & Partial<Pick<Advertisement, 'portVersion' | 'firmware'>>;
export async function observeAdvertisement(device: BluetoothDevice, update: (a: DetectedAdvertisement) => void): Promise<() => void> {
  const d = device as BluetoothDevice & { watchAdvertisements?: (o: { signal: AbortSignal }) => Promise<void> };
  if (!d.watchAdvertisements) throw new Error('当前浏览器未开放广播读取，请手工填写 portVersion 和 SN');
  const abort = new AbortController();
  const listener = (event: Event) => {
    const e = event as Event & { manufacturerData: Map<number, DataView> };
    for (const company of KNOWN_MANUFACTURERS) {
      const v = e.manufacturerData.get(company);
      if (!v) continue;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const identity = identifyPlaudAdvertisement(bytes);
      if (identity) update({ ...identity, ...decodeAdvertisement(bytes) });
    }
  };
  device.addEventListener('advertisementreceived', listener);
  const cleanup = () => { abort.abort(); device.removeEventListener('advertisementreceived', listener); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([d.watchAdvertisements({ signal: abort.signal }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { cleanup(); reject(new Error('启动广播读取超时，请手工填写协议版本和 SN')); }, 10000);
    })]);
  }
  catch (e) { cleanup(); throw e; }
  finally { clearTimeout(timer); }
  return cleanup;
}
