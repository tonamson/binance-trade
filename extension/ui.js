// DOM rendering only. State and behaviour live in dashboard.js.
import { fmtUsd, fmtSignedUsd, fmtPrice, fmtQty, fmtPct, fmtTime, fmtClock } from './format.js';
import { renderPriceChart } from './chart.js';
import { sortNullLast } from './orders.js';

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [children].flat()) if (c != null) el.append(c);
  return el;
}

const tone = (n) => (n == null || Math.abs(n) < 0.005 ? '' : n > 0 ? 'up' : 'down');
const dash = () => h('span', { class: 'zero' }, '—');

const BADGES = {
  unknown: (r) => `${fmtQty(r.unknownQty)} chưa rõ vốn`,
  oversold: () => 'Thiếu lịch sử mua',
  unpriced: () => 'Không quy đổi được',
  noprice: () => 'Thiếu giá USDT',
};
const EXPLAIN = {
  unknown: (r) => `${fmtQty(r.unknownQty)} ${r.asset} trong ví không có lệnh mua Spot tương ứng (nạp từ ngoài, Convert, Earn, P2P…). Giá trung bình chỉ tính trên phần mua qua Spot.`,
  oversold: () => 'Lịch sử có lệnh bán nhiều hơn số đã mua qua Spot. Một phần coin đến từ nguồn khác, nên lãi/lỗ đã chốt chỉ tính trên phần có giá mua.',
  unpriced: () => 'Có lệnh dùng cặp không quy đổi được sang USDT. Các lệnh đó bị bỏ khỏi giá vốn.',
  noprice: (r) => `Binance không có cặp ${r.asset}USDT nên không tính được giá trị hiện tại.`,
};
const SIDE = { BUY: 'Mua', SELL: 'Bán', FEE: 'Phí' };

export function visibleRows(state) {
  const q = state.query.trim().toUpperCase();
  const byAsset = state.ordersSummary?.byAsset ?? {};
  return state.rows
    .filter((r) => !q || r.asset.includes(q))
    .filter((r) => !state.hideSmall || (r.value ?? (r.balance > 0 ? Infinity : 0)) >= 1)
    .filter((r) => {
      if (state.holdingsFilter === 'warn') return r.warn.length > 0;
      if (state.holdingsFilter === 'orders') return (byAsset[r.asset]?.length ?? 0) > 0;
      return true;
    })
    .sort((a, b) => sortNullLast(a, b, state.sort.key, state.sort.dir));
}

const PALETTE = ['#e5a93c', '#38bdf8', '#16c784', '#a78bfa', '#fb923c', '#2dd4bf', '#f472b6'];
const OTHER = '#526075';

function allocate(rows) {
  const total = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  for (const r of rows) r.alloc = total > 0 && r.value > 0 ? (r.value / total) * 100 : null;
  const ranked = rows.filter((r) => r.alloc != null).sort((a, b) => b.alloc - a.alloc);
  const colors = new Map(ranked.slice(0, PALETTE.length).map((r, i) => [r.asset, PALETTE[i]]));
  return { ranked, colors };
}

function renderAlloc({ ranked, colors }) {
  $('alloc').hidden = ranked.length === 0;
  const top = ranked.filter((r) => colors.has(r.asset));
  const rest = ranked.filter((r) => !colors.has(r.asset)).reduce((sum, r) => sum + r.alloc, 0);
  const parts = top.map((r) => ({ name: r.asset, pct: r.alloc, color: colors.get(r.asset), clickable: true }));
  if (rest > 0) parts.push({ name: 'Khác', pct: rest, color: OTHER, clickable: false });
  $('alloc-bar').replaceChildren(...parts.map((p) =>
    h('i', { style: `width:${p.pct}%;background:${p.color}`, title: `${p.name} ${p.pct.toFixed(1)}%` })));
  $('alloc-legend').replaceChildren(...parts.map((p) => h('li', {}, [
    p.clickable
      ? h('button', { type: 'button', 'data-drawer-asset': p.name }, [
          h('span', { class: 'dot', style: `background:${p.color}` }), h('b', {}, p.name), `${p.pct.toFixed(1)}%`,
        ])
      : h('span', { class: 'legend-static' }, [
          h('span', { class: 'dot', style: `background:${p.color}` }), h('b', {}, p.name), `${p.pct.toFixed(1)}%`,
        ]),
  ])));
}

const movedOut = (r) => r.balance > 0 && r.movedOutQty * (r.price ?? 1) >= 1;
const lastPrice = new Map();
let historyKey = '';
let chartKey = '';

function avatarStyle(color) {
  return `background:${color}22;border-color:${color}55;color:${color}`;
}

function pct24h(price, open) {
  if (price == null || open == null || open <= 0) return null;
  return ((price - open) / open) * 100;
}

function holdingRow(r, state, colors) {
  const prev = lastPrice.get(r.asset);
  const tick = prev == null || r.price == null || prev === r.price ? '' : r.price > prev ? 'tick-up' : 'tick-down';
  const color = colors.get(r.asset) ?? OTHER;
  const locked = state.balancesDetail?.locked?.[r.asset] ?? 0;
  const orderCount = state.ordersSummary?.byAsset?.[r.asset]?.length ?? 0;
  const chg = pct24h(r.price, state.open24h?.[r.asset + 'USDT']);

  const coin = h('div', { class: 'coin' }, [
    h('span', { class: 'avatar', style: avatarStyle(color) }, r.asset.slice(0, 3)),
    h('div', { class: 'coin-meta' }, [
      h('b', {}, r.asset),
      orderCount > 0 ? h('span', { class: 'tag ord' }, `${orderCount} lệnh chờ`) : null,
      ...r.warn.map((w) => h('span', { class: 'tag', title: EXPLAIN[w](r) }, BADGES[w](r))),
      movedOut(r)
        ? h('span', { class: 'tag plain', title: 'Đã rút hoặc chuyển sang Earn/Funding. Giá trung bình không đổi.' }, `chuyển ra ${fmtQty(r.movedOutQty)}`)
        : null,
    ]),
  ]);
  const hasPnl = r.unrealized != null && r.knownQty > 0;
  const held = r.balance > 0;

  return h('tr', { tabindex: '0', 'data-asset': r.asset, 'aria-label': `Xem chi tiết ${r.asset}` }, [
    h('td', { class: 'left' }, coin),
    h('td', { class: held ? '' : 'zero' }, [
      h('div', { class: 'cell-stack' }, [
        h('span', {}, fmtQty(r.balance)),
        locked > 0 ? h('span', { class: 'cell-sub lock' }, `Khóa: ${fmtQty(locked)}`) : null,
      ]),
    ]),
    h('td', {}, [
      h('div', { class: 'cell-stack' }, [
        h('div', { class: 'price-line' }, [
          h('span', { class: 'muted' }, r.avg == null ? '—' : fmtPrice(r.avg)),
          h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
          h('span', { class: 'now ' + tick }, r.price == null ? '—' : fmtPrice(r.price)),
        ]),
        chg != null ? h('span', { class: 'chg-badge ' + tone(chg) }, `24h ${fmtPct(chg)}`) : null,
      ]),
    ]),
    h('td', {}, held && r.value != null ? h('div', { class: 'cell-stack' }, [
      h('span', {}, fmtUsd(r.value)),
      r.alloc != null ? h('span', { class: 'cell-sub' }, `${r.alloc.toFixed(1)}%`) : null,
    ]) : dash()),
    h('td', { class: tone(r.unrealized) }, hasPnl ? fmtSignedUsd(r.unrealized) : dash()),
    h('td', {}, hasPnl ? h('span', { class: 'pill ' + tone(r.unrealized) }, fmtPct(r.unrealizedPct)) : dash()),
  ]);
}

function orderRow(o) {
  const statusLabel = o.status === 'PARTIALLY_FILLED' ? 'Khớp một phần' : 'Chờ khớp';
  return h('tr', { tabindex: '0', 'data-order-asset': o.base, 'aria-label': `Xem coin ${o.base}` }, [
    h('td', { class: 'left' }, fmtTime(o.time)),
    h('td', { class: 'left' }, [
      h('div', { class: 'cell-stack left' }, [
        h('span', {}, `${o.base}/${o.quote || '—'}`),
        h('div', { class: 'coin-meta' }, [
          h('span', { class: 'tag plain' }, o.type),
          o.isOco ? h('span', { class: 'tag oco' }, 'OCO') : null,
        ]),
      ]),
    ]),
    h('td', { class: 'left' }, h('span', { class: `side-badge ${o.side}` }, o.side === 'BUY' ? 'MUA' : 'BÁN')),
    h('td', {}, h('div', { class: 'cell-stack' }, [
      h('span', {}, o.price > 0 ? fmtPrice(o.price) : 'MARKET'),
      o.stopPrice != null ? h('span', { class: 'cell-sub' }, `Kích hoạt: ${fmtPrice(o.stopPrice)}`) : null,
    ])),
    h('td', {}, h('div', { class: 'cell-stack' }, [
      h('span', { class: o.distancePct == null ? 'zero' : tone(o.distancePct) }, o.distancePct == null ? '—' : fmtPct(o.distancePct)),
      o.marketPrice != null ? h('span', { class: 'cell-sub' }, `TT: ${fmtPrice(o.marketPrice)}`) : null,
    ])),
    h('td', {}, h('div', { class: 'cell-stack' }, [
      h('span', {}, `${fmtQty(o.executedQty)} / ${fmtQty(o.origQty)}`),
      h('div', { class: 'fill-track', title: `${o.fillPct.toFixed(1)}%` }, h('span', { class: 'fill-bar', style: `width:${o.fillPct}%` })),
    ])),
    h('td', {}, o.remainingValueUsdt != null ? `${fmtUsd(o.remainingValueUsdt)} USDT` : dash()),
    h('td', { class: 'left' }, h('span', { class: o.status === 'PARTIALLY_FILLED' ? 'status-tag partial' : 'status-tag' }, statusLabel)),
  ]);
}

function setStat(id, text, n, base = 'kpi-val num') {
  const el = $(id);
  el.textContent = text;
  el.className = base + (n == null ? '' : ' ' + tone(n));
}

export function historyRow(x) {
  return h('tr', {}, [
    h('td', { class: 'left' }, fmtTime(x.time)),
    h('td', { class: 'left' }, x.symbol),
    h('td', { class: 'left side-' + x.side }, SIDE[x.side]),
    h('td', {}, x.unpriced ? '—' : fmtPrice(x.price)),
    h('td', {}, fmtQty(x.qty)),
    h('td', { class: 'muted' }, x.fee > 0 ? `${fmtQty(x.fee)} ${x.feeAsset}` : '—'),
    h('td', {}, x.unpriced ? '— (chưa có giá)' : (x.qtyAfter > 0 ? fmtPrice(x.avgAfter) : '—')),
  ]);
}

function renderDrawer(state, colors) {
  const asset = state.drawerAsset;
  const open = Boolean(asset);
  $('drawer-backdrop').hidden = !open;
  $('drawer').hidden = !open;
  if (!open) return;

  const row = state.rows.find((r) => r.asset === asset) ?? {
    asset,
    balance: state.balancesDetail?.total?.[asset] ?? 0,
    avg: null,
    price: state.tickers?.[asset + 'USDT'] ?? null,
    value: null,
    knownQty: 0,
    costHeld: 0,
    unrealized: null,
    unrealizedPct: null,
    realized: 0,
    unknownQty: 0,
    movedOutQty: 0,
    warn: [],
  };
  const pos = state.positions[asset];
  const color = colors.get(asset) ?? OTHER;
  const free = state.balancesDetail?.free?.[asset] ?? row.balance;
  const locked = state.balancesDetail?.locked?.[asset] ?? 0;
  const chg = pct24h(row.price, state.open24h?.[asset + 'USDT']);
  const coinOrders = state.ordersSummary?.byAsset?.[asset] ?? [];

  $('drawer-avatar').textContent = asset.slice(0, 3);
  $('drawer-avatar').setAttribute('style', avatarStyle(color));
  $('drawer-title').textContent = asset;
  $('drawer-price').textContent = row.price != null ? `${fmtPrice(row.price)} USDT` : '—';
  $('drawer-change24h').hidden = chg == null;
  if (chg != null) {
    $('drawer-change24h').textContent = `24h ${fmtPct(chg)}`;
    $('drawer-change24h').className = 'chg-badge num ' + tone(chg);
  }
  $('drawer-balance-sub').textContent = `Tổng: ${fmtQty(row.balance)} · Khả dụng: ${fmtQty(free)} · Khóa lệnh: ${fmtQty(locked)}`;

  $('drawer-avg').textContent = fmtPrice(row.avg);
  $('drawer-now').textContent = fmtPrice(row.price);
  $('drawer-cost').textContent = row.costHeld > 0 ? `${fmtUsd(row.costHeld)} USDT` : '—';
  $('drawer-realized').textContent = fmtSignedUsd(row.realized);
  $('drawer-realized').className = 'num ' + tone(row.realized);

  const notes = row.warn.map((w) => h('li', {}, EXPLAIN[w](row)));
  if (movedOut(row)) {
    notes.push(h('li', { class: 'plain' }, `Đã chuyển ${fmtQty(row.movedOutQty)} ${asset} ra khỏi ví Spot (rút, Earn, Funding). Giá trung bình không đổi.`));
  }
  if (row.warn.includes('unknown')) {
    notes.push(h('li', { class: 'plain' }, 'Mẹo: Nếu coin này từng mua bằng Spot nhưng đã bán hết rồi mua lại hoặc chưa đồng bộ đủ, hãy dùng Quét toàn bộ trong Cài đặt.'));
  }
  $('drawer-notes').replaceChildren(...notes);

  const chronological = pos?.history ?? [];
  const nextChartKey = `${asset}:${chronological.length}:${row.price ?? ''}:${coinOrders.map((o) => `${o.orderId}@${o.price}`).join(',')}`;
  if (nextChartKey !== chartKey && !$('drawer-chart').matches(':hover')) {
    chartKey = nextChartKey;
    const chart = renderPriceChart({ history: chronological, currentPrice: row.price, openOrders: coinOrders });
    $('drawer-chart').hidden = !chart;
    $('drawer-chart').replaceChildren(...(chart ?? []));
  }

  $('drawer-orders-section').hidden = coinOrders.length === 0;
  $('drawer-orders-body').replaceChildren(...coinOrders.map((o) => h('tr', {}, [
    h('td', { class: 'left' }, [
      h('span', { class: `side-badge ${o.side}` }, o.side === 'BUY' ? 'MUA' : 'BÁN'),
      ' ',
      o.symbol,
    ]),
    h('td', {}, o.price > 0 ? fmtPrice(o.price) : 'MARKET'),
    h('td', { class: o.distancePct == null ? 'zero' : tone(o.distancePct) }, o.distancePct == null ? '—' : fmtPct(o.distancePct)),
    h('td', {}, `${fmtQty(o.executedQty)} / ${fmtQty(o.origQty)}`),
    h('td', {}, o.remainingValueUsdt != null ? `${fmtUsd(o.remainingValueUsdt)} USDT` : dash()),
  ])));

  const nextHistoryKey = `${asset}:${chronological.length}`;
  if (nextHistoryKey !== historyKey) {
    historyKey = nextHistoryKey;
    const history = [...chronological].reverse();
    $('drawer-history-body').replaceChildren(...(history.length
      ? history.map(historyRow)
      : [h('tr', {}, h('td', { class: 'left muted', colspan: '7' }, 'Chưa có lịch sử khớp lệnh Spot cho coin này.'))]));
  }
}

export function render(state, visibleOrdersFn) {
  for (const s of ['setup', 'locked', 'main']) $('screen-' + s).hidden = state.screen !== s;
  if (state.screen === 'setup') {
    $('key-error').textContent = state.keyError ?? '';
    $('key-error').hidden = !state.keyError;
    $('key-submit').disabled = state.keyBusy;
    $('key-submit').textContent = state.keyBusy ? 'Đang kiểm tra key…' : 'Lưu và đồng bộ';
    $('key-cancel').hidden = !state.hasKey;
    return;
  }
  if (state.screen !== 'main') return;

  const syncing = state.sync != null;
  $('sync-status').textContent = syncing ? 'Đang đồng bộ'
    : state.lastSyncedAt ? `Đồng bộ lúc ${fmtClock(state.lastSyncedAt)}` : 'Chưa đồng bộ';
  $('live-status').textContent = state.live ? 'Trực tiếp' : 'Ngoại tuyến';
  $('live-status').className = 'status-pill ' + (state.live ? 'on' : '');
  $('btn-refresh').disabled = state.demo || syncing || state.refreshing;
  $('btn-sync').textContent = syncing ? 'Dừng' : 'Đồng bộ';
  $('btn-sync').classList.toggle('primary', !syncing);
  $('btn-sync').disabled = state.demo || (syncing && state.sync.stopping);

  $('demo-banner').hidden = !state.demo;
  $('key-warning').hidden = !state.keyWarning;
  $('error').hidden = !state.error;
  $('error-text').textContent = state.error ?? '';
  $('error-retry').hidden = !state.retry;

  $('progress').hidden = !syncing;
  if (syncing) {
    const { phase, done, total, symbol, newTrades, stopping } = state.sync;
    $('progress-bar').value = total > 0 ? done / total : 0;
    $('progress-text').textContent =
      stopping ? 'Đang dừng…'
      : phase === 'prepare' ? 'Đang lấy danh sách cặp giao dịch…'
      : phase === 'prices' ? `Đang lấy giá quy đổi (${fmtQty(done)}/${fmtQty(total)})`
      : `Đang lấy lệnh ${symbol ?? ''} (${fmtQty(done)}/${fmtQty(total)}) · ${fmtQty(newTrades)} lệnh mới`;
  }

  const s = state.summary;
  const os = state.ordersSummary;
  const allocation = allocate(state.rows);
  renderAlloc(allocation);

  setStat('kpi-value', `${fmtUsd(s.value)} USDT`, null);
  const lockedCount = Object.values(state.balancesDetail?.locked ?? {}).filter((v) => v > 0).length;
  $('kpi-value-sub').textContent = lockedCount > 0
    ? `${state.rows.filter((r) => r.balance > 0).length} coin · ${lockedCount} coin đang khóa lệnh`
    : `${state.rows.filter((r) => r.balance > 0).length} coin đang nắm giữ`;
  setStat('kpi-unrealized', fmtSignedUsd(s.unrealized), s.unrealized);
  $('kpi-unrealized-pct').textContent = fmtPct(s.unrealizedPct);
  $('kpi-unrealized-pct').className = 'pill ' + tone(s.unrealized);
  setStat('kpi-cost', `${fmtUsd(s.costHeld)} USDT`, null);
  const unknownRows = state.rows.filter((r) => r.warn.includes('unknown')).length;
  $('kpi-cost-sub').textContent = unknownRows > 0
    ? `${unknownRows} coin có phần chưa rõ nguồn vốn`
    : 'Giá vốn bình quân gia quyền';
  setStat('kpi-realized', fmtSignedUsd(s.realized), s.realized);
  const net = s.unrealized + s.realized;
  $('kpi-net-sub').textContent = `Tổng ròng: ${fmtSignedUsd(net)} USDT`;
  $('kpi-net-sub').className = 'kpi-sub num ' + tone(net);

  $('kpi-orders').textContent = state.ordersError ? 'Lỗi tải' : `${os.totalCount} lệnh`;
  $('kpi-orders-sub').textContent = state.ordersError
    ? 'Bấm để thử tải lại'
    : `${os.buyCount} Mua · ${os.sellCount} Bán · ≈ ${fmtUsd(os.totalLockedUsdt)} USDT`;

  // Workspace tabs
  $('tab-holdings').classList.toggle('active', state.tab === 'holdings');
  $('tab-holdings').setAttribute('aria-selected', String(state.tab === 'holdings'));
  $('tab-orders').classList.toggle('active', state.tab === 'orders');
  $('tab-orders').setAttribute('aria-selected', String(state.tab === 'orders'));
  $('panel-holdings').hidden = state.tab !== 'holdings';
  $('panel-orders').hidden = state.tab !== 'orders';

  const visibleHoldings = visibleRows(state);
  $('tab-holdings-count').textContent = String(state.rows.length);
  $('tab-orders-count').textContent = String(os.totalCount);
  $('tab-orders-dot').hidden = os.totalCount === 0;

  // Holdings table
  $('search').value = state.query;
  $('hide-small').checked = state.hideSmall;
  for (const btn of $('holdings-filters').querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.hfilter === state.holdingsFilter);
  }
  for (const th of document.querySelectorAll('#holdings thead th')) {
    const key = th.querySelector('button').dataset.sort;
    if (key === state.sort.key) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }
  $('row-count').textContent = state.rows.length ? `${visibleHoldings.length}/${state.rows.length} coin` : '';
  const focusedHolding = document.activeElement?.closest?.('#holdings-body tr')?.dataset.asset;
  $('holdings-body').replaceChildren(...visibleHoldings.map((r) => holdingRow(r, state, allocation.colors)));
  for (const r of state.rows) lastPrice.set(r.asset, r.price);
  if (focusedHolding) $('holdings-body').querySelector(`tr[data-asset="${CSS.escape(focusedHolding)}"]`)?.focus();
  $('holdings').hidden = visibleHoldings.length === 0;
  $('empty').hidden = visibleHoldings.length > 0;
  const noData = state.rows.length === 0;
  $('empty-text').textContent = noData
    ? 'Chưa có lệnh nào. Bấm Đồng bộ để lấy lịch sử từ Binance.'
    : 'Không có coin nào khớp bộ lọc hiện tại.';
  $('empty-sync').hidden = !noData || syncing || state.demo;

  // Open Orders table
  $('orders-summary-buy').textContent = `${os.buyCount} lệnh (≈ ${fmtUsd(os.buyValueUsdt)} USDT)`;
  $('orders-summary-sell').textContent = `${os.sellCount} lệnh (≈ ${fmtUsd(os.sellValueUsdt)} USDT)`;
  $('orders-error').hidden = !state.ordersError;
  $('orders-error-text').textContent = state.ordersError ?? '';

  $('order-search').value = state.orderQuery;
  for (const btn of $('order-side-filters').querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.oside === state.orderSide);
  }
  for (const btn of $('order-type-filters').querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.otype === state.orderType);
  }
  for (const th of document.querySelectorAll('#open-orders thead th')) {
    const key = th.querySelector('button').dataset.osort;
    if (key === state.orderSort.key) th.setAttribute('aria-sort', state.orderSort.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }

  const filteredOrders = visibleOrdersFn(state.openOrders, {
    query: state.orderQuery,
    side: state.orderSide,
    typeFilter: state.orderType,
    sort: state.orderSort,
  });
  $('order-count').textContent = state.openOrders.length ? `${filteredOrders.length}/${state.openOrders.length} lệnh` : '';
  $('open-orders-body').replaceChildren(...filteredOrders.map(orderRow));
  $('open-orders').hidden = filteredOrders.length === 0;
  $('orders-empty').hidden = filteredOrders.length > 0;
  $('orders-empty-text').textContent = state.ordersError
    ? 'Không tải được danh sách lệnh chờ khớp.'
    : state.openOrders.length === 0
      ? 'Hiện không có lệnh Spot nào đang chờ khớp.'
      : 'Không có lệnh chờ nào khớp bộ lọc hiện tại.';

  renderDrawer(state, allocation.colors);
}

export function renderSettings({ apiKeyMasked, extraAssets, extraError, demo }) {
  $('key-masked').textContent = apiKeyMasked;
  $('extra-error').textContent = extraError ?? '';
  $('extra-error').hidden = !extraError;
  $('extra-list').replaceChildren(...extraAssets.map((a) =>
    h('li', {}, [a, h('button', { type: 'button', 'data-remove-extra': a, 'aria-label': `Bỏ ${a}` }, '×')])));
  for (const id of ['key-change', 'key-remove', 'scan-full', 'export-sqlite', 'export-csv', 'wipe']) $(id).disabled = demo;
  $('extra-form').querySelector('button').disabled = demo;
}

export function askConfirm(text, okLabel, { danger = false } = {}) {
  const dlg = $('confirm');
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  $('confirm-ok').className = 'btn small ' + (danger ? 'danger' : 'primary');
  dlg.returnValue = 'cancel';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}
