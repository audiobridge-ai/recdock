'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const packaged = join(process.resourcesPath || '', 'workspace/src/i18n/en.json');
const messages = require(existsSync(packaged) ? packaged : '../../plaud-web/src/i18n/en.json');
let locale = 'en';
function normalizeLocale(value) { return value === 'zh-CN' ? 'zh-CN' : 'en'; }
function setLocale(value) { locale = normalizeLocale(value); }
function getLocale() { return locale; }
function t(source, ...values) {
  const key = source.trim(), text = locale === 'en' ? messages[key] ?? key : key;
  const translated = source.slice(0, source.length - source.trimStart().length) + text + source.slice(source.trimEnd().length);
  return values.length ? translated.replace(/\{(\d+)\}/g, (token, index) => Number(index) < values.length ? String(values[Number(index)]) : token) : translated;
}
module.exports = { t, setLocale, getLocale, normalizeLocale };
