import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const htmlPath = resolve('extension/dashboard.html');
const cssPath = resolve('extension/dashboard.css');

const REQUIRED_DOM_IDS = [
  'screen-setup', 'key-form', 'api-key', 'api-secret', 'toggle-secret', 'key-error', 'key-submit', 'key-cancel',
  'screen-locked', 'locked-retry',
  'screen-main', 'live-status', 'sync-status', 'btn-refresh', 'btn-sync', 'btn-settings',
  'demo-banner', 'key-warning', 'error', 'error-text', 'error-retry', 'progress', 'progress-bar', 'progress-text',
  'kpi-value', 'kpi-value-sub', 'kpi-unrealized', 'kpi-unrealized-pct', 'kpi-cost', 'kpi-cost-sub', 'kpi-realized', 'kpi-net-sub', 'kpi-orders-card', 'kpi-orders', 'kpi-orders-sub',
  'alloc', 'alloc-bar', 'alloc-legend',
  'tab-holdings', 'tab-holdings-count', 'tab-orders', 'tab-orders-count', 'tab-orders-dot',
  'panel-holdings', 'search', 'holdings-filters', 'hide-small', 'row-count', 'holdings', 'holdings-body', 'empty', 'empty-text', 'empty-sync',
  'panel-orders', 'orders-summary-buy', 'orders-summary-sell', 'orders-error', 'orders-error-text', 'orders-retry', 'order-search', 'order-side-filters', 'order-type-filters', 'order-count', 'open-orders', 'open-orders-body', 'orders-empty', 'orders-empty-text',
  'drawer-backdrop', 'drawer', 'drawer-avatar', 'drawer-title', 'drawer-price', 'drawer-change24h', 'drawer-close', 'drawer-avg', 'drawer-now', 'drawer-cost', 'drawer-realized', 'drawer-balance-sub', 'drawer-notes', 'drawer-chart', 'drawer-orders-section', 'drawer-orders-body', 'drawer-history-body',
  'drawer-dca-section', 'dca-target', 'dca-amount', 'dca-summary', 'dca-table', 'dca-body', 'dca-foot',
  'settings', 'key-masked', 'key-change', 'key-remove', 'scan-full', 'extra-form', 'extra-asset', 'extra-error', 'extra-list', 'export-sqlite', 'export-csv', 'wipe', 'confirm', 'confirm-text', 'confirm-ok'
];

const REQUIRED_CHART_SELECTORS = [
  '.chart-out-range',
  '.chart-stage',
  '.chart-tooltip',
  '.tt-head',
  '.tt-row',
  '.tt-sub',
  '.grid',
  '.avg',
  '.avg-area',
  '.now',
  '.order-line',
  '.order-buy',
  '.order-sell',
  '.axis-tag',
  '.now-tag',
  '.crosshair',
  '.buy',
  '.sell',
  'figcaption',
  '.key',
  '.dca-line',
  '.dca-tag',
  '.dca-exit',
  '.dca-exit-tag',
  '.key.dca',
];

test('dashboard.html contains all required DOM IDs for Obsidian Pro Terminal', () => {
  const html = readFileSync(htmlPath, 'utf8');
  const missing = [];
  for (const id of REQUIRED_DOM_IDS) {
    const idPattern = new RegExp(`id=["']${id}["']`);
    if (!idPattern.test(html)) {
      missing.push(id);
    }
  }
  assert.deepEqual(missing, [], `Missing required DOM IDs in dashboard.html: ${missing.join(', ')}`);
});

test('dashboard.html has zero external CDN links, remote fonts, or inline scripts', () => {
  const html = readFileSync(htmlPath, 'utf8');
  assert.doesNotMatch(html, /https?:\/\//i, 'External CDN or remote URLs are forbidden in dashboard.html');
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/i, 'Inline scripts forbidden');
});

test('dashboard.css enforces [hidden] display none !important', () => {
  const css = readFileSync(cssPath, 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/, '[hidden] must be display: none !important');
});

test('dashboard.css contains all required chart selectors matching chart.js', () => {
  const css = readFileSync(cssPath, 'utf8');
  const missing = [];
  for (const sel of REQUIRED_CHART_SELECTORS) {
    if (!css.includes(sel)) {
      missing.push(sel);
    }
  }
  assert.deepEqual(missing, [], `Missing chart selectors in dashboard.css: ${missing.join(', ')}`);
});

test('dashboard.css defines Obsidian Pro Terminal tokens', () => {
  const css = readFileSync(cssPath, 'utf8');
  assert.match(css, /--bg:\s*#090b0f;/);
  assert.match(css, /--surface-1:\s*#0e1218;/);
  assert.match(css, /--accent:\s*#e5a93c;/);
});
