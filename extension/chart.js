// SVG cost-basis & open-order price chart with hover crosshair tooltip.
import { fmtPrice, fmtQty, fmtTime } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SIDE_LABEL = { BUY: 'Mua', SELL: 'Bán', FEE: 'Phí' };

function svgEl(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text != null) el.textContent = text;
  return el;
}

function domEl(tag, cls, children = []) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const c of [children].flat()) if (c != null) el.append(c);
  return el;
}

export function computeChartBounds(fills, history, currentPrice, openOrders = []) {
  const baseValues = [
    ...fills.map((x) => x.price),
    ...history.filter((x) => x.qtyAfter > 0).map((x) => x.avgAfter),
  ];
  if (currentPrice != null) baseValues.push(currentPrice);
  const baseLo = Math.min(...baseValues);
  const baseHi = Math.max(...baseValues);

  const inRangeOrders = [];
  const outOfRangeOrders = [];
  for (const o of openOrders) {
    if (!(o.price > 0)) continue;
    if (o.price >= baseLo * 0.4 && o.price <= baseHi * 2.5) inRangeOrders.push(o);
    else outOfRangeOrders.push(o);
  }

  const allValues = [...baseValues, ...inRangeOrders.map((o) => o.price)];
  let lo = Math.min(...allValues);
  let hi = Math.max(...allValues);
  const padY = (hi - lo || hi || 1) * 0.1;
  lo -= padY;
  hi += padY;
  return { lo, hi, baseLo, baseHi, inRangeOrders, outOfRangeOrders };
}

export function renderPriceChart({ history, currentPrice, openOrders = [] }) {
  const fills = history.filter((x) => x.side !== 'FEE' && x.qty > 0 && !x.unpriced && x.price > 0);
  if (fills.length < 2) return null;

  const W = 740;
  const H = 228;
  const L = 72;
  const R = 74;
  const T = 14;
  const B = 24;

  const times = fills.map((x) => x.time);
  const t0 = Math.min(...times);
  const t1 = Math.max(...times, t0 + 1);
  const { lo, hi, inRangeOrders, outOfRangeOrders } = computeChartBounds(fills, history, currentPrice, openOrders);

  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  const stage = domEl('div', 'chart-stage');
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'Biểu đồ giá các lệnh mua bán so với giá vốn trung bình và lệnh chờ khớp',
  });

  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: 'avg-area-grad', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(
    svgEl('stop', { offset: '0%', 'stop-color': '#e5a93c', 'stop-opacity': '0.18' }),
    svgEl('stop', { offset: '100%', 'stop-color': '#e5a93c', 'stop-opacity': '0' }),
  );
  defs.append(grad);
  svg.append(defs);

  for (const f of [0, 0.5, 1]) {
    const v = lo + (hi - lo) * (0.1 + f * 0.8);
    const py = y(v).toFixed(1);
    svg.append(
      svgEl('line', { class: 'grid', x1: L, x2: W - R, y1: py, y2: py }),
      svgEl('text', { x: L - 8, y: Number(py) + 3, 'text-anchor': 'end' }, fmtPrice(v)),
    );
  }
  svg.append(
    svgEl('text', { x: L, y: H - 6 }, fmtTime(t0).slice(0, 10)),
    svgEl('text', { x: W - R, y: H - 6, 'text-anchor': 'end' }, fmtTime(t1).slice(0, 10)),
  );

  // Average cost step line + translucent area fill
  let d = '';
  let areaD = '';
  let open = false;
  let firstX = null;
  let lastX = null;
  const baselineY = (H - B).toFixed(1);
  for (const p of history) {
    if (p.qtyAfter <= 0) {
      if (open && lastX != null) {
        areaD += `L${lastX},${baselineY}Z`;
      }
      open = false;
      continue;
    }
    const px = x(Math.min(Math.max(p.time, t0), t1)).toFixed(1);
    const py = y(p.avgAfter).toFixed(1);
    if (!open) {
      firstX = px;
      d += `M${px},${py}`;
      areaD += `M${firstX},${baselineY}L${px},${py}`;
      open = true;
    } else {
      d += `H${px}V${py}`;
      areaD += `H${px}V${py}`;
    }
    lastX = px;
  }
  if (open) {
    const endX = (W - R).toFixed(1);
    d += `H${endX}`;
    areaD += `H${endX}L${endX},${baselineY}Z`;
  }
  if (areaD) svg.append(svgEl('path', { class: 'avg-area', d: areaD }));
  if (d) svg.append(svgEl('path', { class: 'avg', d }));

  // Current market price reference line
  if (currentPrice != null) {
    const cy = y(currentPrice).toFixed(1);
    svg.append(
      svgEl('line', { class: 'now', x1: L, x2: W - R, y1: cy, y2: cy }),
      svgEl('text', { class: 'axis-tag now-tag', x: W - R + 6, y: Number(cy) + 3 }, fmtPrice(currentPrice)),
    );
  }

  // Open order limit levels inside chart bounds
  for (const o of inRangeOrders) {
    const oy = y(o.price).toFixed(1);
    const cls = o.side === 'BUY' ? 'order-buy' : 'order-sell';
    svg.append(
      svgEl('line', { class: `order-line ${cls}`, x1: L, x2: W - R, y1: oy, y2: oy }),
      svgEl('text', { class: `axis-tag ${cls}`, x: W - R + 6, y: Number(oy) + 3 }, fmtPrice(o.price)),
    );
  }

  const crosshair = svgEl('line', { class: 'crosshair', x1: 0, x2: 0, y1: T, y2: H - B, visibility: 'hidden' });
  svg.append(crosshair);

  const tooltip = domEl('div', 'chart-tooltip');
  tooltip.hidden = true;

  for (const f of fills) {
    const cx = x(f.time);
    const cy = y(f.price);
    const dot = svgEl('circle', {
      class: f.side === 'BUY' ? 'buy' : 'sell',
      cx: cx.toFixed(1),
      cy: cy.toFixed(1),
      r: 4,
      tabindex: '0',
    });
    const showTip = () => {
      crosshair.setAttribute('x1', cx.toFixed(1));
      crosshair.setAttribute('x2', cx.toFixed(1));
      crosshair.setAttribute('visibility', 'visible');
      const nodes = [
        domEl('div', 'tt-head', `${SIDE_LABEL[f.side] ?? f.side} · ${fmtTime(f.time)}`),
        domEl('div', 'tt-row', `${f.symbol}: ${fmtQty(f.qty)} @ ${fmtPrice(f.price)}`),
      ];
      if (f.qtyAfter > 0) nodes.push(domEl('div', 'tt-sub', `Giá TB sau lệnh: ${fmtPrice(f.avgAfter)}`));
      tooltip.replaceChildren(...nodes);
      tooltip.hidden = false;
      const pctX = (cx / W) * 100;
      const pctY = (cy / H) * 100;
      tooltip.style.left = `${Math.min(Math.max(pctX, 14), 82)}%`;
      tooltip.style.top = `${Math.max(pctY - 8, 6)}%`;
    };
    const hideTip = () => {
      crosshair.setAttribute('visibility', 'hidden');
      tooltip.hidden = true;
    };
    dot.addEventListener('mouseenter', showTip);
    dot.addEventListener('focus', showTip);
    dot.addEventListener('mouseleave', hideTip);
    dot.addEventListener('blur', hideTip);
    svg.append(dot);
  }

  stage.append(svg, tooltip);

  const out = [];
  if (outOfRangeOrders.length > 0) {
    const summary = outOfRangeOrders
      .map((o) => `${SIDE_LABEL[o.side] ?? o.side} @ ${fmtPrice(o.price)}`)
      .join(' · ');
    out.push(domEl('div', 'chart-out-range', `Lệnh chờ ngoài khung giá: ${summary}`));
  }
  out.push(stage);

  const key = (cls, label) => domEl('span', '', [domEl('i', cls ? `key ${cls}` : 'key'), label]);
  out.push(domEl('figcaption', '', [
    key('', 'Giá trung bình'),
    key('buy', 'Mua'),
    key('sell', 'Bán'),
    currentPrice != null ? key('now', `Hiện tại ${fmtPrice(currentPrice)}`) : null,
    inRangeOrders.length > 0 ? key('ord', `${inRangeOrders.length} lệnh chờ`) : null,
  ]));
  return out;
}
