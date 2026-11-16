import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChartBounds, renderPriceChart } from '../extension/chart.js';

function mockDocument() {
  const mockElements = [];
  function createMockEl(tag, ns = null) {
    const attrs = {};
    const listeners = {};
    const children = [];
    const el = {
      tag,
      ns,
      attributes: attrs,
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k]; },
      className: '',
      children,
      append(...items) {
        for (const item of items) if (item != null) children.push(item);
      },
      replaceChildren(...items) {
        children.length = 0;
        for (const item of items) {
          children.push(item == null ? String(item) : item);
        }
      },
      addEventListener(type, cb) {
        listeners[type] = listeners[type] || [];
        listeners[type].push(cb);
      },
      trigger(type) {
        for (const cb of listeners[type] || []) cb();
      },
      hidden: false,
      style: {},
      textContent: '',
    };
    mockElements.push(el);
    return el;
  }

  const prevDoc = globalThis.document;
  globalThis.document = {
    createElementNS: (ns, tag) => createMockEl(tag, ns),
    createElement: (tag) => createMockEl(tag),
  };
  return {
    mockElements,
    restore() {
      if (prevDoc) globalThis.document = prevDoc;
      else delete globalThis.document;
    },
  };
}

test('computeChartBounds giữ lệnh chờ hợp lý trong khung và đẩy lệnh cực xa ra ngoài khung', () => {
  const fills = [
    { side: 'BUY', price: 60000, time: 1000, qty: 0.1 },
    { side: 'BUY', price: 65000, time: 2000, qty: 0.1 },
  ];
  const history = [
    { qtyAfter: 0.1, avgAfter: 60000 },
    { qtyAfter: 0.2, avgAfter: 62500 },
  ];
  const openOrders = [
    { orderId: 1, side: 'SELL', price: 74500 },   // trong ngưỡng [24000, 168625]
    { orderId: 2, side: 'SELL', price: 250000 },  // vượt 2.5x -> outOfRange
    { orderId: 3, side: 'BUY', price: 15000 },    // dưới 0.4x -> outOfRange
    { orderId: 4, side: 'BUY', price: 0 },        // bỏ qua vì price <= 0
  ];
  const res = computeChartBounds(fills, history, 67450, openOrders);

  assert.equal(res.inRangeOrders.map((o) => o.orderId).join(','), '1');
  assert.equal(res.outOfRangeOrders.map((o) => o.orderId).join(','), '2,3');
  assert.ok(res.lo < 60000 && res.hi > 74500);
});

test('computeChartBounds khi không có openOrders hoặc currentPrice = null', () => {
  const fills = [{ price: 100 }, { price: 200 }];
  const history = [{ qtyAfter: 1, avgAfter: 150 }];
  const res = computeChartBounds(fills, history, null);

  assert.equal(res.baseLo, 100);
  assert.equal(res.baseHi, 200);
  assert.deepEqual(res.inRangeOrders, []);
  assert.deepEqual(res.outOfRangeOrders, []);
  assert.ok(res.lo < 100 && res.hi > 200);
});

test('computeChartBounds xử lý trường hợp đơn giá trị (padY)', () => {
  const fills = [{ price: 100 }];
  const history = [];
  const res = computeChartBounds(fills, history, null, []);
  assert.equal(res.baseLo, 100);
  assert.equal(res.baseHi, 100);
  assert.equal(res.lo, 90);
  assert.equal(res.hi, 110);
});

test('renderPriceChart trả về null khi fills < 2', () => {
  assert.equal(renderPriceChart({ history: [] }), null);
  assert.equal(renderPriceChart({ history: [{ side: 'BUY', qty: 1, price: 100, time: 1000 }] }), null);
  assert.equal(
    renderPriceChart({
      history: [
        { side: 'FEE', qty: 0, price: 0, time: 1000 },
        { side: 'BUY', qty: 1, price: 100, time: 2000 },
      ],
    }),
    null
  );
});

test('renderPriceChart dựng đầy đủ SVG, đường trung bình, tooltip tương tác và banner ngoài khung', () => {
  const { mockElements, restore } = mockDocument();

  try {
    const history = [
      { side: 'BUY', symbol: 'BTCUSDT', price: 60000, qty: 0.1, time: 1000, qtyAfter: 0.1, avgAfter: 60000 },
      { side: 'BUY', symbol: 'BTCUSDT', price: 65000, qty: 0.1, time: 2000, qtyAfter: 0.2, avgAfter: 62500 },
      { side: 'SELL', symbol: 'BTCUSDT', price: 70000, qty: 0.2, time: 3000, qtyAfter: 0, avgAfter: 0 },
    ];
    const openOrders = [
      { orderId: 1, side: 'SELL', price: 72000 },
      { orderId: 2, side: 'BUY', price: 10000 }, // out of range
    ];
    const currentPrice = 68000;

    const res = renderPriceChart({ history, currentPrice, openOrders });
    assert.ok(Array.isArray(res));
    assert.equal(res.length, 3); // out-range banner, stage, figcaption

    // Banner kiểm tra text lệnh ngoài khung
    assert.equal(res[0].className, 'chart-out-range');
    assert.ok(res[0].children[0].includes('Lệnh chờ ngoài khung giá:'));
    assert.ok(res[0].children[0].includes('Mua @ 10,000.00'));

    // Stage chứa SVG và tooltip
    const stage = res[1];
    assert.equal(stage.className, 'chart-stage');
    const svg = stage.children[0];
    const tooltip = stage.children[1];
    assert.equal(svg.tag, 'svg');
    assert.equal(tooltip.className, 'chart-tooltip');
    assert.equal(tooltip.hidden, true);

    // Tìm circle dots
    const circles = mockElements.filter((el) => el.tag === 'circle');
    assert.equal(circles.length, 3);

    // Kích hoạt hover mouseenter trên dot đầu tiên (vị thế đang mở: qtyAfter > 0)
    circles[0].trigger('mouseenter');
    assert.equal(tooltip.hidden, false);
    assert.equal(tooltip.children.length, 3);
    assert.ok(tooltip.children[0].children[0].includes('Mua'));
    assert.ok(tooltip.children[1].children[0].includes('BTCUSDT: 0.1 @ 60,000.00'));
    assert.ok(tooltip.children[2].children[0].includes('Giá TB sau lệnh: 60,000.00'));

    // Kích hoạt mouseleave để ẩn tooltip
    circles[0].trigger('mouseleave');
    assert.equal(tooltip.hidden, true);

    // Kích hoạt hover mouseenter trên sell dot (qtyAfter === 0: vị thế đã tất toán)
    circles[2].trigger('mouseenter');
    assert.equal(tooltip.hidden, false);
    assert.equal(tooltip.children.length, 2);
    assert.ok(tooltip.children[0].children[0].includes('Bán'));
    assert.ok(tooltip.children[1].children[0].includes('BTCUSDT: 0.2 @ 70,000.00'));
    assert.ok(!tooltip.children.includes('null'));
    assert.ok(!tooltip.children.includes(null));

    // Kích hoạt mouseleave để ẩn tooltip
    circles[2].trigger('mouseleave');
    assert.equal(tooltip.hidden, true);

    // Figcaption kiểm tra chú giải
    const figcaption = res[2];
    assert.equal(figcaption.tag, 'figcaption');
    assert.ok(figcaption.children.length >= 4);
    assert.equal(figcaption.children[0].children[0].className, 'key');
  } finally {
    restore();
  }
});

test('computeChartBounds mở rộng khung để chứa các mốc DCA', () => {
  const fills = [{ price: 100 }, { price: 200 }];
  const history = [{ qtyAfter: 1, avgAfter: 150 }];
  const res = computeChartBounds(fills, history, 120, [], [60, 250]);
  assert.equal(res.baseLo, 100);
  assert.ok(res.lo < 60 && res.hi > 250);
});

test('renderPriceChart vẽ đường mốc DCA, đường mục tiêu sau DCA và chú giải', () => {
  const { mockElements, restore } = mockDocument();
  try {
    const history = [
      { side: 'BUY', symbol: 'ETHUSDT', price: 3000, qty: 1, time: 1000, qtyAfter: 1, avgAfter: 3000 },
      { side: 'BUY', symbol: 'ETHUSDT', price: 2600, qty: 1, time: 2000, qtyAfter: 2, avgAfter: 2800 },
    ];
    const res = renderPriceChart({
      history,
      currentPrice: 2400,
      dcaLevels: [{ price: 2280, label: 'DCA −5.0%' }, { price: 2160, label: 'DCA −10.0%' }],
      dcaExit: { price: 2550, label: 'Bán sau DCA 2,550.00' },
    });

    const byClass = (cls) => mockElements.filter((el) => el.attributes.class?.split(' ').includes(cls));
    assert.equal(byClass('dca-line').length, 2);
    assert.deepEqual(byClass('dca-tag').map((el) => el.textContent), ['DCA −5.0%', 'DCA −10.0%']);
    assert.equal(byClass('dca-exit').length, 1);
    assert.deepEqual(byClass('dca-exit-tag').map((el) => el.textContent), ['Bán sau DCA 2,550.00']);

    const caption = res.at(-1);
    const keys = caption.children.map((span) => span.children[0].className);
    assert.ok(keys.includes('key dca'));
    assert.ok(keys.includes('key dca-exit'));
  } finally {
    restore();
  }
});

test('renderPriceChart không vẽ gì thêm khi không có mốc DCA', () => {
  const { mockElements, restore } = mockDocument();
  try {
    renderPriceChart({
      history: [
        { side: 'BUY', symbol: 'ETHUSDT', price: 3000, qty: 1, time: 1000, qtyAfter: 1, avgAfter: 3000 },
        { side: 'BUY', symbol: 'ETHUSDT', price: 2600, qty: 1, time: 2000, qtyAfter: 2, avgAfter: 2800 },
      ],
      currentPrice: 2400,
    });
    assert.equal(mockElements.filter((el) => /dca/.test(el.attributes.class ?? '')).length, 0);
  } finally {
    restore();
  }
});

test('renderPriceChart bỏ bớt nhãn DCA quá sát nhau nhưng vẫn vẽ đủ đường', () => {
  const { mockElements, restore } = mockDocument();
  try {
    renderPriceChart({
      history: [
        { side: 'BUY', symbol: 'ETHUSDT', price: 3300, qty: 1, time: 1000, qtyAfter: 1, avgAfter: 3300 },
        { side: 'BUY', symbol: 'ETHUSDT', price: 2600, qty: 1, time: 2000, qtyAfter: 2, avgAfter: 2950 },
      ],
      currentPrice: 1820,
      dcaLevels: [0.95, 0.9, 0.85, 0.8, 0.7].map((f) => ({ price: 1820 * f, label: `L${f}` })),
    });
    const byClass = (cls) => mockElements.filter((el) => el.attributes.class === cls);
    assert.equal(byClass('dca-line').length, 5);
    const ys = byClass('dca-tag').map((el) => Number(el.attributes.y));
    assert.ok(ys.length >= 2 && ys.length < 5, `expected some labels dropped, got ${ys.length}`);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 10, `labels ${ys[i - 1]} and ${ys[i]} overlap`);
  } finally {
    restore();
  }
});
