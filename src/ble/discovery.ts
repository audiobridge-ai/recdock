import { SERVICE, BATTERY_SERVICE } from './uuids.ts';
import { PLAUD_MODELS } from '../protocol/advertisement.ts';

// APK v4.1.0：产品号见 zt7；广播布局见 ds2。厂商编号不是 PLAUD 专属标识。
export const KNOWN_MANUFACTURERS = [0x0046, 0x0059] as const;
export const PLAUD_PROJECTS = [...PLAUD_MODELS.keys()];

interface PayloadFilter { dataPrefix: Uint8Array<ArrayBuffer>; mask: Uint8Array<ArrayBuffer> }

function legacySerialFilter(versionLength: number, project: number, compact: boolean): PayloadFilter {
  const serialAt = versionLength + 2;
  const prefix = String(project);
  const serial = compact
    ? [parseInt(prefix.slice(0, 2), 16), parseInt(prefix[2], 16) << 4]
    : Array.from(new TextEncoder().encode(prefix));
  const dataPrefix = new Uint8Array(serialAt + serial.length), mask = new Uint8Array(dataPrefix.length);
  dataPrefix[0] = versionLength; mask[0] = 0xff;
  dataPrefix.set(serial, serialAt); mask.fill(0xff, serialAt);
  if (compact) mask[mask.length - 1] = 0xf0;
  return { dataPrefix, mask };
}

export function plaudScanFilters(): BluetoothLEScanFilter[] {
  const payloads: PayloadFilter[] = [];
  for (const project of PLAUD_PROJECTS) {
    // 新布局显式携带 uint16 LE 产品号；不依赖广播名称或服务列表。
    payloads.push({ dataPrefix: Uint8Array.of(2, project & 255, project >>> 8), mask: Uint8Array.of(255, 255, 255) });
    // 旧布局从 SN 前三位识别型号。版本字段为类型字符加最多四字节固件号。
    // 首字节 2 已被新布局占用；紧凑 HEX SN 与字符串 SN 分别匹配。
    for (const versionLength of [1, 3, 4, 5]) {
      payloads.push(legacySerialFilter(versionLength, project, true), legacySerialFilter(versionLength, project, false));
    }
  }
  return KNOWN_MANUFACTURERS.flatMap(companyIdentifier => payloads.map(payload => ({
    manufacturerData: [{ companyIdentifier, ...payload }],
  })));
}

export function discoveryOptions(showAll = false): RequestDeviceOptions {
  return {
    ...(showAll ? { acceptAllDevices: true } : { filters: plaudScanFilters() }),
    optionalServices: [SERVICE, BATTERY_SERVICE],
    optionalManufacturerData: [...KNOWN_MANUFACTURERS],
  };
}
