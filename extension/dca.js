// DCA ladder planner: how buying more at lower prices moves average cost and break-even. Pure: no DOM, no network.

export const DCA_STEPS = [0, 5, 10, 15, 20, 30]; // % below the current price
export const TRADE_FEE = 0.001; // Binance Spot standard taker/maker fee

/**
 * Each row assumes every row above it has already filled (a ladder bought on the way down).
 * @param qty        coin held with a known cost
 * @param cost       USDT cost of that coin
 * @param price      current USDT price
 * @param amount     USDT to spend at each suggested step
 * @param targetPct  profit wanted on total cost after selling (0 = break even)
 * @param buyOrders  [{ price, amount }] open USDT-quoted BUY orders, merged into the ladder with their own amounts
 * @param fee        fraction charged on every buy and the final sell
 */
export function planDca({
  qty, cost, price, amount, targetPct = 0, steps = DCA_STEPS, buyOrders = [], fee = TRADE_FEE,
}) {
  if (!(qty > 0) || !(cost > 0) || !(price > 0)) return null;

  const exit = (avg) => {
    const breakEven = avg / (1 - fee);
    return { breakEven, target: breakEven * (1 + targetPct / 100) };
  };
  const rise = (target, from) => (target / from - 1) * 100;

  const baseAvg = cost / qty;
  const baseExit = exit(baseAvg);
  const base = { avg: baseAvg, ...baseExit, risePct: rise(baseExit.target, price) };

  const levels = [
    ...steps.map((pct) => ({ price: price * (1 - pct / 100), amount, source: 'step' })),
    ...buyOrders.filter((o) => o.price > 0 && o.amount > 0).map((o) => ({ ...o, source: 'order' })),
  ].sort((a, b) => b.price - a.price);

  let totalQty = qty;
  let totalCost = cost;
  const rows = levels.map((lv) => {
    const boughtQty = (lv.amount / lv.price) * (1 - fee);
    totalQty += boughtQty;
    totalCost += lv.amount;
    const avg = totalCost / totalQty;
    const { breakEven, target } = exit(avg);
    return {
      price: lv.price,
      dropPct: (1 - lv.price / price) * 100,
      amount: lv.amount,
      source: lv.source,
      boughtQty, totalQty, totalCost, avg, breakEven, target,
      risePct: rise(target, lv.price),
    };
  });

  return { base, rows };
}

/** About a quarter of the current cost per step, rounded to 2 significant digits, never below 10 USDT. */
export function defaultDcaAmount(cost) {
  const raw = cost * 0.25;
  if (!(raw > 10)) return 10;
  const unit = 10 ** (Math.floor(Math.log10(raw)) - 1);
  return Math.round(raw / unit) * unit;
}
