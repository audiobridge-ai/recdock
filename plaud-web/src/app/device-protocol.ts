import { CloudApiError } from '../auth/cloud.ts';
import { observeAdvertisement } from '../ble/transport.ts';
import type { DetectedAdvertisement } from '../ble/transport.ts';
export interface ProtocolDetection { serialNumber: string; portVersion: number; firmware?: string }
interface Options {
  device: BluetoothDevice;
  serialNumber: string;
  signal: AbortSignal;
  local: (serialNumber: string, signal: AbortSignal) => Promise<ProtocolDetection>;
  stage: (message: string) => void;
  observe?: typeof observeAdvertisement;
  browserTimeout?: number;
}
const cancelled = () => new CloudApiError('OPERATION_CANCELLED', 409, '设备识别已取消。');
const validPort = (port: unknown): port is number => Number.isInteger(port) && Number(port) >= 1 && Number(port) <= 65535;
function validate(result: ProtocolDetection, serialNumber: string) {
  if (result.serialNumber !== serialNumber) throw new CloudApiError('DEVICE_MISMATCH', 409, '所选蓝牙设备与账号设备不一致，请重新选择同一台设备。');
  if (!validPort(result.portVersion)) throw new CloudApiError('DEVICE_IDENTIFICATION_FAILED', 409, '未能识别设备，请唤醒设备并靠近电脑后重试。');
  return result;
}
/** Browser advertisements when available; macOS bridge otherwise. Never guesses from the model. */
export async function detectDeviceProtocol(options: Options): Promise<ProtocolDetection> {
  const { device, serialNumber, signal } = options;
  if (signal.aborted) throw cancelled();
  if (options.observe || typeof (device as BluetoothDevice & { watchAdvertisements?: unknown }).watchAdvertisements === 'function') {
    options.stage('正在识别设备…');
    try {
      const result = await new Promise<ProtocolDetection>((resolve, reject) => {
        let done = false, cleanup: (() => void) | undefined;
        const finish = (error?: unknown, value?: ProtocolDetection) => {
          if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); cleanup?.();
          error ? reject(error) : resolve(value!);
        };
        const abort = () => finish(cancelled());
        const timer = setTimeout(() => finish(new CloudApiError('ADVERTISEMENT_TIMEOUT')), options.browserTimeout ?? 2500);
        signal.addEventListener('abort', abort, { once: true });
        const received = (value: DetectedAdvertisement) => {
          if (value.serialNumber !== serialNumber) { finish(new CloudApiError('DEVICE_MISMATCH', 409, '所选蓝牙设备与账号设备不一致，请重新选择同一台设备。')); return; }
          if (validPort(value.portVersion)) finish(undefined, { serialNumber, portVersion: value.portVersion, firmware: value.firmware });
        };
        void (options.observe ?? observeAdvertisement)(device, received).then(stop => { if (done) stop(); else cleanup = stop; }, error => finish(error));
        if (signal.aborted) abort();
      });
      if (signal.aborted) throw cancelled();
      return validate(result, serialNumber);
    } catch (error) {
      if (signal.aborted) throw cancelled();
      if (error instanceof CloudApiError && error.code === 'DEVICE_MISMATCH') throw error;
    }
  }
  if (signal.aborted) throw cancelled();
  options.stage('正在自动识别设备；首次使用请允许系统蓝牙权限…');
  const result = await options.local(serialNumber, signal);
  if (signal.aborted) throw cancelled();
  return validate(result, serialNumber);
}
