import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePositions } from '../extension/cost.js';

let seq = 0;
const t = (symbol, base, quote, isBuyer, qty, quoteQty, extra = {}) => {
  seq += 1;
  return {
    symbol, base, quote, isBuyer, qty, quoteQty,
    commission: 0, commissionAsset: quote, id: seq, time: seq * 1000, ...extra,
  };
};
const buy = (base, qty, usdt, extra) => t(base + 'USDT', base, 'USDT', true, qty, usdt, extra);
const sell = (base, qty, usdt, extra) => t(base + 'USDT', base, 'USDT', false, qty, usdt, extra);
const none = () => null;
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
const check = (p, want) => {
  for (const [k, v] of Object.entries(want)) {
    if (typeof v === 'number') near(p[k], v);
    else assert.equal(p[k], v, k);
  }
};

test('mua hai lần', () => {
  const { BTC } = computePositions([buy('BTC', 1, 100), buy('BTC', 1, 200)], none);
  check(BTC, { qty: 2, cost: 300, avg: 150, realized: 0 });
});

test('bán một phần', () => {
  const { BTC } = computePositions([buy('BTC', 1, 100), buy('BTC', 1, 200), sell('BTC', 1, 250)], none);
  check(BTC, { qty: 1, cost: 150, avg: 150, realized: 100 });
});

test('bán hết rồi mua lại', () => {
  const { BTC } = computePositions([buy('BTC', 1, 100), sell('BTC', 1, 130), buy('BTC', 2, 100)], none);
  check(BTC, { qty: 2, avg: 50, realized: 30 });
});

test('phí bằng base', () => {
  const { ALT } = computePositions([buy('ALT', 10, 100, { commission: 0.01, commissionAsset: 'ALT' })], none);
  check(ALT, { qty: 9.99, cost: 100 });
});

test('phí bằng quote stable khi bán', () => {
  const { ALT } = computePositions(
    [buy('ALT', 10, 100), sell('ALT', 5, 100, { commission: 0.1, commissionAsset: 'USDT' })], none);
  check(ALT, { qty: 5, cost: 50, realized: 49.9 });
});

test('phí bằng BNB', () => {
  const { ALT, BNB } = computePositions(
    [buy('BNB', 1, 300), buy('ALT', 100, 100, { commission: 0.001, commissionAsset: 'BNB' })],
    (asset) => (asset === 'BNB' ? 400 : null));
  check(ALT, { cost: 100.4 });
  check(BNB, { qty: 0.999, cost: 299.7, realized: 0.1 });
  assert.equal(BNB.history.at(-1).side, 'FEE');
});

test('quote là BTC', () => {
  const { ALT, BTC } = computePositions(
    [buy('BTC', 1, 50000), t('ALTBTC', 'ALT', 'BTC', true, 1000, 0.1)],
    (asset) => (asset === 'BTC' ? 60000 : null));
  check(ALT, { cost: 6000, avg: 6 });
  check(BTC, { qty: 0.9, cost: 45000, realized: 1000 });
});

test('bán vượt', () => {
  const { ALT } = computePositions([buy('ALT', 2, 20), sell('ALT', 5, 100)], none);
  check(ALT, { qty: 0, cost: 0, realized: 20, oversold: true });
});

test('bán khi chưa có gì', () => {
  const { ALT } = computePositions([sell('ALT', 5, 100)], none);
  check(ALT, { qty: 0, realized: 0, oversold: true });
});

test('không quy đổi được', () => {
  const { ALT, XYZ } = computePositions([t('ALTXYZ', 'ALT', 'XYZ', true, 10, 5)], none);
  check(ALT, { qty: 0, unpriced: true });
  assert.equal(XYZ.unpriced, true);
  assert.equal(ALT.history.length, 1);
  assert.equal(ALT.history[0].unpriced, true);
  assert.equal(ALT.history[0].symbol, 'ALTXYZ');
});

test('bụi số thực', () => {
  const { ALT } = computePositions(
    [buy('ALT', 0.1, 1), buy('ALT', 0.1, 1), buy('ALT', 0.1, 1), sell('ALT', 0.3, 6)], none);
  assert.equal(ALT.qty, 0);
  assert.equal(ALT.cost, 0);
  assert.equal(ALT.oversold, false);
});

test('cùng mili-giây', () => {
  const b = buy('ALT', 1, 10, { id: 1, time: 5000 });
  const s = sell('ALT', 1, 15, { id: 2, time: 5000 });
  const { ALT } = computePositions([s, b], none);
  check(ALT, { qty: 0, realized: 5, oversold: false });
});

test('cặp stable/stable', () => {
  assert.deepEqual(computePositions([buy('USDC', 100, 100)], none), {});
});

test('lịch sử', () => {
  const { BTC } = computePositions([buy('BTC', 1, 100), buy('BTC', 1, 200)], none);
  assert.equal(BTC.history.length, 2);
  check(BTC.history[1], { side: 'BUY', price: 200, qtyAfter: 2, avgAfter: 150 });
});

test('bụi số thực ở số lượng lớn', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let run = 0; run < 300; run++) {
    const trades = [];
    let held = 0;
    for (let i = 0; i < 5; i++) {
      const qty = Number((1e5 + rnd() * 1e7).toFixed(2));
      const fee = Number((qty * 0.001).toFixed(8));
      held += qty - fee;
      trades.push(buy('ALT', qty, qty * 0.37, { commission: fee, commissionAsset: 'ALT' }));
    }
    trades.push(sell('ALT', Number(held.toFixed(8)), held * 0.5));
    const { ALT } = computePositions(trades, none);
    assert.equal(ALT.qty, 0, `run ${run}: left ${ALT.qty}`);
    assert.equal(ALT.avg, 0);
  }
});
