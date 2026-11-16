// Page controller: owns state, wires events, runs sync and live refresh.
import { computePositions } from './cost.js';
import { buildRows, summarize } from './portfolio.js';
import { createClient } from './binance.js';
import { pickSymbols, estimateMinutes, syncTrades, syncPrices, makePriceAt, toTrade } from './sync.js';
import { buildOpenOrders, summarizeOpenOrders, visibleOrders } from './orders.js';
import { tradesToCsv, download } from './export.js';
import { openTicker } from './live.js';
import { render, renderSettings, askConfirm } from './ui.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const state = {
  screen: 'main',
  demo: params.has('demo'),
  tab: 'holdings',
  rows: [],
  summary: summarize([]),
  positions: {},
  balancesDetail: null,
  tickers: {},
  open24h: {},
  rawOpenOrders: [],
  openOrders: [],
  ordersSummary: summarizeOpenOrders([]),
  ordersError: null,
  sync: null,
  refreshing: false,
  lastSyncedAt: null,
  error: null,
  retry: null,
  live: false,
  drawerAsset: null,
  keyWarning: false,
  keyError: null,
  keyBusy: false,
  hasKey: false,
  hideSmall: true,
  holdingsFilter: 'all',
  query: '',
  sort: { key: 'value', dir: 'desc' },
  orderQuery: '',
  orderSide: 'ALL',
  orderType: 'ALL',
  orderSort: { key: 'time', dir: 'desc' },
  apiKey: '',
  extraAssets: [],
  extraError: null,
};

let db = null;
let api = null;
let exchange = null;
let balances = null;
let tickers = null;
let abort = null;
let ticker = null;
let tickerKey = '';
let repaintQueued = false;
let lastFocusEl = null;
const store = globalThis.chrome?.storage?.local;

const update = () => render(state, visibleOrders);

function setError(e, retry = null) {
  console.error(e);
  state.error = e?.kind ? e.message : `Có lỗi xảy ra: ${e?.message ?? e}`;
  state.retry = retry;
}

function recompute(tradeRows, priceRows) {
  state.positions = computePositions(tradeRows.map(toTrade), makePriceAt(priceRows));
  rebuildViews();
  watchPrices();
}

function rebuildViews() {
  const held = balances ?? Object.fromEntries(
    Object.values(state.positions).filter((p) => p.qty > 0).map((p) => [p.asset, p.qty]),
  );
  state.tickers = tickers ?? {};
  state.rows = buildRows(state.positions, held, state.tickers);
  state.summary = summarize(state.rows);
  state.openOrders = buildOpenOrders(state.rawOpenOrders, exchange ?? [], state.tickers);
  state.ordersSummary = summarizeOpenOrders(state.openOrders);
}

function watchPrices() {
  const set = new Set(
    state.rows.filter((r) => r.balance > 0 && r.price != null).map((r) => r.asset + 'USDT'),
  );
  for (const o of state.openOrders) {
    set.add(o.symbol);
    if (o.quote && (tickers?.[o.quote + 'USDT'] != null)) set.add(o.quote + 'USDT');
  }
  const symbols = [...set].sort();
  const key = symbols.join(',');
  if (key === tickerKey) return;
  tickerKey = key;
  ticker?.close();
  ticker = openTicker({
    symbols,
    onStatus: (connected) => { state.live = connected; update(); },
    onPrice: (symbol, price, openPrice) => {
      tickers[symbol] = price;
      if (Number.isFinite(openPrice) && openPrice > 0) state.open24h[symbol] = openPrice;
      if (repaintQueued) return;
      repaintQueued = true;
      setTimeout(() => { repaintQueued = false; rebuildViews(); update(); }, 500);
    },
  });
}

function stopPrices() {
  ticker?.close();
  ticker = null;
  tickerKey = '';
  state.live = false;
}

async function getExchange() {
  exchange ??= await api.exchangeInfo();
  return exchange;
}

async function refreshOpenOrdersOnly() {
  state.ordersError = null;
  try {
    const [raw] = await Promise.all([api.openOrders(), getExchange().catch(() => [])]);
    state.rawOpenOrders = raw;
  } catch (e) {
    console.error(e);
    state.ordersError = e?.kind ? e.message : `Không tải được lệnh chờ: ${e?.message ?? e}`;
  }
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  update();

  const [tradeRows, priceRows] = await Promise.all([db.allTrades(), db.getPrices()]);
  try {
    const [balDetail, latestTickers] = await Promise.all([api.accountBalances(), api.tickerPrices()]);
    state.balancesDetail = balDetail;
    balances = balDetail.total;
    tickers = latestTickers;
    state.error = null;
    state.retry = null;
    await refreshOpenOrdersOnly();
  } catch (e) {
    setError(e, refresh);
  } finally {
    state.refreshing = false;
  }
  recompute(tradeRows, priceRows);
  update();
}

async function runSync(full) {
  if (state.sync) return;
  abort = new AbortController();
  const { signal } = abort;
  state.error = null;
  state.sync = { phase: 'prepare', done: 0, total: 0, symbol: null, newTrades: 0, stopping: false };
  update();
  const onProgress = (p) => {
    state.sync = { ...p, stopping: state.sync.stopping };
    update();
  };

  try {
    const exchangeSymbols = await getExchange();
    const held = await api.account();
    const cursors = await db.getCursors();
    const openOrderSymbols = (state.rawOpenOrders ?? []).map((o) => o.symbol).filter(Boolean);
    const symbols = pickSymbols({
      exchangeSymbols,
      balances: held,
      knownSymbols: cursors.filter((c) => c.last_trade_id != null).map((c) => c.symbol),
      extraAssets: state.extraAssets,
      openOrderSymbols,
      full,
    });
    const skipSyncedSince = full ? Date.now() - 3_600_000 : Infinity;
    await syncTrades({ api, db, symbols, onProgress, signal, skipSyncedSince });
    if (!signal.aborted) {
      const trades = (await db.allTrades()).map(toTrade);
      await syncPrices({ api, db, trades, exchangeSymbols, onProgress, signal });
    }
    if (!signal.aborted) {
      state.lastSyncedAt = Date.now();
      await store.set({ lastSyncedAt: state.lastSyncedAt });
    }
  } catch (e) {
    setError(e, () => runSync(full));
  } finally {
    state.sync = null;
    abort = null;
  }
  await refresh();
}

// ---------- key ----------

async function saveKey(apiKey, secret) {
  if (!apiKey || !secret) {
    state.keyError = 'Nhập đủ API Key và Secret Key.';
    return update();
  }
  state.keyBusy = true;
  state.keyError = null;
  update();

  const candidate = createClient({ apiKey, secret });
  try {
    await candidate.account();
  } catch (e) {
    state.keyBusy = false;
    state.keyError = e.kind ? e.message : `Có lỗi xảy ra: ${e.message}`;
    return update();
  }

  let risky = false;
  try {
    const r = await candidate.apiRestrictions();
    risky = r.canTrade || r.canWithdraw;
  } catch {
    // Permission lookup is advisory; never block on it.
  }

  await store.set({ apiKey, secret, keyRisky: risky });
  api = candidate;
  exchange = null;
  Object.assign(state, {
    apiKey, hasKey: true, keyBusy: false, keyWarning: risky, screen: 'main', error: null,
  });
  $('key-form').reset();
  $('api-secret').type = 'password';
  $('toggle-secret').textContent = 'Hiện';
  update();
  await runSync(false);
}

async function removeKey() {
  const ok = await askConfirm('Xóa API key khỏi máy này? Lịch sử lệnh đã lưu vẫn được giữ.', 'Xóa key', { danger: true });
  if (!ok) return;
  abort?.abort();
  await store.remove(['apiKey', 'secret', 'keyRisky']);
  api = null;
  stopPrices();
  balances = tickers = null;
  state.balancesDetail = null;
  state.rawOpenOrders = [];
  state.openOrders = [];
  state.ordersSummary = summarizeOpenOrders([]);
  state.drawerAsset = null;
  Object.assign(state, { apiKey: '', hasKey: false, keyWarning: false, screen: 'setup', keyError: null });
  $('settings').close();
  update();
}

// ---------- settings ----------

const settingsView = () => renderSettings({
  apiKeyMasked: state.apiKey ? '••••••••' + state.apiKey.slice(-4) : 'Dữ liệu mẫu',
  extraAssets: state.extraAssets,
  extraError: state.extraError,
  demo: state.demo,
});

async function scanFull() {
  try {
    const n = (await getExchange()).length;
    const ok = await askConfirm(
      `Quét toàn bộ ${n.toLocaleString('en-US')} cặp trên Binance, mất khoảng ${estimateMinutes(n)} phút. ` +
      'Giữ tab này mở trong lúc quét. Nếu bị ngắt, bấm Quét toàn bộ lại trong vòng 1 giờ để chạy tiếp từ chỗ dừng.', 'Quét toàn bộ',
    );
    if (!ok) return;
    $('settings').close();
    await runSync(true);
  } catch (e) {
    $('settings').close();
    setError(e, scanFull);
    update();
  }
}

async function addExtra(raw) {
  const asset = raw.trim().toUpperCase();
  if (!asset) return;
  state.extraError = null;
  try {
    const known = (await getExchange()).some((s) => s.base === asset);
    if (!known) state.extraError = 'Không tìm thấy coin này trên Binance Spot.';
    else if (!state.extraAssets.includes(asset)) {
      state.extraAssets = [...state.extraAssets, asset];
      await store.set({ extraAssets: state.extraAssets });
    }
  } catch (e) {
    state.extraError = e.kind ? e.message : `Có lỗi xảy ra: ${e.message}`;
  }
  if (!state.extraError) $('extra-asset').value = '';
  settingsView();
}

async function wipe() {
  const ok = await askConfirm(
    'Xóa toàn bộ lịch sử lệnh đã lưu trên máy này? API key được giữ lại. Bạn có thể đồng bộ lại từ Binance bất cứ lúc nào.',
    'Xóa dữ liệu', { danger: true },
  );
  if (!ok) return;
  await db.wipe();
  await store.remove('lastSyncedAt');
  state.lastSyncedAt = null;
  $('settings').close();
  await refresh();
}

// ---------- drawer & navigation ----------

function openDrawer(asset, triggerEl = document.activeElement) {
  lastFocusEl = triggerEl;
  state.drawerAsset = asset;
  update();
  $('drawer').focus();
}

function closeDrawer() {
  if (!state.drawerAsset) return;
  state.drawerAsset = null;
  update();
  lastFocusEl?.focus?.();
  lastFocusEl = null;
}

function setTab(tab) {
  state.tab = tab;
  update();
}

// ---------- events ----------

function wire() {
  $('key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveKey($('api-key').value.trim(), $('api-secret').value.trim());
  });
  $('toggle-secret').addEventListener('click', () => {
    const input = $('api-secret');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggle-secret').textContent = show ? 'Ẩn' : 'Hiện';
  });
  $('key-cancel').addEventListener('click', () => { state.screen = 'main'; state.keyError = null; update(); });
  $('locked-retry').addEventListener('click', () => location.reload());

  $('btn-refresh').addEventListener('click', refresh);
  $('btn-sync').addEventListener('click', () => {
    if (state.sync) {
      state.sync.stopping = true;
      abort?.abort();
      update();
    } else {
      runSync(false);
    }
  });
  $('empty-sync').addEventListener('click', () => runSync(false));
  $('error-retry').addEventListener('click', () => {
    const retry = state.retry;
    state.error = state.retry = null;
    update();
    retry?.();
  });
  $('orders-retry').addEventListener('click', async () => {
    await refreshOpenOrdersOnly();
    rebuildViews();
    update();
  });

  $('kpi-orders-card').addEventListener('click', () => setTab('orders'));
  $('tab-holdings').addEventListener('click', () => setTab('holdings'));
  $('tab-orders').addEventListener('click', () => setTab('orders'));

  $('alloc-legend').addEventListener('click', (e) => {
    const asset = e.target.closest('[data-drawer-asset]')?.dataset.drawerAsset;
    if (asset) openDrawer(asset, e.target.closest('button'));
  });

  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.drawerAsset && !document.querySelector('dialog[open]')) {
      closeDrawer();
    }
  });

  document.addEventListener('click', (e) => {
    const dismiss = e.target.closest('[data-dismiss]')?.dataset.dismiss;
    if (dismiss === 'error') state.error = state.retry = null;
    if (dismiss === 'key-warning') {
      state.keyWarning = false;
      store?.set({ keyRisky: false });
    }
    if (dismiss) update();
    if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
    if (e.target instanceof HTMLDialogElement && e.target.id !== 'confirm') e.target.close();
  });

  $('search').addEventListener('input', (e) => { state.query = e.target.value; update(); });
  $('holdings-filters').addEventListener('click', (e) => {
    const f = e.target.closest('[data-hfilter]')?.dataset.hfilter;
    if (f) { state.holdingsFilter = f; update(); }
  });
  $('hide-small').addEventListener('change', (e) => {
    state.hideSmall = e.target.checked;
    store?.set({ hideSmall: state.hideSmall });
    update();
  });

  $('holdings').querySelector('thead').addEventListener('click', (e) => {
    const key = e.target.closest('button')?.dataset.sort;
    if (!key) return;
    const same = state.sort.key === key;
    state.sort = { key, dir: same ? (state.sort.dir === 'asc' ? 'desc' : 'asc') : key === 'asset' ? 'asc' : 'desc' };
    update();
  });
  $('holdings-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr) openDrawer(tr.dataset.asset, tr);
  });
  $('holdings-body').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr')) {
      e.preventDefault();
      openDrawer(e.target.dataset.asset, e.target);
    }
  });

  $('order-search').addEventListener('input', (e) => { state.orderQuery = e.target.value; update(); });
  $('order-side-filters').addEventListener('click', (e) => {
    const s = e.target.closest('[data-oside]')?.dataset.oside;
    if (s) { state.orderSide = s; update(); }
  });
  $('order-type-filters').addEventListener('click', (e) => {
    const t = e.target.closest('[data-otype]')?.dataset.otype;
    if (t) { state.orderType = t; update(); }
  });
  $('open-orders').querySelector('thead').addEventListener('click', (e) => {
    const key = e.target.closest('button')?.dataset.osort;
    if (!key) return;
    const same = state.orderSort.key === key;
    state.orderSort = { key, dir: same ? (state.orderSort.dir === 'asc' ? 'desc' : 'asc') : key === 'symbol' ? 'asc' : 'desc' };
    update();
  });
  $('open-orders-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr) openDrawer(tr.dataset.orderAsset, tr);
  });
  $('open-orders-body').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr')) {
      e.preventDefault();
      openDrawer(e.target.dataset.orderAsset, e.target);
    }
  });

  $('btn-settings').addEventListener('click', () => {
    state.extraError = null;
    settingsView();
    $('settings').showModal();
  });
  $('key-change').addEventListener('click', () => {
    $('settings').close();
    state.screen = 'setup';
    update();
    $('api-key').focus();
  });
  $('key-remove').addEventListener('click', removeKey);
  $('scan-full').addEventListener('click', scanFull);
  $('extra-form').addEventListener('submit', (e) => { e.preventDefault(); addExtra($('extra-asset').value); });
  $('extra-list').addEventListener('click', async (e) => {
    const asset = e.target.dataset.removeExtra;
    if (!asset) return;
    state.extraAssets = state.extraAssets.filter((a) => a !== asset);
    await store.set({ extraAssets: state.extraAssets });
    settingsView();
  });
  $('export-sqlite').addEventListener('click', async () =>
    download('binance-spot.sqlite3', await db.exportFile(), 'application/vnd.sqlite3'));
  $('export-csv').addEventListener('click', async () =>
    download('binance-spot-trades.csv', tradesToCsv(await db.allTrades()), 'text/csv'));
  $('wipe').addEventListener('click', wipe);

  window.addEventListener('beforeunload', (e) => { if (state.sync && !state.demo) e.preventDefault(); });
}

// ---------- boot ----------

async function bootDemo() {
  const { demo } = await import('./demo-data.js');
  balances = demo.balances;
  state.balancesDetail = demo.balancesDetail;
  tickers = { ...demo.tickers };
  state.open24h = { ...demo.open24h };
  exchange = demo.exchangeSymbols;
  state.rawOpenOrders = demo.openOrders;
  state.lastSyncedAt = demo.lastSyncedAt;
  recompute(demo.rows, demo.priceRows);

  const view = params.get('state');
  if (view === 'setup' || view === 'locked') state.screen = view;
  if (view === 'syncing') state.sync = { phase: 'trades', done: 12, total: 140, symbol: 'BTCUSDT', newTrades: 3204, stopping: false };
  if (view === 'error') state.error = 'Không kết nối được tới Binance. Kiểm tra mạng rồi thử lại.';
  if (view === 'orders') state.tab = 'orders';
  if (view === 'drawer') state.drawerAsset = 'BTC';
  if (view === 'empty') {
    state.rows = [];
    state.summary = summarize([]);
    state.balancesDetail = null;
    state.rawOpenOrders = [];
    state.openOrders = [];
    state.ordersSummary = summarizeOpenOrders([]);
    state.lastSyncedAt = null;
  }
  update();
}

async function boot() {
  wire();
  if (state.demo) return bootDemo();

  try {
    const { openDb } = await import('./db.js');
    db = await openDb();
  } catch (e) {
    if (e.code === 'LOCKED') state.screen = 'locked';
    else setError(new Error(`không mở được cơ sở dữ liệu (${e.message})`));
    return update();
  }

  const saved = await store.get(['apiKey', 'secret', 'keyRisky', 'extraAssets', 'lastSyncedAt', 'hideSmall']);
  state.extraAssets = saved.extraAssets ?? [];
  state.lastSyncedAt = saved.lastSyncedAt ?? null;
  state.hideSmall = saved.hideSmall ?? true;

  if (!saved.apiKey || !saved.secret) {
    state.screen = 'setup';
    return update();
  }
  api = createClient({ apiKey: saved.apiKey, secret: saved.secret });
  Object.assign(state, { apiKey: saved.apiKey, hasKey: true, keyWarning: Boolean(saved.keyRisky) });
  await refresh();
}

boot();
