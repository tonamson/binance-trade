// Incremental sync of Spot trades and the conversion prices the cost engine needs.
// No DOM, no chrome.*: `api` is a binance.js client, `db` is the db.js handle.
import { STABLES } from './cost.js';

const PAGE = 1000;
const MINUTE = 60_000;
const MYTRADES_WEIGHT = 20;
const WEIGHT_PER_MINUTE = 4800; // matches the pause threshold in binance.js

/** Quick scan: pairs whose base/crypto quote coin is held, in open orders, was added by hand, or already has trades. Full: everything. */
export function pickSymbols({ exchangeSymbols, balances = {}, knownSymbols = [], extraAssets = [], openOrderSymbols = [], full }) {
  if (full) return exchangeSymbols;
  const assets = new Set([...Object.keys(balances), ...extraAssets]);
  const known = new Set([...knownSymbols, ...openOrderSymbols]);
  // No status filter on purpose: halted pairs still hold trade history.
  return exchangeSymbols.filter((s) =>
    assets.has(s.base) ||
    (assets.has(s.quote) && !STABLES.has(s.quote)) ||
    known.has(s.symbol)
  );
}

export function estimateMinutes(symbolCount) {
  return Math.ceil((symbolCount * MYTRADES_WEIGHT) / WEIGHT_PER_MINUTE);
}

const toRow = (t, base, quote) => ({
  symbol: t.symbol, id: t.id, order_id: t.orderId, base, quote,
  price: t.price, qty: t.qty, quote_qty: t.quoteQty,
  commission: t.commission, commission_asset: t.commissionAsset,
  time: t.time, is_buyer: t.isBuyer ? 1 : 0, is_maker: t.isMaker ? 1 : 0,
});

/** DB row (numbers as TEXT) -> trade for computePositions. */
export function toTrade(r) {
  return {
    symbol: r.symbol, id: r.id, base: r.base, quote: r.quote,
    price: Number(r.price), qty: Number(r.qty), quoteQty: Number(r.quote_qty),
    commission: Number(r.commission), commissionAsset: r.commission_asset,
    time: r.time, isBuyer: Boolean(r.is_buyer),
  };
}

/** Resumable: the cursor is written after each stored page, so a crash never leaves a gap. */
export async function syncTrades({ api, db, symbols, onProgress, signal, skipSyncedSince = Infinity }) {
  const saved = await db.getCursors();
  const cursors = new Map(saved.map((c) => [c.symbol, c.last_trade_id]));
  // Lets an interrupted full scan pick up where it stopped instead of re-querying every pair.
  const fresh = new Set(saved.filter((c) => c.last_synced_at >= skipSyncedSince).map((c) => c.symbol));
  let newTrades = 0;

  for (let i = 0; i < symbols.length; i++) {
    if (signal?.aborted) break;
    const { symbol, base, quote } = symbols[i];
    let cursor = cursors.get(symbol) ?? null;

    for (; !fresh.has(symbol);) {
      const page = await api.myTrades(symbol, (cursor ?? -1) + 1);
      if (page.length > 0) {
        await db.insertTrades(page.map((t) => toRow(t, base, quote)));
        cursor = page.at(-1).id;
        newTrades += page.length;
      }
      await db.setCursor(symbol, base, quote, cursor);
      if (page.length < PAGE || signal?.aborted) break;
    }
    onProgress?.({ phase: 'trades', done: i + 1, total: symbols.length, symbol, newTrades });
  }
  return newTrades;
}

/** Which 1-minute candles are needed to value non-stablecoin quote legs and third-asset fees in USDT. */
export function neededPrices(trades, exchangeSymbols) {
  const listed = new Set(exchangeSymbols.map((s) => s.symbol));
  const seen = new Set();
  const out = [];

  const need = (asset, time) => {
    if (STABLES.has(asset)) return;
    let symbol = asset + 'USDT';
    let inverse = false;
    if (!listed.has(symbol)) {
      symbol = 'USDT' + asset; // fiat pairs are quoted the other way round
      inverse = true;
      if (!listed.has(symbol)) return; // no route to USDT: cost engine flags the coin as unpriced
    }
    const minute = Math.floor(time / MINUTE) * MINUTE;
    const key = symbol + '@' + minute;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ symbol, minute, inverse });
  };

  for (const t of trades) {
    need(t.quote, t.time);
    if (t.commission > 0 && t.commissionAsset !== t.base) need(t.commissionAsset, t.time);
  }
  return out;
}

export async function syncPrices({ api, db, trades, exchangeSymbols, onProgress, signal }) {
  const have = new Set((await db.getPrices()).map((p) => p.symbol + '@' + p.minute));
  const missing = new Map(); // symbol -> sorted minutes
  for (const n of neededPrices(trades, exchangeSymbols)) {
    if (have.has(n.symbol + '@' + n.minute)) continue;
    if (!missing.has(n.symbol)) missing.set(n.symbol, []);
    missing.get(n.symbol).push(n.minute);
  }

  const total = [...missing.values()].reduce((sum, list) => sum + list.length, 0);
  let done = 0;

  for (const [symbol, minutes] of missing) {
    minutes.sort((a, b) => a - b);
    while (minutes.length > 0) {
      if (signal?.aborted) return;
      const start = minutes[0];
      const closes = new Map((await api.klines(symbol, start, PAGE)).map((k) => [k.minute, k.close]));
      const end = start + PAGE * MINUTE;
      const rows = [];
      while (minutes.length > 0 && minutes[0] < end) {
        const minute = minutes.shift();
        // close: null marks "asked, no candle exists" so it is not re-fetched on every sync.
        rows.push({ symbol, minute, close: closes.get(minute) ?? null });
      }
      await db.putPrices(rows);
      done += rows.length;
      onProgress?.({ phase: 'prices', done, total, symbol, newTrades: 0 });
    }
  }
}

export function makePriceAt(priceRows) {
  const closes = new Map(priceRows.map((p) => [p.symbol + '@' + p.minute, p.close]));
  return (asset, time) => {
    const minute = Math.floor(time / MINUTE) * MINUTE;
    const direct = closes.get(asset + 'USDT@' + minute);
    if (direct != null) return direct;
    const inverse = closes.get('USDT' + asset + '@' + minute);
    return inverse ? 1 / inverse : null;
  };
}
