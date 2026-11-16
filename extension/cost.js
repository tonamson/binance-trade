// Weighted-average cost in USDT. Pure: no DOM, no chrome.*, no network.
// ponytail: float64 math, fine for display; switch to a decimal lib if cent-exact accounting is ever needed.

export const STABLES = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI']);

const DUST = 1e-12;

/**
 * @param trades  [{ symbol, id, base, quote, qty, quoteQty, commission, commissionAsset, time, isBuyer }]
 * @param priceAt (asset, time) => USDT price of one unit, or null when unknown
 * @returns { [asset]: { asset, qty, cost, avg, realized, oversold, unpriced, history } }
 */
export function computePositions(trades, priceAt) {
  const positions = {};
  const pos = (asset) =>
    (positions[asset] ??= {
      asset, qty: 0, cost: 0, avg: 0, realized: 0, oversold: false, unpriced: false, history: [],
    });

  const record = (p, trade, side, qty, usdt, extra = {}) => {
    p.history.push({
      time: trade.time, symbol: trade.symbol, tradeId: trade.id, side, qty, usdt,
      price: qty > 0 ? usdt / qty : 0,
      qtyAfter: p.qty,
      avgAfter: p.qty > 0 ? p.cost / p.qty : 0,
      fee: side === 'FEE' ? 0 : trade.commission,
      feeAsset: trade.commissionAsset,
      ...extra,
    });
  };

  const acquire = (trade, asset, qty, usdt) => {
    if (STABLES.has(asset)) return;
    const p = pos(asset);
    p.qty += qty;
    p.cost += usdt;
    record(p, trade, 'BUY', qty, usdt);
  };

  const dispose = (trade, asset, qty, usdt, side = 'SELL') => {
    if (STABLES.has(asset)) return;
    const p = pos(asset);
    const before = p.qty;
    const known = Math.min(qty, p.qty);
    if (qty > p.qty * (1 + 1e-9)) p.oversold = true;
    const avg = p.qty > 0 ? p.cost / p.qty : 0;
    // Only the part with a known cost counts toward realized P/L.
    p.realized += usdt * (qty > 0 ? known / qty : 0) - avg * known;
    p.cost -= avg * known;
    p.qty -= known;
    // Relative threshold: float residue scales with the size of the position.
    if (p.qty <= Math.max(DUST, before * 1e-9)) {
      p.qty = 0;
      p.cost = 0;
    }
    record(p, trade, side, qty, usdt);
  };

  const usdtValue = (asset, amount, time) => {
    if (STABLES.has(asset)) return amount;
    const price = priceAt(asset, time);
    return price == null ? null : amount * price;
  };

  const sorted = [...trades].sort((a, b) => a.time - b.time || a.id - b.id);

  for (const tr of sorted) {
    const { base, quote, qty, quoteQty, commission, commissionAsset: feeAsset, time } = tr;

    const quoteUsdt = usdtValue(quote, quoteQty, time);
    if (quoteUsdt == null) {
      const pBase = pos(base);
      const pQuote = pos(quote);
      pBase.unpriced = true;
      pQuote.unpriced = true;
      if (!STABLES.has(base)) {
        record(pBase, tr, tr.isBuyer ? 'BUY' : 'SELL', qty, 0, { unpriced: true });
      }
      if (!STABLES.has(quote)) {
        record(pQuote, tr, tr.isBuyer ? 'SELL' : 'BUY', quoteQty, 0, { unpriced: true });
      }
      continue;
    }

    const feeInBase = feeAsset === base ? commission : 0;
    let feeUsdt = 0;
    if (commission > 0 && feeAsset !== base) {
      const v = usdtValue(feeAsset, commission, time);
      if (v == null) {
        pos(base).unpriced = true;
        pos(feeAsset).unpriced = true;
      } else {
        feeUsdt = v;
      }
    }

    if (tr.isBuyer) {
      acquire(tr, base, qty - feeInBase, quoteUsdt + feeUsdt);
      dispose(tr, quote, quoteQty, quoteUsdt);
    } else {
      dispose(tr, base, qty + feeInBase, quoteUsdt - feeUsdt);
      acquire(tr, quote, quoteQty, quoteUsdt);
    }
    if (feeUsdt > 0) dispose(tr, feeAsset, commission, feeUsdt, 'FEE');
  }

  for (const p of Object.values(positions)) p.avg = p.qty > 0 ? p.cost / p.qty : 0;
  return positions;
}
