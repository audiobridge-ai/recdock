import { messages, normalizeLocale, translateForLocale } from './messages.ts';
import type { Locale } from './messages.ts';
export { normalizeLocale, translateForLocale };
export type { Locale };
export const LOCALE_KEY = 'recdock.uiLanguage';
export function readLocale(storage?: Pick<Storage, 'getItem'>): Locale {
  try { return normalizeLocale(storage?.getItem(LOCALE_KEY)); } catch { return 'en'; }
}
let locale: Locale = 'en';
try { if (typeof window !== 'undefined') locale = readLocale(window.localStorage); } catch { /* English also works with blocked storage. */ }
export function getLocale() { return locale; }
export function initializeLocale(value: unknown) { locale = normalizeLocale(value); if (typeof document !== 'undefined') document.documentElement.lang = locale; }
/** Translate authored copy only. Arguments are opaque: recording content is never translated. */
export function t(source: string, ...values: unknown[]): string { return translateForLocale(locale, source, ...values); }
/** Translate literal HTML before inserting dynamic values, so user content is never inspected. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  const template = document.createElement('template');
  template.innerHTML = strings.reduce((text, part, index) => text + (index ? `{${index - 1}}` : '') + part, '');
  const visit = (node: Node) => {
    if (node.nodeType === 3 && /[\u3400-\u9fff]/.test(node.textContent || '')) node.textContent = t(node.textContent!);
    if (node.nodeType === 1) for (const attr of Array.from((node as Element).attributes)) if (['title', 'placeholder', 'aria-label', 'alt'].includes(attr.name)) (node as Element).setAttribute(attr.name, t(attr.value));
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  visit(template.content);
  return template.innerHTML.replace(/\{(\d+)\}/g, (token, index) => Number(index) < values.length ? String(values[Number(index)]) : token);
}
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.keys(messages).filter(key => /\{\d+\}/.test(key)).sort((a, b) => b.length - a.length).map(key => {
  const indexes: number[] = [];
  const source = key.split(/(\{\d+\})/).map(part => { const match = /^\{(\d+)\}$/.exec(part); if (!match) return escapeRegex(part); indexes.push(Number(match[1])); return '([\\s\\S]*?)'; }).join('');
  return { key, indexes, regex: new RegExp('^' + source + '$') };
});
/** Only for system-owned messages from the service, worker, or browser extension. */
export function systemMessage(value: string | undefined | null): string {
  if (!value || locale === 'zh-CN') return value || '';
  if (Object.hasOwn(messages, value.trim())) return t(value);
  for (const pattern of patterns) {
    const match = pattern.regex.exec(value.trim()); if (!match) continue;
    const args: string[] = []; pattern.indexes.forEach((index, capture) => { args[index] = match[capture + 1]; });
    return t(pattern.key, ...args);
  }
  return value;
}
export function localizeDocumentMetadata() {
  document.documentElement.lang = locale;
  document.title = t('RecDock 录音工作台');
  const description = document.querySelector('meta[name="description"]');
  description?.setAttribute('content', locale === 'en' ? 'Import audio or connect PLAUD. Save, transcribe, and review recordings locally.' : '导入音频或连接 PLAUD，在本机保存、转写与校对录音。');
}
export function installLanguageSwitch(parent: Element) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button language-switch';
  button.textContent = locale === 'en' ? '中文' : 'English'; button.lang = locale === 'en' ? 'zh-CN' : 'en';
  button.setAttribute('aria-label', locale === 'en' ? 'Switch interface language to Chinese' : '将界面语言切换为英文');
  button.title = locale === 'en' ? 'Interface language: English' : '界面语言：中文';
  button.onclick = async () => {
    const event = new Event('recdock:locale-changing', { cancelable: true });
    if (!window.dispatchEvent(event)) return;
    const next: Locale = locale === 'en' ? 'zh-CN' : 'en'; button.disabled = true;
    try {
      if (window.recdockDesktop) await window.recdockDesktop.setLocale(next);
      try { window.localStorage.setItem(LOCALE_KEY, next); } catch { if (!window.recdockDesktop) throw Error(t('无法保存语言设置，请重试。')); }
      window.dispatchEvent(new Event('recdock:locale-reloading'));
      window.location.reload();
    } catch { button.disabled = false; window.alert(t('无法保存语言设置，请重试。')); }
  };
  parent.prepend(button); return button;
}
