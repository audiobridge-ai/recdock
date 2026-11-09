import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryOptions } from '../src/ble/discovery.ts';
import { identifyPlaudAdvertisement, decodeAdvertisement } from '../src/protocol/advertisement.ts';
import { concat, unhex, utf8 } from '../src/protocol/bytes.ts';

interface Broadcast { name?: string; company: number; payload: Uint8Array }
// 按 Web Bluetooth 规范独立执行掩码匹配，验证 APK 广播到浏览器过滤条件的转换。
function visible(b: Broadcast, options = discoveryOptions()) {
  if ('acceptAllDevices' in options) return options.acceptAllDevices;
  return options.filters.some(filter => {
    if (filter.namePrefix && !b.name?.startsWith(filter.namePrefix)) return false;
    if (filter.name && b.name !== filter.name) return false;
    if (filter.services?.length) return false; // 夹具不广播任何 GATT 服务。
    return filter.manufacturerData?.every(rule => {
      if (rule.companyIdentifier !== b.company) return false;
      const prefix = rule.dataPrefix as Uint8Array | undefined, mask = rule.mask as Uint8Array | undefined;
      return !prefix || (b.payload.length >= prefix.length && prefix.every((byte, i) =>
        (b.payload[i] & (mask?.[i] ?? 255)) === (byte & (mask?.[i] ?? 255))));
    }) ?? false;
  });
}

const note = unhex('0278030456010000088880012345678900001e000100');

test('已改名、无名称、无广播服务的 Note 仍可按广播标识发现', () => {
  for (const name of ["Renamed recorder", '会议记录仪', undefined]) {
    for (const company of [0x0046, 0x0059]) assert.equal(visible({ name, company, payload: note }), true);
  }
  assert.equal(identifyPlaudAdvertisement(note)?.model, 'Plaud Note');
});

test('同芯片厂商的无关设备以及仅名称叫 PLAUD 的设备不会被当作候选', () => {
  for (const company of [0x0046, 0x0059]) {
    assert.equal(visible({ name: 'PLAUD', company, payload: unhex('020d000456010000081234001234567890001e00') }), false);
    assert.equal(visible({ name: 'PLAUD', company, payload: unhex('010203040506') }), false);
    assert.equal(identifyPlaudAdvertisement(unhex('020d000456010000081234001234567890001e00')), undefined);
  }
});

test('旧广播的紧凑 HEX SN 和字符串 SN 随版本长度解析，改名不影响发现', () => {
  for (const project of ['888', '880', '881', '883', '882', '860']) {
    for (const versionLength of [1, 3, 4, 5]) {
      const version = new Uint8Array(versionLength); version[0] = 0x52; // 不是固定 V。
      for (const serial of [unhex(`${project}0012345678900`), utf8(`${project}0012345678900`)]) {
        const payload = concat(Uint8Array.of(versionLength), version, Uint8Array.of(serial.length), serial, new Uint8Array(8));
        assert.equal(visible({ name: '已改名', company: 0x0059, payload }), true, `${project}/${versionLength}/${serial.length}`);
        assert.equal(identifyPlaudAdvertisement(payload)?.project, Number(project));
      }
    }
  }
});

test('显式产品号仅用于候选过滤，完整识别以真实 SN 为准', () => {
  const wrong = note.slice(); wrong[9] = 0x12;
  assert.equal(visible({ company: 0x0059, payload: wrong }), true);
  assert.equal(identifyPlaudAdvertisement(wrong), undefined);
  assert.equal(decodeAdvertisement(wrong), undefined);
  const mismatched = note.slice(); mismatched[1] = 0x70;
  mismatched.set([9, 0], 15);
  assert.equal(identifyPlaudAdvertisement(mismatched)?.project, 888);
  assert.equal(decodeAdvertisement(mismatched)?.portVersion, 9);
  for (let length = 0; length < 17; length++) assert.equal(identifyPlaudAdvertisement(note.slice(0, length)), undefined);
});

test('实机 Note 广播布局的九字节 SN；长 SN 绑定元数据不能误读为协议版本', () => {
  // 使用实机观测到的布局，序列号和尾部数据替换为虚构值。
  const actualLayout = unhex('027803045608020209888001234567890000140000000000000101');
  assert.equal(visible({ name: "Renamed recorder", company: 0x0059, payload: actualLayout }), true);
  assert.equal(decodeAdvertisement(actualLayout)?.portVersion, 20);
  const serial = utf8('8880012345678900');
  const longSn = concat(unhex('0278030456010000'), Uint8Array.of(serial.length), serial, unhex('0101'));
  assert.equal(identifyPlaudAdvertisement(longSn)?.project, 888);
  assert.equal(decodeAdvertisement(longSn), undefined);
  const legacyNote = concat(unhex('0456010000088880012345678900'), new Uint8Array(8));
  legacyNote.set([9, 0], 15);
  legacyNote.set([30, 0], 18);
  assert.equal(decodeAdvertisement(legacyNote)?.project, 888);
  assert.equal(decodeAdvertisement(legacyNote)?.portVersion, 9, '旧格式必须按头部默认布局读取偏移15');
});

test('未知芯片厂商仅可通过显式诊断模式选择，诊断模式保留必要服务权限', () => {
  const b = { name: "Renamed recorder", company: 0x1234, payload: note };
  assert.equal(visible(b), false);
  assert.equal(visible(b, discoveryOptions(true)), true);
  assert.deepEqual(discoveryOptions(true).optionalServices, discoveryOptions().optionalServices);
});
