import english from './en.json' with { type: 'json' };
export type Locale = 'en' | 'zh-CN';
export const messages: Record<string, string> = english;
export function normalizeLocale(value: unknown): Locale { return value === 'zh-CN' ? 'zh-CN' : 'en'; }
export function translateForLocale(locale: Locale, source: string, ...values: unknown[]): string {
  const key = source.trim(), translated = locale === 'en' ? messages[key] ?? key : key;
  const text = source.slice(0, source.length - source.trimStart().length) + translated + source.slice(source.trimEnd().length);
  return values.length ? text.replace(/\{(\d+)\}/g, (token, index) => Number(index) < values.length ? String(values[Number(index)]) : token) : text;
}
