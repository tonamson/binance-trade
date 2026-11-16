import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDca, defaultDcaAmount } from '../extension/dca.js';

const near = (actual, want, label) =>
  assert.ok(Math.abs(actual - want) < 1e-9, `${label}: expected ${want}, got ${actual}`);

test('không có vốn đã biết hoặc thiếu giá thì không gợi ý', () => {
  assert.equal(planDca({ qty: 0, cost: 0, price: 10, amount: 100 }), null);
  assert.equal(planDca({ qty: 1, cost: 100, price: null, amount: 100 }), null);
});

test('mốc gốc: giá hòa vốn hiện tại và mức cần tăng từ giá hiện tại', () => {
  const plan = planDca({ qty: 2, cost: 200, price: 50, amount: 100, steps: [], fee: 0 });
  near(plan.base.avg, 100, 'avg');
  near(plan.base.breakEven, 100, 'breakEven');
  near(plan.base.risePct, 100, 'risePct');
  assert.deepEqual(plan.rows, []);
});

test('mua thêm tại giá hiện tại kéo giá trung bình xuống', () => {
  const plan = planDca({ qty: 1, cost: 100, price: 50, amount: 50, steps: [0], fee: 0 });
  const [r] = plan.rows;
  near(r.price, 50, 'price');
  near(r.dropPct, 0, 'dropPct');
  near(r.boughtQty, 1, 'boughtQty');
  near(r.totalQty, 2, 'totalQty');
  near(r.totalCost, 150, 'totalCost');
  near(r.avg, 75, 'avg');
  near(r.breakEven, 75, 'breakEven');
  near(r.risePct, 50, 'risePct');
  assert.equal(r.source, 'step');
});

test('các mốc cộng dồn: mốc sau giả định mốc trước đã khớp', () => {
  const plan = planDca({ qty: 1, cost: 100, price: 50, amount: 50, steps: [0, 50], fee: 0 });
  const [, r] = plan.rows;
  near(r.price, 25, 'price');
  near(r.dropPct, 50, 'dropPct');
  near(r.totalQty, 4, 'totalQty');
  near(r.totalCost, 200, 'totalCost');
  near(r.avg, 50, 'avg');
  near(r.risePct, 100, 'risePct');
});

test('phí mua làm giảm lượng nhận, phí bán đẩy giá hòa vốn lên', () => {
  const plan = planDca({ qty: 1, cost: 100, price: 50, amount: 50, steps: [0], fee: 0.001 });
  const [r] = plan.rows;
  near(r.boughtQty, 0.999, 'boughtQty');
  near(r.avg, 150 / 1.999, 'avg');
  near(r.breakEven, 150 / 1.999 / 0.999, 'breakEven');
});

test('mục tiêu lãi nâng giá chốt và mức cần tăng', () => {
  const plan = planDca({ qty: 1, cost: 100, price: 50, amount: 50, steps: [0], fee: 0, targetPct: 10 });
  const [r] = plan.rows;
  near(r.target, 82.5, 'target');
  near(r.risePct, 65, 'risePct');
  near(plan.base.target, 110, 'base target');
});

test('lệnh mua đang chờ được xen vào thang theo giá, dùng đúng số tiền của lệnh', () => {
  const plan = planDca({
    qty: 1, cost: 100, price: 50, amount: 50, steps: [0, 50], fee: 0,
    buyOrders: [{ price: 40, amount: 80 }],
  });
  assert.deepEqual(plan.rows.map((r) => [r.price, r.source]), [[50, 'step'], [40, 'order'], [25, 'step']]);
  const order = plan.rows[1];
  near(order.amount, 80, 'amount');
  near(order.totalQty, 4, 'totalQty');
  near(order.totalCost, 230, 'totalCost');
  near(order.dropPct, 20, 'dropPct');
});

test('số tiền mặc định khoảng 1/4 vốn, làm tròn 2 chữ số, tối thiểu 10 USDT', () => {
  assert.equal(defaultDcaAmount(1234), 310);
  assert.equal(defaultDcaAmount(20), 10);
  assert.equal(defaultDcaAmount(0), 10);
});
