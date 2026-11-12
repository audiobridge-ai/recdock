import { initializeLocale, readLocale } from './i18n/index.ts';
import type {} from './desktop/api.ts';
let locale: 'en' | 'zh-CN' = 'en';
try { locale = readLocale(window.localStorage); } catch { /* Storage may be unavailable. */ }
if (window.recdockDesktop) locale = await window.recdockDesktop.getLocale();
initializeLocale(locale);
await import('./main.ts');
