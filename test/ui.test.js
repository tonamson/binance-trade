import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleRows, historyRow } from '../extension/ui.js';

const baseState = {
  query: '',
  hideSmall: true,
  holdingsFilter: 'all',
  sort: { key: 'value', dir: 'desc' },
  ordersSummary: { byAsset: { BTC: [{ orderId: 1 }] } },
  rows: [
    { asset: 'BTC', balance: 0.1, value: 6500, warn: [] },
    { asset: 'ARB', balance: 100, value: 70, warn: ['unknown'] },
    { asset: 'DUST', balance: 0.1, value: 0.5, warn: [] },
    { asset: 'NOPRICE', balance: 10, value: null, warn: ['noprice'] },
  ],
};

test('visibleRows lọc theo holdingsFilter warn và orders', () => {
  assert.deepEqual(visibleRows(baseState).map((r) => r.asset), ['BTC', 'ARB', 'NOPRICE']);
  assert.deepEqual(
    visibleRows({ ...baseState, holdingsFilter: 'warn' }).map((r) => r.asset),
    ['ARB', 'NOPRICE'],
  );
  assert.deepEqual(
    visibleRows({ ...baseState, holdingsFilter: 'orders' }).map((r) => r.asset),
    ['BTC'],
  );
});

test('visibleRows lọc theo query không phân biệt hoa thường và khoảng trắng thừa', () => {
  assert.deepEqual(
    visibleRows({ ...baseState, query: '  ar  ' }).map((r) => r.asset),
    ['ARB'],
  );
});

test('visibleRows xử lý ordersSummary hoặc byAsset khuyết', () => {
  assert.deepEqual(
    visibleRows({ ...baseState, ordersSummary: null, holdingsFilter: 'orders' }).map((r) => r.asset),
    [],
  );
  assert.deepEqual(
    visibleRows({ ...baseState, ordersSummary: {}, holdingsFilter: 'orders' }).map((r) => r.asset),
    [],
  );
});

test('visibleRows giữ lại dust coin khi hideSmall = false', () => {
  assert.deepEqual(
    visibleRows({ ...baseState, hideSmall: false }).map((r) => r.asset),
    ['BTC', 'ARB', 'DUST', 'NOPRICE'],
  );
});

test('visibleRows sort theo key và dir với null xếp cuối cùng', () => {
  const sortedAsc = visibleRows({ ...baseState, sort: { key: 'value', dir: 'asc' } });
  assert.deepEqual(sortedAsc.map((r) => r.asset), ['ARB', 'BTC', 'NOPRICE']);
});

test('historyRow hiển thị lệnh unpriced chuẩn xác', () => {
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: (tag) => ({
      tag,
      setAttribute() {},
      children: [],
      append(...items) { this.children.push(...items); },
    }),
  };
  try {
    const tr = {
      time: 1700000000000,
      symbol: 'ALTXYZ',
      side: 'BUY',
      qty: 10,
      price: 0,
      fee: 0,
      feeAsset: 'XYZ',
      unpriced: true,
    };
    const row = historyRow(tr);
    assert.equal(row.children[3].children[0], '—');
    assert.equal(row.children[6].children[0], '— (chưa có giá)');
  } finally {
    if (prevDoc) globalThis.document = prevDoc;
    else delete globalThis.document;
  }
});
