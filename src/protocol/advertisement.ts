import { hex, text, view } from './bytes.ts';
export interface Advertisement { serialNumber: string; portVersion: number; project: number; firmware: string }
export const PLAUD_MODELS: ReadonlyMap<number, string> = new Map([
  [888, 'Plaud Note'], [880, 'Plaud NotePin'], [881, 'Plaud Note Pro'],
  [883, 'Plaud Note Pro'], [882, 'Plaud NotePin S'], [860, 'Plaud One'],
]);
export interface PlaudIdentity { serialNumber: string; project: number; model: string }
// Web Bluetooth manufacturerData 已去除两字节 company identifier。
function header(b: Uint8Array) {
  try {
    if (b.length < 6) return;
    let layoutProject = 0, versionLength = b[0], start = 1;
    if (versionLength === 2) { layoutProject = view(b).getUint16(1, true); versionLength = b[3]; start = 4; }
    if (versionLength < 1 || versionLength > 5 || start + versionLength >= b.length) return;
    let firmwareNumber = 0;
    for (let i = 1; i < versionLength; i++) firmwareNumber += b[start + i] * 2 ** (8 * (i - 1));
    const snLengthAt = start + versionLength, snLength = b[snLengthAt], snAt = snLengthAt + 1;
    if (!snLength || snAt + snLength > b.length) return;
    const compact = snLength < 10;
    const serialNumber = compact ? hex(b.slice(snAt, snAt + snLength)).toUpperCase() : text(b.slice(snAt, snAt + snLength)).replace(/\0/g, '');
    // App zt7.a.c 按实际 SN 前三位识别，不把名称或芯片厂商号当作产品身份。
    const project = Number(serialNumber.slice(0, 3));
    return { serialNumber, project, layoutProject, compact, firmware: `${String.fromCharCode(b[start])}${firmwareNumber}` };
  } catch { return; }
}

export function identifyPlaudAdvertisement(b: Uint8Array): PlaudIdentity | undefined {
  const h = header(b), model = h && PLAUD_MODELS.get(h.project);
  if (!h || !model) return;
  return { serialNumber: h.serialNumber, project: h.project, model };
}

export function decodeAdvertisement(b: Uint8Array): Advertisement | undefined {
  try {
    const h = header(b);
    if (!h || !PLAUD_MODELS.has(h.project)) return;
    const { serialNumber, project, layoutProject, firmware, compact } = h;
    // 已知型号的长字符串 SN 分支此处跟随绑定元数据，不含可直接读取的协议版本。
    if (!compact) return;
    // 860 的耳机/盒扩展广播暂不猜测；其 port 可手工输入。
    if (project === 860) return;
    // ds2 先按头部项目号选择布局，再用 SN 确认型号；两个项目号不能混用。
    const portAt = [888, 881, 883].includes(layoutProject) ? 18 : 15;
    if (portAt + 2 > b.length) return;
    const portVersion = view(b).getUint16(portAt, true);
    if (!portVersion) return;
    return { serialNumber, portVersion, project, firmware };
  } catch { return; }
}
