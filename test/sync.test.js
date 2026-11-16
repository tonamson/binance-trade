import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickSymbols, estimateMinutes, syncTrades, neededPrices, syncPrices, makePriceAt, toTrade,
} from '../extension/sync.js';

const EX = [
  { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT' },
  { symbol: 'BTCFDUSD', base: 'BTC', quote: 'FDUSD' },
  { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT' },
  { symbol: 'ETHBTC', base: 'ETH', quote: 'BTC' },
  { symbol: 'SOLUSDT', base: 'SOL', quote: 'USDT' },
];
const names = (list) => list.map((s) => s.symbol);

const raw = (id, extra = {}) => ({
  symbol: 'BTCUSDT', id, orderId: id + 100, price: '100.5', qty: '2', quoteQty: '201',
  commission: '0.002', commissionAsset: 'BTC', time: 1000 + id, isBuyer: true, isMaker: false, ...extra,
});
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => raw(from + i));

function fakeDb({ cursors = [], prices = [] } = {}) {
  const db = {
    trades: [], cursors: new Map(cursors.map((c) => [c.symbol, c])), prices: [...prices], log: [],
    async getCursors() { return [...db.cursors.values()]; },
    async insertTrades(rows) { db.log.push('insert'); db.trades.push(...rows); },
    async setCursor(symbol, base, quote, lastTradeId) {
      db.log.push('cursor');
      db.cursors.set(symbol, { symbol, base, quote, last_trade_id: lastTradeId });
    },
    async getPrices() { return db.prices; },
    async putPrices(rows) { db.prices.push(...rows); },
  };
  return db;
}
const BTC = [{ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT' }];

test('pickSymbols nhanh', () => {
  const got = pickSymbols({ exchangeSymbols: EX, balances: { BTC: 1 }, knownSymbols: ['SOLUSDT'], extraAssets: ['ETH'], full: false });
  assert.deepEqual(names(got), ['BTCUSDT', 'BTCFDUSD', 'ETHUSDT', 'ETHBTC', 'SOLUSDT']);
});

test('pickSymbols nhanh, không extra', () => {
  const got = pickSymbols({ exchangeSymbols: EX, balances: { BTC: 1 }, knownSymbols: ['SOLUSDT'], extraAssets: [], full: false });
  assert.deepEqual(names(got), ['BTCUSDT', 'BTCFDUSD', 'ETHBTC', 'SOLUSDT']);
});

test('pickSymbols mở rộng: nhận diện quote phi-stable và openOrderSymbols', () => {
  // Chỉ có USDT, có lệnh chờ trên SOLUSDT
  const got1 = pickSymbols({
    exchangeSymbols: EX,
    balances: { USDT: 100 },
    knownSymbols: [],
    extraAssets: [],
    openOrderSymbols: ['SOLUSDT'],
    full: false,
  });
  // USDT là stable nên không match bừa bãi mọi cặp *USDT, chỉ match cặp open orders SOLUSDT
  assert.deepEqual(names(got1), ['SOLUSDT']);

  // Có số dư BTC (phi-stable): match base BTC và quote BTC (ETHBTC)
  const got2 = pickSymbols({
    exchangeSymbols: EX,
    balances: { BTC: 0.5 },
    knownSymbols: [],
    extraAssets: [],
    openOrderSymbols: [],
    full: false,
  });
  assert.deepEqual(names(got2), ['BTCUSDT', 'BTCFDUSD', 'ETHBTC']);
});

test('pickSymbols toàn bộ', () => {
  const got = pickSymbols({ exchangeSymbols: EX, balances: {}, knownSymbols: [], extraAssets: [], full: true });
  assert.equal(got.length, 5);
});

test('estimateMinutes', () => {
  assert.equal(estimateMinutes(3000), 13);
});

test('phân trang', async () => {
  const db = fakeDb();
  const fromIds = [];
  const api = { async myTrades(symbol, fromId) { fromIds.push(fromId); return fromId === 0 ? range(0, 999) : range(1000, 1002); } };
  const progress = [];
  const added = await syncTrades({ api, db, symbols: BTC, onProgress: (p) => progress.push(p) });
  assert.deepEqual(fromIds, [0, 1000]);
  assert.equal(added, 1003);
  assert.equal(db.trades.length, 1003);
  assert.equal(db.cursors.get('BTCUSDT').last_trade_id, 1002);
  assert.deepEqual(db.log, ['insert', 'cursor', 'insert', 'cursor']);
  assert.deepEqual(db.trades[0], {
    symbol: 'BTCUSDT', id: 0, order_id: 100, base: 'BTC', quote: 'USDT', price: '100.5', qty: '2',
    quote_qty: '201', commission: '0.002', commission_asset: 'BTC', time: 1000, is_buyer: 1, is_maker: 0,
  });
  assert.deepEqual(progress.at(-1), { phase: 'trades', done: 1, total: 1, symbol: 'BTCUSDT', newTrades: 1003 });
});

test('chạy tiếp', async () => {
  const db = fakeDb({ cursors: [{ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', last_trade_id: 1002 }] });
  const fromIds = [];
  await syncTrades({ api: { async myTrades(s, fromId) { fromIds.push(fromId); return []; } }, db, symbols: BTC });
  assert.deepEqual(fromIds, [1003]);
  assert.equal(db.cursors.get('BTCUSDT').last_trade_id, 1002);
});

test('symbol chưa có lệnh', async () => {
  const db = fakeDb();
  const fromIds = [];
  const api = { async myTrades(s, fromId) { fromIds.push(fromId); return []; } };
  await syncTrades({ api, db, symbols: BTC });
  assert.equal(db.cursors.get('BTCUSDT').last_trade_id, null);
  await syncTrades({ api, db, symbols: BTC });
  assert.deepEqual(fromIds, [0, 0]);
});

test('dừng giữa chừng', async () => {
  const db = fakeDb();
  const ac = new AbortController();
  let calls = 0;
  const api = { async myTrades() { calls += 1; ac.abort(); return range(0, 999); } };
  await syncTrades({ api, db, symbols: [...BTC, { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT' }], signal: ac.signal });
  assert.equal(calls, 1);
  assert.equal(db.cursors.get('BTCUSDT').last_trade_id, 999);
});

test('lỗi giữa chừng', async () => {
  const db = fakeDb();
  const api = { async myTrades(s, fromId) { if (fromId === 0) return range(0, 999); throw new Error('boom'); } };
  await assert.rejects(syncTrades({ api, db, symbols: BTC }), /boom/);
  assert.equal(db.cursors.get('BTCUSDT').last_trade_id, 999);
  assert.equal(db.trades.length, 1000);
});

const tr = (symbol, base, quote, time, extra = {}) => ({
  symbol, base, quote, time, id: time, qty: 1, quoteQty: 1, commission: 0, commissionAsset: quote, isBuyer: true, ...extra,
});
const PAIRS = [
  { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT' },
  { symbol: 'BNBUSDT', base: 'BNB', quote: 'USDT' },
  { symbol: 'USDTTRY', base: 'USDT', quote: 'TRY' },
];

test('neededPrices', () => {
  const got = neededPrices([
    tr('ALTBTC', 'ALT', 'BTC', 60_500),
    tr('ALTUSDT', 'ALT', 'USDT', 125_000, { commission: 0.01, commissionAsset: 'BNB' }),
    tr('ALTTRY', 'ALT', 'TRY', 185_000),
    tr('ALTUSDT', 'ALT', 'USDT', 300_000, { commission: 0.01, commissionAsset: 'ALT' }),
  ], PAIRS);
  assert.deepEqual(got, [
    { symbol: 'BTCUSDT', minute: 60_000, inverse: false },
    { symbol: 'BNBUSDT', minute: 120_000, inverse: false },
    { symbol: 'USDTTRY', minute: 180_000, inverse: true },
  ]);
});

test('neededPrices không có cặp', () => {
  assert.deepEqual(neededPrices([tr('ALTXYZ', 'ALT', 'XYZ', 60_000)], PAIRS), []);
});

test('syncPrices gộp', async () => {
  const db = fakeDb();
  const calls = [];
  const api = {
    async klines(symbol, startTime, limit) {
      calls.push([symbol, startTime, limit]);
      return Array.from({ length: 20 }, (_, i) => ({ minute: startTime + i * 60_000, close: 100 + i }));
    },
  };
  await syncPrices({ api, db, trades: [tr('ALTBTC', 'ALT', 'BTC', 60_000), tr('ALTBTC', 'ALT', 'BTC', 660_000)], exchangeSymbols: PAIRS });
  assert.deepEqual(calls, [['BTCUSDT', 60_000, 1000]]);
  assert.deepEqual(db.prices, [
    { symbol: 'BTCUSDT', minute: 60_000, close: 100 },
    { symbol: 'BTCUSDT', minute: 660_000, close: 110 },
  ]);
});

test('syncPrices bỏ qua giá đã có', async () => {
  const db = fakeDb({ prices: [{ symbol: 'BTCUSDT', minute: 60_000, close: 100 }] });
  let calls = 0;
  await syncPrices({ api: { async klines() { calls += 1; return []; } }, db, trades: [tr('ALTBTC', 'ALT', 'BTC', 60_000)], exchangeSymbols: PAIRS });
  assert.equal(calls, 0);
});

test('syncPrices thiếu nến', async () => {
  const db = fakeDb();
  let calls = 0;
  const api = { async klines() { calls += 1; return []; } };
  const args = { api, db, trades: [tr('ALTBTC', 'ALT', 'BTC', 60_000)], exchangeSymbols: PAIRS };
  await syncPrices(args);
  assert.deepEqual(db.prices, [{ symbol: 'BTCUSDT', minute: 60_000, close: null }]);
  await syncPrices(args);
  assert.equal(calls, 1);
});

test('makePriceAt', () => {
  const m = 1_700_000_040_000;
  const priceAt = makePriceAt([
    { symbol: 'BTCUSDT', minute: m, close: 60000 },
    { symbol: 'USDTTRY', minute: m, close: 40 },
    { symbol: 'BNBUSDT', minute: m, close: null },
  ]);
  assert.equal(priceAt('BTC', m + 30_000), 60000);
  assert.equal(priceAt('TRY', m), 0.025);
  assert.equal(priceAt('BNB', m), null);
  assert.equal(priceAt('ETH', m), null);
  assert.equal(priceAt('BTC', m + 60_000), null);
});

test('toTrade', () => {
  const row = {
    symbol: 'BTCUSDT', id: 7, order_id: 107, base: 'BTC', quote: 'USDT', price: '100.5', qty: '2',
    quote_qty: '201', commission: '0.002', commission_asset: 'BTC', time: 1007, is_buyer: 1, is_maker: 0,
  };
  assert.deepEqual(toTrade(row), {
    symbol: 'BTCUSDT', id: 7, base: 'BTC', quote: 'USDT', price: 100.5, qty: 2, quoteQty: 201,
    commission: 0.002, commissionAsset: 'BTC', time: 1007, isBuyer: true,
  });
});

test('quét toàn bộ chạy tiếp: bỏ qua symbol vừa quét', async () => {
  const db = fakeDb({ cursors: [{ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', last_trade_id: 5, last_synced_at: 9_000 }] });
  const asked = [];
  const api = { async myTrades(symbol) { asked.push(symbol); return []; } };
  const symbols = [...BTC, { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT' }];
  await syncTrades({ api, db, symbols, skipSyncedSince: 8_000 });
  assert.deepEqual(asked, ['ETHUSDT']);
  await syncTrades({ api, db, symbols, skipSyncedSince: 9_500 });
  assert.deepEqual(asked, ['ETHUSDT', 'BTCUSDT', 'ETHUSDT']);
});
