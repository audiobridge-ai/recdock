import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore DOM fixture only.
import { JSDOM } from 'jsdom';
import { WorkspaceOverlay } from '../src/ui/workspace-overlay.ts';

test('登录与设置共用原生弹层，关闭及 Escape 保留工作台节点与草稿并恢复焦点', () => {
  const dom = new JSDOM('<main><button id="entry">连接设备</button><textarea>未保存草稿</textarea><audio></audio></main><dialog><button data-overlay-close>关闭</button><input></dialog>');
  const previous = ['document', 'HTMLElement'].map(key => [key, Reflect.get(globalThis, key)] as const);
  Reflect.set(globalThis, 'document', dom.window.document); Reflect.set(globalThis, 'HTMLElement', dom.window.HTMLElement);
  try {
    const dialog = dom.window.document.querySelector('dialog')!, editor = dom.window.document.querySelector('textarea')!, entry = dom.window.document.querySelector('button')!;
    // jsdom has no native top layer; emulate only the browser primitives.
    dialog.showModal = () => { dialog.setAttribute('open', ''); dialog.querySelector('button')!.focus(); };
    dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new dom.window.Event('close')); };
    const changes: unknown[] = [], overlay = new WorkspaceOverlay(dialog, () => changes.push(overlay.current));
    entry.focus(); overlay.open('device');
    assert.equal(dialog.open, true); assert.equal(overlay.current, 'device');
    overlay.open('settings'); assert.equal(dialog.dataset.panel, 'settings');
    dialog.querySelector('button')!.click();
    assert.equal(dialog.open, false); assert.equal(overlay.current, null); assert.equal(dom.window.document.activeElement, entry);
    assert.equal(dom.window.document.querySelector('textarea'), editor); assert.equal(editor.value, '未保存草稿');
    assert.equal(dom.window.document.querySelector('main')!.hasAttribute('hidden'), false);
    overlay.open('device');
    const cancel = new dom.window.Event('cancel', { cancelable: true }); dialog.dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true); assert.equal(dialog.open, false);
    assert.deepEqual(changes, ['device', 'settings', null, 'device', null]);
  } finally { dom.window.close(); for (const [key, value] of previous) Reflect.set(globalThis, key, value); }
});
