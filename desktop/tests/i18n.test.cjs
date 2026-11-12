'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { t, getLocale, setLocale, normalizeLocale } = require('../src/i18n.cjs');
test('native menus default to English and use explicit Chinese without touching interpolation data', () => {
  assert.equal(getLocale(), 'en'); assert.equal(normalizeLocale('zh'), 'en');
  assert.equal(t('退出 RecDock'), 'Quit RecDock');
  assert.equal(t('是否允许与 {0} 配对？', '设置 {1}'), 'Allow pairing with 设置 {1}?');
  setLocale('zh-CN'); assert.equal(t('退出 RecDock'), '退出 RecDock');
  setLocale('en');
});
