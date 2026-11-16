# Kế hoạch tối ưu hóa quét lịch sử lệnh Spot (Spot History Completeness)

## Environment Context
- Language: Node.js (ES modules, type="module")
- Test Command: `npm test`
- Lint Command: `node --check extension/*.js`
- Format Command: None
- Build Command: None (pure vanilla JS Chrome Extension)
- Branch: `main`
- CBM_PROJECT: `binance-trade`
- Host permissions: `https://api.binance.com/*`

## Architecture & Contracts
### 1. `pickSymbols({ exchangeSymbols, balances, knownSymbols, extraAssets, openOrderSymbols, full })`
- **Inputs**:
  - `exchangeSymbols`: `Array<{ symbol: string, base: string, quote: string }>`
  - `balances`: `{ [asset: string]: number }` (Spot balances > 0)
  - `knownSymbols`: `string[]` (Symbols that previously had trades in DB)
  - `extraAssets`: `string[]` (Manually added assets)
  - `openOrderSymbols`: `string[]` (Symbols that currently have open orders)
  - `full`: `boolean` (If true, return all `exchangeSymbols`)
- **Output**:
  - Filtered `exchangeSymbols` where:
    - `s.base` in `assets` (`balances` keys + `extraAssets`), OR
    - `s.quote` in `assets` AND `!STABLES.has(s.quote)` (e.g. user holds BTC -> picks `ETHBTC`, `SOLBTC`), OR
    - `s.symbol` in `knownSymbols`, OR
    - `s.symbol` in `openOrderSymbols`
- **Invariants**:
  - Stablecoins (`USDT, USDC, FDUSD, BUSD, TUSD, DAI`) as quote will NOT cause every USD pair to be matched.
  - Does not mutate input arrays or sets.

### 2. `computePositions(trades, priceAt)` in `cost.js`
- **Unpriced Trade Contract**:
  - When `quoteUsdt == null`, previously the trade was dropped via `continue`.
  - New behavior: The trade is recorded into `p.history` with `{ unpriced: true, price: 0, usdt: 0, ... }`.
  - `p.unpriced` remains `true`.
  - `p.qty` and `p.cost` are NOT modified by unpriced trades.
  - `renderPriceChart` in `chart.js` filters out `unpriced` fills to prevent NaN or 0 bounds.

### 3. Drawer & UI Display in `ui.js`
- When `x.unpriced` is true, display price as `— (chưa có giá quy đổi)` instead of broken numbers.
- When a coin has `unknownQty > 0`, note explains that the coin may have trades from pairs not yet scanned and offers clear guidance.

---

## Task 1: Mở rộng bộ chọn cặp giao dịch `pickSymbols` (Quote crypto + Open Orders)
Wave: 1
Status: completed
Risk: low
Dependencies: none
Model: inherit

Files:
- Modify: extension/sync.js
- Test: test/sync.test.js

Blast radius:
- extension/sync.js
- test/sync.test.js

Acceptance:
- `pickSymbols` chọn các cặp có `quote` là crypto phi-stablecoin mà người dùng đang nắm giữ (ví dụ giữ BTC sẽ quét cả `ETHBTC`, `SOLBTC`).
- `pickSymbols` chọn các cặp từ `openOrderSymbols` ngay cả khi số dư của coin đó = 0.
- Các cặp stablecoin quote (`*USDT`, `*USDC`) không bị quét tràn lan khi người dùng giữ USDT.
- Tất cả unit tests trong `test/sync.test.js` pass.

TDD:
- Behavior: `pickSymbols` bao gồm cặp có quote là coin nắm giữ và cặp đang có lệnh chờ khớp.
- Test file: test/sync.test.js
- Test name: pickSymbols mở rộng: nhận diện quote phi-stable và openOrderSymbols
- 🔴 RED command: npm test
- Expected 🔴 RED failure: assert.deepEqual fails do thiếu các cặp quote hoặc open orders
- Minimal 🟢 GREEN change: Thêm kiểm tra `(assets.has(s.quote) && !STABLES.has(s.quote))` và `openOrders.has(s.symbol)` trong `pickSymbols`.
- Refactor candidates: Giữ logic tinh gọn với `Set`.
- Mocking: none

Steps:
1. 🔴 RED: Thêm test case cho `openOrderSymbols` và quote crypto trong `test/sync.test.js`.
   Command: npm test
   Expected: FAIL
2. 🟢 GREEN: Cập nhật `pickSymbols` trong `extension/sync.js`.
   Command: npm test
   Expected: PASS
3. REFACTOR: Kiểm tra code style và tối ưu tập hợp Set.
4. VERIFY:
   - npm test
   - node --check extension/sync.js

Checkpoint:
- Files: extension/sync.js test/sync.test.js
- Commit: feat: expand pickSymbols for crypto quotes and open order pairs

---

## Task 2: Giữ lại giao dịch chưa quy đổi giá trong lịch sử vị thế (`cost.js` & `chart.js`)
Wave: 1
Status: completed
Risk: medium
Dependencies: none
Model: inherit

Files:
- Modify: extension/cost.js
- Modify: extension/chart.js
- Test: test/cost.test.js
- Test: test/chart.test.js

Blast radius:
- extension/cost.js
- extension/chart.js
- test/cost.test.js
- test/chart.test.js

Acceptance:
- Khi một giao dịch không tìm được giá USDT tại thời điểm đó (`quoteUsdt == null`), giao dịch vẫn được ghi nhận vào `p.history` với cờ `unpriced: true`.
- Vị thế vẫn được đánh dấu `p.unpriced = true`.
- `renderPriceChart` trong `chart.js` không bị vẽ lỗi khi có giao dịch `unpriced`.
- Toàn bộ test của `cost.test.js` và `chart.test.js` pass.

TDD:
- Behavior: `computePositions` ghi nhận trade vào history kể cả khi unpriced; `renderPriceChart` bỏ qua unpriced fills.
- Test file: test/cost.test.js
- Test name: không quy đổi được vẫn lưu history
- 🔴 RED command: npm test
- Expected 🔴 RED failure: assert.equal fails vì `ALT.history` rỗng
- Minimal 🟢 GREEN change: Trong `cost.js`, gọi `record(pos(base), tr, tr.isBuyer ? 'BUY' : 'SELL', tr.qty, 0, { unpriced: true })` trước khi `continue`.
- Refactor candidates: None
- Mocking: none

Steps:
1. 🔴 RED: Thêm assertion kiểm tra `history` khi unpriced trong `test/cost.test.js`.
   Command: npm test
   Expected: FAIL
2. 🟢 GREEN: Cập nhật `computePositions` trong `extension/cost.js` và bộ lọc fills trong `extension/chart.js`.
   Command: npm test
   Expected: PASS
3. REFACTOR: Đảm bảo trường `unpriced` trên trade history nhất quán.
4. VERIFY:
   - npm test
   - node --check extension/cost.js extension/chart.js

Checkpoint:
- Files: extension/cost.js extension/chart.js test/cost.test.js test/chart.test.js
- Commit: fix: preserve unpriced trades in position history and guard chart bounds

---

## Task 3: Kết nối `openOrderSymbols` và tối ưu hiển thị Drawer trong UI
Wave: 2
Status: completed
Risk: low
Dependencies: Task 1, Task 2
Model: inherit

Files:
- Modify: extension/dashboard.js
- Modify: extension/ui.js
- Test: test/markup.test.js
- Test: test/ui.test.js

Blast radius:
- extension/dashboard.js
- extension/ui.js
- test/ui.test.js

Acceptance:
- `dashboard.js` truyền `openOrderSymbols` từ `state.rawOpenOrders` vào `pickSymbols`.
- Drawer hiển thị lịch sử các lệnh `unpriced` rõ ràng với thông tin `— (chưa có giá USDT)`.
- Khi coin có cảnh báo `unknown` (thiếu giá vốn), hiển thị hướng dẫn rõ ràng trong Drawer kèm nút/hành động "Quét toàn bộ" hoặc "Quét coin này".
- Tất cả 94+ tests đều pass.

TDD:
- Behavior: Drawer hiển thị lệnh unpriced chuẩn xác và dashboard nạp openOrderSymbols vào sync.
- Test file: test/ui.test.js
- Test name: drawer hiển thị lệnh unpriced và hướng dẫn unknown
- 🔴 RED command: npm test
- Expected 🔴 RED failure: Không render đúng format cho unpriced history
- Minimal 🟢 GREEN change: Cập nhật `extension/ui.js` và `extension/dashboard.js`.
- Refactor candidates: Clean up DOM helpers.
- Mocking: DOM mock có sẵn trong test suite.

Steps:
1. 🔴 RED: Thêm test case cho hiển thị unpriced và unknown trong `test/ui.test.js`.
   Command: npm test
   Expected: FAIL
2. 🟢 GREEN: Cập nhật `extension/dashboard.js` và `extension/ui.js`.
   Command: npm test
   Expected: PASS
3. REFACTOR: Kiểm tra lint và formatting.
4. VERIFY:
   - npm test
   - node --check extension/dashboard.js extension/ui.js

Checkpoint:
- Files: extension/dashboard.js extension/ui.js test/ui.test.js
- Commit: feat: wire openOrderSymbols into sync and polish unpriced drawer display
