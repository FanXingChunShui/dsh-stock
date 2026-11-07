/**
 * dsh-astock / tests/adjust.test.mjs
 * lib/adjust.js 自测。全部使用合成 K 线，不联网、不读文件。
 *
 * ── 覆盖范围 ────────────────────────────────────────────────────
 * 一、无事件时原样返回（深拷贝语义）
 * 二、单次纯派息：除权日之前按比例下移，末根不变
 * 三、单次高送转 10 送 10：之前的价格约减半
 * 四、多次除权：因子链正确累乘，越早的价格被缩放越多
 * 五、「末根 K 线复权前后完全相等」强校验
 * 六、除权日早于 K 线起点 / 晚于 K 线终点
 * 七、空 bars、空 events、null 入参 —— 结构完整不抛异常
 * 八、成交量保持原值（刻意设计：只调价，不调量）
 * 九、纯函数性：不修改入参、不复用引用
 * 十、非法事件（exDate 为 null / 全 0 / 日期格式错）被忽略
 * 十一、同日多条事件合并、字段简写与字符串数字兼容
 * 十二、precision 选项与 verifyAnchor 的自检能力
 *
 * ── 精确值怎么来的 ──────────────────────────────────────────────
 * 复权公式（见 lib/adjust.js 文件头）：
 *   div  = 派息(每10股) / 10
 *   add  = (送股 + 转增)(每10股) / 10
 *   theo = (前收 - div) / (1 + add)
 *   f    = theo / 前收
 * 下面每个用例的期望值都是按这个公式手算的，并在注释里留了算式。
 *
 * ── 历史缺陷（均已修复，用例保留为回归护栏）────────────────────
 * BUG-1 除权日晚于最后一根 K 线时，实现曾把整段（含末根）一起缩放，
 *       违反「末根不变」强约束。修复：buildFactors 的二分后加
 *       `if (idx >= list.length - 1) continue;`。
 *       对应用例见「除权日晚于 K 线终点」。
 * BUG-2 锚点校验失败时曾只写 warning 却不回退，导致「提示说用了不复权、
 *       实际给了错误价格」。修复：失败时返回不复权数据的深拷贝。
 *       对应用例见「锚点回退契约」。
 *
 * ── 一条值得记录的实现性质 ──────────────────────────────────────
 * 修复 BUG-1 之后，锚点回退分支（BUG-2 的修复路径）在当前实现下**不可达**：
 * 缩放循环 `if (bar.date >= exDate) break` 只可能在「全部 K 线日期 < exDate」
 * 时走到末根，而那种输入恰恰会让 buildFactors 的 idx 落在末根、被上面的
 * 守卫拦掉。本文件用「回退契约 + 极端输入不变量」两条用例从外部锁住这条
 * 性质，一旦将来改动破坏它，测试会立刻失败。
 *
 * 运行：cd dsh-astock && node --test tests/adjust.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { adjustBars, buildFactors, verifyAnchor } from '../lib/adjust.js';

/* ════════════════════════════════════════════════════════════════
 * 断言辅助
 * ════════════════════════════════════════════════════════════════ */

/**
 * 浮点近似相等。用于断言复权因子这类需要精确到 1e-12 的比值。
 * 不用 assert.ok(Math.abs(a-b) < eps) 是为了失败时能看到实际值。
 */
function near(actual, expected, eps = 1e-9, message = '') {
  assert.equal(
    typeof actual,
    'number',
    `${message} 期望得到数字，实际是 ${typeof actual}（${actual}）`,
  );
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff <= eps,
    `${message} 期望 ${expected}，实际 ${actual}，差值 ${diff} 超过容差 ${eps}`,
  );
}

/** 取 [date, close] 便于断言时一眼看出日期与价格。 */
function closes(result) {
  return result.bars.map((b) => [b.date, b.close]);
}

/** 深拷贝一份数据做「入参是否被改动」的快照。 */
function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ════════════════════════════════════════════════════════════════
 * 合成 K 线工厂
 * ════════════════════════════════════════════════════════════════ */

/**
 * 按日期列表造 K 线。价格刻意与日期解耦，让每个用例的算式保持可手算。
 * @param {Array<{date:string, open?:number|null, high?:number, low?:number, close:number|null, volume?:number}>} rows
 */
function makeBars(rows) {
  return rows.map((row) => ({
    date: row.date,
    open: row.open === undefined ? row.close : row.open,
    high: row.high === undefined ? row.close : row.high,
    low: row.low === undefined ? row.close : row.low,
    close: row.close,
    volume: row.volume === undefined ? 1000 : row.volume,
  }));
}

/** 一日 K 线（open=high=low=close），用于只需要收盘价的场景。 */
function flat(date, close, volume = 1000) {
  return { date, open: close, high: close, low: close, close, volume };
}

/* ════════════════════════════════════════════════════════════════
 * 公共夹具
 * ════════════════════════════════════════════════════════════════ */

/**
 * lead 已自测通过的手工案例，作为本文件的主基准。
 *   前收 20.5，每 10 股送 10 股派 10 元
 *   div = 1，add = 1
 *   theo = (20.5 - 1) / (1 + 1) = 9.75
 *   f    = 9.75 / 20.5 ≈ 0.47560975609756095
 */
const MANUAL_BARS = makeBars([
  { date: '2024-01-02', open: 19, high: 21, low: 18, close: 20, volume: 1000 },
  { date: '2024-01-03', open: 20, high: 21, low: 19, close: 20.5, volume: 900 },
  { date: '2024-06-20', open: 10.2, high: 10.5, low: 10, close: 10.3, volume: 2000 },
  { date: '2024-06-21', open: 10.3, high: 10.4, low: 10.1, close: 10.2, volume: 1500 },
]);
const MANUAL_EVENTS = [{ exDate: '2024-06-20', song: 10, zhuan: 0, pai: 10 }];

/* ════════════════════════════════════════════════════════════════
 * 一、无事件 → 原样返回
 * ════════════════════════════════════════════════════════════════ */

test('无分红事件时价格原样返回，adjusted 为 false 且无 warning', () => {
  const result = adjustBars(MANUAL_BARS, []);

  assert.deepEqual(closes(result), [
    ['2024-01-02', 20],
    ['2024-01-03', 20.5],
    ['2024-06-20', 10.3],
    ['2024-06-21', 10.2],
  ]);
  assert.equal(result.adjusted, false);
  assert.equal(result.events, 0);
  assert.deepEqual(result.factors, []);
  assert.equal(result.warning, null);
});

test('无事件返回的是深拷贝：数组与每个对象都是新引用，改结果不影响入参', () => {
  const original = snapshot(MANUAL_BARS);
  const result = adjustBars(MANUAL_BARS, []);

  assert.notEqual(result.bars, MANUAL_BARS, 'bars 必须是新数组');
  assert.equal(result.bars.length, MANUAL_BARS.length);
  for (let i = 0; i < result.bars.length; i += 1) {
    assert.notEqual(result.bars[i], MANUAL_BARS[i], `第 ${i} 根必须是新对象`);
  }

  // 改复权结果不能反过来污染入参
  result.bars[0].close = 999;
  result.bars[1].high = 888;
  assert.deepEqual(snapshot(MANUAL_BARS), original, '入参不能被结果影响');
});

/* ════════════════════════════════════════════════════════════════
 * 二、单次纯派息
 * ════════════════════════════════════════════════════════════════ */

test('单次纯派息：除权日之前的价格按 theo/前收 下移，末根保持不变', () => {
  // 每 10 股派 12 元 → div = 1.2；前收 25.6
  // theo = (25.6 - 1.2) / 1 = 24.4
  // f    = 24.4 / 25.6 = 0.953125（二进制精确，可做严格断言）
  const bars = makeBars([
    { date: '2024-06-13', open: 25, high: 25.5, low: 24.5, close: 25, volume: 1000 },
    { date: '2024-06-14', open: 25, high: 25.8, low: 24.8, close: 25.6, volume: 1200 },
    { date: '2024-06-17', open: 22, high: 22.3, low: 21.8, close: 22, volume: 2400 },
    { date: '2024-06-18', open: 22, high: 22.4, low: 21.9, close: 22.2, volume: 1500 },
  ]);
  const events = [{ exDate: '2024-06-17', song: 0, zhuan: 0, pai: 12 }];

  const result = adjustBars(bars, events);

  assert.equal(result.adjusted, true);
  assert.equal(result.events, 1);
  assert.equal(result.warning, null, '正常区间内除权不应触发锚点告警');
  assert.equal(result.factors.length, 1);

  const factor = result.factors[0];
  assert.equal(factor.date, '2024-06-17');
  assert.equal(factor.prevClose, 25.6, '前收取的是除权日前最后一根的收盘价');
  near(factor.theo, 24.4, 1e-12, 'theo 应为 (25.6-1.2)/1');
  near(factor.factor, 0.953125, 1e-12, 'f 应为 24.4/25.6');

  // 06-13：全部价格 * 0.953125，保留 4 位小数
  //   open  25   * 0.953125 = 23.828125  → 23.8281
  //   high  25.5 * 0.953125 = 24.3046875 → 24.3047
  //   low   24.5 * 0.953125 = 23.3515625 → 23.3516
  //   close 25   * 0.953125 = 23.828125  → 23.8281
  const d13 = result.bars[0];
  assert.equal(d13.open, 23.8281);
  assert.equal(d13.high, 24.3047);
  assert.equal(d13.low, 23.3516);
  assert.equal(d13.close, 23.8281);

  // 06-14：紧邻除权日的「前收」被整体折算成理论除权价 24.4
  assert.equal(result.bars[1].close, 24.4);
  assert.equal(result.bars[1].open, 23.8281, 'open 25 * 0.953125 = 23.8281（25 也是 25.0）');

  // 除权日当天及之后完全不动
  assert.deepEqual(closes(result).slice(2), [
    ['2024-06-17', 22],
    ['2024-06-18', 22.2],
  ]);
});

test('单次纯派息后，除权日前的相邻收盘价不再出现假跳空', () => {
  // 真实数据里除权日会「价格下跌 1.2 元」，复权后应变成连续
  const bars = makeBars([
    flat('2024-06-14', 25.6),
    { date: '2024-06-17', open: 22.4, high: 22.6, low: 22.0, close: 22.4 },
    flat('2024-06-18', 22.5),
  ]);
  const result = adjustBars(bars, [{ exDate: '2024-06-17', pai: 12 }]);

  const before = result.bars[0].close; // 25.6 * 0.953125 = 24.4
  const after = result.bars[1].close; // 22.4 不动
  near(before, 24.4, 1e-9);
  assert.equal(after, 22.4);
  // 复权后的「前一日 → 除权日」跌幅（约 -8.2%）远小于不复权的 -12.5%，
  // 但仍不是 0——因为真实行情当天本身就在跌，这正是期望行为：
  // 复权只抹掉除权带来的那部分缺口，不抹掉真实涨跌。
  const gap = after / before - 1;
  assert.ok(gap > -0.09 && gap < -0.08, `复权后缺口应约 -8.2%，实际 ${(gap * 100).toFixed(2)}%`);
});

/* ════════════════════════════════════════════════════════════════
 * 三、单次高送转
 * ════════════════════════════════════════════════════════════════ */

test('单次 10 送 10：除权日之前的价格精确减半（因子 0.5），末根不变', () => {
  // 前收 20，每 10 股送 10 股 → add = 1，div = 0
  // theo = 20 / 2 = 10，f = 10 / 20 = 0.5（精确）
  const bars = makeBars([
    { date: '2024-05-29', open: 19.8, high: 20.6, low: 19.6, close: 20, volume: 1000 },
    { date: '2024-05-30', open: 20, high: 20.5, low: 19.8, close: 20, volume: 1200 },
    { date: '2024-05-31', open: 20, high: 20.2, low: 19.9, close: 20, volume: 1100 },
    { date: '2024-06-03', open: 10, high: 10.3, low: 9.9, close: 10.1, volume: 2400 },
    { date: '2024-06-04', open: 10.1, high: 10.4, low: 10, close: 10.2, volume: 1500 },
  ]);
  const result = adjustBars(bars, [{ exDate: '2024-06-03', song: 10, zhuan: 0, pai: 0 }]);

  assert.equal(result.factors.length, 1);
  assert.equal(result.factors[0].factor, 0.5, '10 送 10 的因子必须精确等于 0.5');
  assert.equal(result.factors[0].theo, 10);
  assert.equal(result.factors[0].prevClose, 20);

  // 除权日之前三根全部减半（0.5 是二进制精确值，可严格相等）
  assert.deepEqual(closes(result).slice(0, 3), [
    ['2024-05-29', 10],
    ['2024-05-30', 10],
    ['2024-05-31', 10],
  ]);
  assert.equal(result.bars[0].open, 9.9);
  assert.equal(result.bars[0].high, 10.3);
  assert.equal(result.bars[0].low, 9.8);

  // 除权日及之后不动
  assert.deepEqual(closes(result).slice(3), [
    ['2024-06-03', 10.1],
    ['2024-06-04', 10.2],
  ]);
});

test('转增也参与送转比例：10 转 10 与 10 送 10 的因子相同', () => {
  const bars = [
    flat('2024-05-30', 20),
    flat('2024-06-03', 10),
    flat('2024-06-04', 10.1),
  ];
  const bySong = adjustBars(bars, [{ exDate: '2024-06-03', song: 10, zhuan: 0, pai: 0 }]);
  const byZhuan = adjustBars(bars, [{ exDate: '2024-06-03', song: 0, zhuan: 10, pai: 0 }]);
  const byMixed = adjustBars(bars, [{ exDate: '2024-06-03', song: 5, zhuan: 5, pai: 0 }]);

  assert.equal(bySong.factors[0].factor, 0.5);
  assert.equal(byZhuan.factors[0].factor, 0.5, '转增和送股对价格的影响完全等价');
  assert.equal(byMixed.factors[0].factor, 0.5, '5 送 5 转也是 add = 1');
  assert.deepEqual(byZhuan.bars, bySong.bars);
});

/* ════════════════════════════════════════════════════════════════
 * 四、多次除权 → 因子链累乘
 * ════════════════════════════════════════════════════════════════ */

test('多次除权：因子链正确累乘，越早的价格被缩放越多', () => {
  // 事件 1：2023-06-20，前收 40，10 送 10 → theo 20，f1 = 0.5
  // 事件 2：2024-06-20，前收 20，每 10 股派 10 元（div 1）→ theo 19，f2 = 0.95
  // 2023-06-19 及更早：同时被 f1 与 f2 乘 → 40 * 0.5 * 0.95 = 19
  // 2023-06-20 ~ 2024-06-19：只被 f2 乘 → 20 * 0.95 = 19
  // 2024-06-20 及之后：不动
  const bars = makeBars([
    flat('2023-01-03', 40, 1000),
    flat('2023-06-19', 40, 1000),
    flat('2023-06-20', 20, 2000),
    flat('2024-06-19', 20, 1000),
    flat('2024-06-20', 19, 500),
    flat('2024-06-21', 19.2, 800),
  ]);
  const events = [
    { exDate: '2023-06-20', song: 10, zhuan: 0, pai: 0 },
    { exDate: '2024-06-20', song: 0, zhuan: 0, pai: 10 },
  ];

  const result = adjustBars(bars, events);

  assert.equal(result.factors.length, 2);
  // 因子按日期升序返回，且各自的前收是「不复权」数据里的前收
  assert.deepEqual(
    result.factors.map((f) => [f.date, f.prevClose]),
    [
      ['2023-06-20', 40],
      ['2024-06-20', 20],
    ],
  );
  assert.equal(result.factors[0].factor, 0.5);
  near(result.factors[1].factor, 0.95, 1e-12);
  assert.equal(result.events, 2);
  assert.equal(result.warning, null);

  // 累乘结果：越早被乘的因子越多
  assert.deepEqual(closes(result), [
    ['2023-01-03', 19],
    ['2023-06-19', 19],
    ['2023-06-20', 19],
    ['2024-06-19', 19],
    ['2024-06-20', 19],
    ['2024-06-21', 19.2],
  ]);

  // 显式校验累乘：最早的价格缩得比中间段多
  const earliest = result.bars[0].close;
  const middle = result.bars[2].close;
  near(earliest / 40, 0.5 * 0.95, 1e-12, '最早段应乘满两个因子');
  near(middle / 20, 0.95, 1e-12, '中间段只乘除权晚的那个因子');
  assert.ok(earliest < middle || earliest === middle, '缩放后价格单调关系不应被反转');
});

test('多次除权时事件传入顺序不影响结果', () => {
  const bars = makeBars([
    flat('2023-01-03', 40),
    flat('2023-06-20', 20),
    flat('2024-06-20', 19),
    flat('2024-06-21', 19.2),
  ]);
  const ascending = [
    { exDate: '2023-06-20', song: 10, zhuan: 0, pai: 0 },
    { exDate: '2024-06-20', song: 0, zhuan: 0, pai: 10 },
  ];
  const descending = [ascending[1], ascending[0]];

  const a = adjustBars(bars, ascending);
  const b = adjustBars(bars, descending);

  assert.deepEqual(a.bars, b.bars, '实现内部应先排序再处理，与传入顺序无关');
  assert.deepEqual(
    a.factors.map((f) => f.date),
    ['2023-06-20', '2024-06-20'],
  );
});

/* ════════════════════════════════════════════════════════════════
 * 五、「末根 K 线不变」强校验（核心不变量）
 * ════════════════════════════════════════════════════════════════ */

test('末根 K 线复权前后完全相等（lead 手工案例，含 open/high/low/close 四个价格）', () => {
  const result = adjustBars(MANUAL_BARS, MANUAL_EVENTS);
  const lastRaw = MANUAL_BARS[MANUAL_BARS.length - 1];
  const lastAdjusted = result.bars[result.bars.length - 1];

  // 用严格相等而不是近似：末根不应参与任何乘法，连浮点尾差都不该有
  assert.equal(lastAdjusted.date, lastRaw.date);
  assert.equal(lastAdjusted.open, 10.3);
  assert.equal(lastAdjusted.high, 10.4);
  assert.equal(lastAdjusted.low, 10.1);
  assert.equal(lastAdjusted.close, 10.2);
  assert.equal(lastAdjusted.volume, 1500);
});

test('末根不变：在多事件、大比例送转、长序列下依然成立', () => {
  // 造 60 根缓慢上涨的 K 线，中间安排两次除权，检查末根严格不变
  const bars = [];
  for (let i = 0; i < 60; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    bars.push({
      date: `2024-03-${day}`,
      open: 10 + i * 0.1,
      high: 10.5 + i * 0.1,
      low: 9.5 + i * 0.1,
      close: 10 + i * 0.1,
      volume: 1000 + i,
    });
  }
  const events = [
    { exDate: '2024-03-05', song: 10, zhuan: 0, pai: 3 },
    { exDate: '2024-03-40', song: 0, zhuan: 0, pai: 0 }, // 非法日期，应被忽略
    { exDate: '2024-03-20', song: 0, zhuan: 5, pai: 2 },
  ];

  const result = adjustBars(bars, events);
  const raw = bars[bars.length - 1];
  const adj = result.bars[result.bars.length - 1];

  assert.equal(adj.date, raw.date);
  assert.equal(adj.open, raw.open);
  assert.equal(adj.high, raw.high);
  assert.equal(adj.low, raw.low);
  assert.equal(adj.close, raw.close);
  assert.equal(adj.volume, raw.volume);

  // 同时确认前面确实被缩放了（否则这条断言可能因为「什么都没发生」而假通过）
  assert.notEqual(result.bars[0].close, bars[0].close, '早段价格必须已被缩放');
  assert.equal(result.factors.length, 2, '2024-03-40 这类非法日期不应产生因子');
});

test('除权日恰好是最后一根 K 线日期时，末根仍不变而之前的全部被缩放', () => {
  const bars = makeBars([
    flat('2024-06-17', 20),
    flat('2024-06-18', 20),
    flat('2024-06-19', 10.2),
  ]);
  const result = adjustBars(bars, [{ exDate: '2024-06-19', song: 10, zhuan: 0, pai: 0 }]);

  assert.equal(result.factors.length, 1);
  assert.equal(result.factors[0].factor, 0.5);
  assert.deepEqual(closes(result), [
    ['2024-06-17', 10],
    ['2024-06-18', 10],
    ['2024-06-19', 10.2],
  ]);
});

/* ════════════════════════════════════════════════════════════════
 * 六、除权日不在 K 线区间内
 * ════════════════════════════════════════════════════════════════ */

test('除权日早于 K 线起点：无任何 K 线可缩放，返回原值且 adjusted 为 false', () => {
  const bars = makeBars([flat('2024-01-02', 10), flat('2024-01-03', 10.5), flat('2024-01-04', 11)]);
  const result = adjustBars(bars, [{ exDate: '2023-06-20', song: 10, zhuan: 0, pai: 5 }]);

  // 除权日之前没有 K 线 → 前收无从谈起 → 不产生因子
  assert.deepEqual(buildFactors(bars, [{ exDate: '2023-06-20', song: 10, pai: 5 }]), []);
  assert.deepEqual(closes(result), [
    ['2024-01-02', 10],
    ['2024-01-03', 10.5],
    ['2024-01-04', 11],
  ]);
  assert.equal(result.adjusted, false);
  assert.equal(result.events, 0);
  assert.deepEqual(result.factors, []);
  assert.equal(result.warning, null);
});

test('除权日晚于 K 线终点：完全不影响价格，adjusted 为 false', () => {
  const bars = makeBars([
    { date: '2024-01-02', open: 10, high: 11, low: 9, close: 10.5, volume: 1000 },
    { date: '2024-01-03', open: 11, high: 12, low: 10, close: 11.5, volume: 1001 },
    { date: '2024-01-04', open: 12, high: 13, low: 11, close: 12.5, volume: 1002 },
  ]);
  const result = adjustBars(bars, [{ exDate: '2024-06-20', song: 0, zhuan: 0, pai: 5 }]);

  // 除权日之后一根 K 线都没有，事件在区间之外，对本区间价格没有任何影响。
  // 修复前这里会返回 closes = [10.08, 11.04, 12]，末根被错误缩放（BUG-1）。
  assert.deepEqual(closes(result), [
    ['2024-01-02', 10.5],
    ['2024-01-03', 11.5],
    ['2024-01-04', 12.5],
  ]);
  assert.equal(result.adjusted, false, '没有任何一根 K 线在除权日之前可被缩放');
  assert.deepEqual(result.factors, []);
  assert.equal(result.events, 0);
  assert.equal(result.warning, null, '事件在区间之外属于正常情况，不应降级告警');
});

test('除权日晚于终点且是多事件混合时，区间外的事件被跳过、区间内的事件照常生效', () => {
  // 只有 2024-01-03 这个除权日在区间内（前收 10.5），其余全在区间外
  const bars = makeBars([
    { date: '2024-01-02', open: 10, high: 11, low: 9, close: 10.5, volume: 1000 },
    { date: '2024-01-03', open: 10.6, high: 11, low: 10.4, close: 10.8, volume: 1100 },
    { date: '2024-01-04', open: 12, high: 13, low: 11, close: 12.5, volume: 1200 },
  ]);
  const result = adjustBars(bars, [
    { exDate: '2024-06-20', song: 0, zhuan: 0, pai: 5 }, // 区间外，跳过
    { exDate: '2024-12-31', song: 10, zhuan: 0, pai: 0 }, // 区间外，跳过
    { exDate: '2024-01-03', song: 0, zhuan: 0, pai: 2 }, // 区间内：div 0.2，前收 10.5
  ]);

  // theo = (10.5 - 0.2) / 1 = 10.3，f = 10.3 / 10.5 ≈ 0.98095238
  assert.equal(result.factors.length, 1, '区间外的事件不能产生因子');
  assert.equal(result.factors[0].date, '2024-01-03');
  near(result.factors[0].factor, 10.3 / 10.5, 1e-12);
  assert.equal(result.adjusted, true);
  // 只缩放 01-02，末根 12.5 严格不变
  near(result.bars[0].close, 10.3, 1e-9);
  assert.equal(result.bars[2].close, 12.5);
});

test('除权日正好等于末根日期：仍然正常复权（守卫不能误伤 idx = length-2 的边界）', () => {
  // 前收 20，每 10 股派 10 元 → div = 1，theo = 19，f = 0.95
  const bars = makeBars([
    { date: '2024-01-02', open: 20, high: 21, low: 19, close: 20, volume: 1000 },
    { date: '2024-06-20', open: 10.2, high: 10.5, low: 10, close: 10.1, volume: 2000 },
  ]);
  const result = adjustBars(bars, [{ exDate: '2024-06-20', song: 0, zhuan: 0, pai: 10 }]);

  assert.equal(result.adjusted, true, '末根当天除权是有效事件，必须复权');
  assert.equal(result.factors.length, 1);
  near(result.factors[0].factor, 0.95, 1e-12);
  assert.equal(result.factors[0].prevClose, 20);
  near(result.factors[0].theo, 19, 1e-12);

  assert.equal(result.bars[0].close, 19, '首根 20 * 0.95 = 19');
  assert.equal(result.bars[0].open, 19);
  assert.equal(result.bars[0].high, 19.95);
  assert.equal(result.bars[0].low, 18.05);
  assert.equal(result.bars[1].close, 10.1, '末根严格不变');
  assert.equal(result.bars[1].volume, 2000);
  assert.equal(result.warning, null);
});

/* ════════════════════════════════════════════════════════════════
 * 七、空数据 / 非法入参 → 结构完整
 * ════════════════════════════════════════════════════════════════ */

test('空 bars 不抛异常，返回结构完整的空结果', () => {
  const result = adjustBars([], MANUAL_EVENTS);

  assert.deepEqual(result.bars, []);
  assert.deepEqual(result.factors, []);
  assert.equal(result.adjusted, false);
  assert.equal(result.events, 0);
  assert.equal(result.warning, null);
});

test('空 events 不抛异常，价格原样返回', () => {
  const result = adjustBars(MANUAL_BARS, []);

  assert.equal(result.bars.length, MANUAL_BARS.length);
  assert.equal(result.adjusted, false);
  assert.deepEqual(result.factors, []);
});

test('bars / events 为 null 或非数组时不抛异常', () => {
  for (const [bars, events] of [
    [null, null],
    [undefined, undefined],
    [null, MANUAL_EVENTS],
    [MANUAL_BARS, null],
    ['not-an-array', 42],
  ]) {
    const result = adjustBars(bars, events);
    assert.ok(Array.isArray(result.bars), 'bars 必须是数组');
    assert.ok(Array.isArray(result.factors), 'factors 必须是数组');
    assert.equal(typeof result.adjusted, 'boolean');
    assert.equal(typeof result.events, 'number');
    assert.equal(result.warning, null);
  }
});

test('单根 K 线、无事件时原样返回而不抛异常', () => {
  const result = adjustBars([flat('2024-06-20', 10.2)], []);
  assert.deepEqual(closes(result), [['2024-06-20', 10.2]]);
  assert.equal(result.adjusted, false);
});

/* ════════════════════════════════════════════════════════════════
 * 八、成交量不调整（刻意设计）
 * ════════════════════════════════════════════════════════════════ */

test('成交量保持原始值，不随价格因子缩放', () => {
  const volumeFactors = [0.5, 0.47560975609756095, 0.953125, 0.95];
  const result = adjustBars(MANUAL_BARS, MANUAL_EVENTS);

  // 主案例因子约 0.476，若成交量也被缩放，2000 会变成约 952
  const rawVolumes = MANUAL_BARS.map((b) => b.volume);
  assert.deepEqual(
    result.bars.map((b) => b.volume),
    rawVolumes,
    '成交量必须原样保留（前复权只调价，不调量）',
  );

  // 逐一核对，防止实现以后改成「按因子缩放成交量」却不被发现
  assert.equal(result.bars[0].volume, 1000);
  assert.equal(result.bars[1].volume, 900);
  assert.equal(result.bars[2].volume, 2000);
  assert.equal(result.bars[3].volume, 1500);
  for (const f of volumeFactors) {
    assert.notEqual(result.bars[0].volume, Math.round(1000 * f), '成交量不应被任何因子缩放');
  }
});

test('成交量不调整：10 送 10 后量能指标不会出现虚假翻倍', () => {
  const bars = makeBars([
    { date: '2024-05-30', open: 20, high: 20, low: 20, close: 20, volume: 1000 },
    { date: '2024-06-03', open: 10, high: 10, low: 10, close: 10.1, volume: 2000 },
    { date: '2024-06-04', open: 10.1, high: 10.1, low: 10.1, close: 10.2, volume: 1500 },
  ]);
  const result = adjustBars(bars, [{ exDate: '2024-06-03', song: 10, zhuan: 0, pai: 0 }]);

  // 价格减半没错，但成交量 1000 若被乘 0.5 会变成 500，与真实的 2000 形成
  // 4 倍假跳变，量比/量能因子会彻底失真。
  assert.equal(result.bars[0].close, 10);
  assert.equal(result.bars[0].volume, 1000);
  assert.equal(result.bars[1].volume, 2000);
});

/* ════════════════════════════════════════════════════════════════
 * 九、纯函数性
 * ════════════════════════════════════════════════════════════════ */

test('复权不修改调用方传入的 K 线与事件对象', () => {
  const bars = snapshot(MANUAL_BARS);
  const events = snapshot(MANUAL_EVENTS);
  const barsCopy = snapshot(bars);
  const eventsCopy = snapshot(events);

  adjustBars(bars, events);

  assert.deepEqual(bars, barsCopy, 'K 线入参不能被修改');
  assert.deepEqual(events, eventsCopy, '事件入参不能被修改');
});

test('相同输入多次调用结果完全一致（无隐藏状态）', () => {
  const first = adjustBars(MANUAL_BARS, MANUAL_EVENTS);
  const second = adjustBars(MANUAL_BARS, MANUAL_EVENTS);
  const third = adjustBars(MANUAL_BARS, MANUAL_EVENTS);

  assert.deepEqual(first.bars, second.bars);
  assert.deepEqual(second.bars, third.bars);
  assert.deepEqual(first.factors, third.factors);
  // 但每次返回的数组仍是独立对象
  assert.notEqual(first.bars, second.bars);
});

/* ════════════════════════════════════════════════════════════════
 * 十、非法事件被忽略
 * ════════════════════════════════════════════════════════════════ */

test('exDate 为 null、全 0、日期格式错误的事件被忽略，不影响价格', () => {
  const bars = makeBars([flat('2024-06-17', 20), flat('2024-06-18', 20), flat('2024-06-19', 10.2)]);
  const badEvents = [
    { exDate: null, song: 10, zhuan: 0, pai: 0 }, // 无除权日
    { exDate: '2024-06-19', song: 0, zhuan: 0, pai: 0 }, // 全 0，无价格影响
    { exDate: '2024/06/19', song: 10, zhuan: 0, pai: 0 }, // 日期格式不对
    { exDate: '20240619', song: 10, zhuan: 0, pai: 0 }, // 缺少分隔符
    { song: 10, zhuan: 0, pai: 0 }, // 缺 exDate 字段
    { exDate: '', pai: 5 }, // 空字符串
  ];

  const result = adjustBars(bars, badEvents);

  assert.deepEqual(buildFactors(bars, badEvents), []);
  assert.deepEqual(closes(result), [
    ['2024-06-17', 20],
    ['2024-06-18', 20],
    ['2024-06-19', 10.2],
  ]);
  assert.equal(result.adjusted, false);
  assert.deepEqual(result.factors, []);
});

test('非对象事件被忽略，不抛异常', () => {
  const bars = makeBars([flat('2024-06-17', 20), flat('2024-06-19', 10.2)]);
  const result = adjustBars(bars, [null, undefined, 42, 'x', true, []]);

  assert.deepEqual(result.factors, []);
  assert.equal(result.adjusted, false);
});

test('分红超过股价导致 theo <= 0 时跳过该事件，保留原值而不是产出负价格', () => {
  // 前收 5 元，每 10 股派 60 元 → div = 6，theo = -1，因子无意义
  const bars = makeBars([flat('2024-06-17', 5), flat('2024-06-18', 4.9), flat('2024-06-19', 4.8)]);
  const result = adjustBars(bars, [{ exDate: '2024-06-18', pai: 60 }]);

  assert.deepEqual(buildFactors(bars, [{ exDate: '2024-06-18', pai: 60 }]), []);
  assert.deepEqual(closes(result), [
    ['2024-06-17', 5],
    ['2024-06-18', 4.9],
    ['2024-06-19', 4.8],
  ]);
  assert.equal(result.adjusted, false);
});

test('除权日前一根收盘价非法（null / 0 / 负数）时跳过，不产生 NaN 或 Infinity', () => {
  const cases = [
    { date: '2024-06-17', open: 20, high: 20, low: 20, close: null, volume: 1000 },
    { date: '2024-06-17', open: 20, high: 20, low: 20, close: 0, volume: 1000 },
    { date: '2024-06-17', open: 20, high: 20, low: 20, close: -3, volume: 1000 },
  ];

  for (const prev of cases) {
    const bars = [prev, flat('2024-06-19', 10.2)];
    const result = adjustBars(bars, [{ exDate: '2024-06-19', song: 10, pai: 0 }]);
    assert.deepEqual(result.factors, [], `前收为 ${prev.close} 时不应产生因子`);
    assert.equal(result.bars[0].close, prev.close, '非法前收保持原值');
    for (const bar of result.bars) {
      for (const key of ['open', 'high', 'low', 'close']) {
        if (bar[key] === null) continue;
        assert.ok(Number.isFinite(bar[key]), `${key} 不能是 NaN/Infinity`);
      }
    }
  }
});

/* ════════════════════════════════════════════════════════════════
 * 十一、同日多事件合并 / 字段兼容
 * ════════════════════════════════════════════════════════════════ */

test('同一天的多条事件合并成一个因子（送转与派息分两行公告的情况）', () => {
  // 前收 20；10 送 10 与每 10 股派 10 元合并 → add = 1，div = 1
  // theo = (20 - 1) / 2 = 9.5，f = 0.475
  const bars = makeBars([
    flat('2024-06-17', 20),
    flat('2024-06-18', 20),
    flat('2024-06-19', 9.6),
    flat('2024-06-20', 9.4),
  ]);
  const result = adjustBars(bars, [
    { exDate: '2024-06-19', song: 10, zhuan: 0, pai: 0 },
    { exDate: '2024-06-19', song: 0, zhuan: 0, pai: 10 },
  ]);

  assert.equal(result.factors.length, 1, '同一天只应产出一个因子');
  near(result.factors[0].theo, 9.5, 1e-12);
  near(result.factors[0].factor, 0.475, 1e-12);
  assert.equal(result.factors[0].event.song, 10, '合并后的 event 应累计送股');
  assert.equal(result.factors[0].event.pai, 10, '合并后的 event 应累计派息');

  assert.equal(result.bars[0].close, 9.5);
  assert.equal(result.bars[1].close, 9.5, '前收 20 * 0.475 = 9.5');
  assert.equal(result.bars[3].close, 9.4, '末根不变');
});

test('兼容 ex/ann 简写字段与字符串形式的数字', () => {
  const bars = makeBars([flat('2024-06-17', 20), flat('2024-06-19', 10.2), flat('2024-06-20', 10.3)]);
  const result = adjustBars(bars, [{ ex: '2024-06-19', ann: '2024-05-20', song: '10', zhuan: '0', pai: '0' }]);

  assert.equal(result.factors.length, 1);
  assert.equal(result.factors[0].date, '2024-06-19');
  assert.equal(result.factors[0].factor, 0.5);
  assert.equal(result.factors[0].event.annDate, '2024-05-20', 'annDate 应被识别并保留');
  assert.equal(result.bars[0].close, 10);
});

test('字符串价格的 K 线（新浪接口原样返回）被转成数字后再复权', () => {
  const bars = [{
    date: '2024-06-17', open: '20.00', high: '20.50', low: '19.80', close: '20.00',
    volume: '1000', amount: '1234567',
  }, {
    date: '2024-06-19', open: '10.00', high: '10.30', low: '09.90', close: '10.10',
    volume: '2000', amount: '987654',
  }];
  const result = adjustBars(bars, [{ exDate: '2024-06-19', song: 10, zhuan: 0, pai: 0 }]);

  assert.equal(result.bars[0].open, 10);
  assert.equal(result.bars[0].high, 10.25);
  assert.equal(result.bars[0].low, 9.9);
  assert.equal(result.bars[0].close, 10);
  assert.equal(result.bars[0].volume, 1000, '成交量字符串也要转数字');
  assert.equal(result.bars[0].amount, '1234567', '其它字段原样透传，便于下游使用');
});

/* ════════════════════════════════════════════════════════════════
 * 十二、precision 选项与 verifyAnchor
 * ════════════════════════════════════════════════════════════════ */

test('precision 选项控制价格保留的小数位数，默认 4 位', () => {
  // 前收 10.333333，每 10 股派 3.7 元（div 0.37）
  // theo = 9.963333，f = 9.963333 / 10.333333 = 0.96419...
  const bars = [flat('2024-01-02', 10.333333), flat('2024-06-19', 9.9), flat('2024-06-20', 9.8)];
  const events = [{ exDate: '2024-06-19', pai: 3.7 }];

  const byDefault = adjustBars(bars, events);
  const byZero = adjustBars(bars, events, { precision: 0 });
  const bySix = adjustBars(bars, events, { precision: 6 });

  // 默认 4 位
  assert.equal(byDefault.bars[0].close, 9.9633);
  // 0 位：四舍五入到整数
  assert.equal(byZero.bars[0].close, 10);
  // 6 位：更多小数
  assert.equal(bySix.bars[0].close, 9.963333);
  for (const value of [byDefault.bars[0].close, byZero.bars[0].close, bySix.bars[0].close]) {
    assert.ok(Number.isFinite(value));
  }
});

test('verifyAnchor 能识别末根被改动，逐字段核对时不误报', () => {
  const raw = makeBars([flat('2024-06-17', 20), flat('2024-06-18', 20), flat('2024-06-19', 10.2)]);
  const same = raw.map((b) => ({ ...b }));

  assert.deepEqual(verifyAnchor(raw, same), { ok: true, message: null });

  const broken = raw.map((b) => ({ ...b }));
  broken[broken.length - 1].close = 10.3;
  const verdict = verifyAnchor(raw, broken);
  assert.equal(verdict.ok, false, '末根被改动必须被识别');
  assert.match(verdict.message, /锚点校验失败/);
  assert.match(verdict.message, /10\.2/);
  assert.match(verdict.message, /10\.3/);

  // 长度不一致 / 非数组时应放行（属于调用方问题，不在这里报错）
  assert.equal(verifyAnchor(raw, raw.slice(0, 1)).ok, true);
  assert.equal(verifyAnchor(null, raw).ok, true);
});

test('锚点回退契约：极端分红/送转下末根恒不变，不会产出 NaN，也不会只告警不回退', () => {
  // BUG-2 修复后的回退分支在当前实现下不可达（理由见文件头）：缩放循环只有
  // 在「全部 K 线日期 < exDate」时才会碰到末根，而这种输入恰好让 buildFactors
  // 的 idx 落在末根、被 BUG-1 的守卫拦掉。所以这里不再尝试构造 warning（造不
  // 出来），而是从外部锁住两条**可观测的不变量**：
  //   (1) 末根 close 严格不变 —— 锚点被破坏时这里第一个报警；
  //   (2) 一旦出现 warning，返回的 bars 必须是**真的不复权数据**且
  //       adjusted === false —— BUG-2 的本质就是这两者不一致。
  // 将来任何人改动缩放边界，只要破坏其中一条，本用例立刻失败。
  const bars = makeBars([
    { date: '2024-01-02', open: 20, high: 21, low: 19, close: 20, volume: 1000 },
    { date: '2024-02-01', open: 20, high: 20.5, low: 19.5, close: 20.2, volume: 900 },
    { date: '2024-06-20', open: 10.2, high: 10.5, low: 10, close: 10.1, volume: 2000 },
  ]);

  // 覆盖 theo 逼近 0（派息≈前收）、远超前收（theo <= 0 应被跳过）、
  // 超大送转（因子趋近 0）、以及三者组合
  const extremeEvents = [
    [{ exDate: '2024-06-20', song: 0, zhuan: 0, pai: 199 }],
    [{ exDate: '2024-06-20', song: 0, zhuan: 0, pai: 199.9 }],
    [{ exDate: '2024-06-20', song: 0, zhuan: 0, pai: 200 }],
    [{ exDate: '2024-06-20', song: 0, zhuan: 0, pai: 5000 }],
    [{ exDate: '2024-06-20', song: 990, zhuan: 0, pai: 0 }],
    [{ exDate: '2024-06-20', song: 10, zhuan: 10, pai: 199 }],
    [{ exDate: '2024-02-01', song: 0, zhuan: 0, pai: 19.9 }],
    [{ exDate: '2024-02-01', song: 1000, zhuan: 1000, pai: 0 }],
    [{ exDate: '2024-06-20', song: 5, zhuan: 5, pai: 50 }],
  ];

  const rawLastClose = bars[bars.length - 1].close;

  for (const events of extremeEvents) {
    const label = JSON.stringify(events[0]);
    const result = adjustBars(bars, events);

    // 不变量 1：末根严格不变
    assert.equal(result.bars[result.bars.length - 1].close, rawLastClose, `${label} 末根被改动了`);

    // 所有价格要么是 null（原值就非法），要么是有限数字
    for (const bar of result.bars) {
      for (const key of ['open', 'high', 'low', 'close', 'volume']) {
        if (bar[key] === null) continue;
        assert.ok(Number.isFinite(bar[key]), `${label} 的 ${key} 出现了 NaN/Infinity：${bar[key]}`);
        assert.ok(bar[key] >= 0, `${label} 的 ${key} 出现了负数：${bar[key]}`);
      }
    }

    // 不变量 2：warning 与数据必须一致（BUG-2 的本质）
    if (result.warning !== null) {
      assert.match(result.warning, /已退回不复权数据/, `${label} 的 warning 缺少回退说明`);
      assert.equal(result.adjusted, false, `${label} 回退时 adjusted 必须是 false`);
      assert.deepEqual(result.factors, [], `${label} 回退时不应报告生效的因子`);
      assert.deepEqual(
        result.bars.map((b) => b.close),
        bars.map((b) => b.close),
        `${label} 既然声明已退回不复权数据，返回的 bars 就必须等于原值`,
      );
    }
  }

  // 反向确认这组输入确实覆盖到了「真的发生过复权」的分支，而不是全部被跳过，
  // 否则上面的不变量可能因为「什么都没做」而假通过。
  const didAdjust = extremeEvents.some((events) => adjustBars(bars, events).adjusted === true);
  assert.equal(didAdjust, true, '极端用例里应当至少有一组真的执行了复权');
});

test('warning 只会由锚点校验失败产生，正常区间内除权必须 warning 为 null', () => {
  // 防止修复时把 warning 当成万能兜底，掩盖正常情况下的问题
  const cases = [
    { bars: MANUAL_BARS, events: MANUAL_EVENTS },
    {
      bars: makeBars([flat('2024-06-17', 20), flat('2024-06-18', 20), flat('2024-06-19', 10.2)]),
      events: [{ exDate: '2024-06-19', song: 10, zhuan: 0, pai: 0 }],
    },
    {
      bars: makeBars([flat('2023-01-03', 40), flat('2023-06-20', 20), flat('2024-06-21', 19.2)]),
      events: [
        { exDate: '2023-06-20', song: 10, zhuan: 0, pai: 0 },
        { exDate: '2024-06-20', song: 0, zhuan: 0, pai: 10 },
      ],
    },
  ];
  for (const { bars, events } of cases) {
    const result = adjustBars(bars, events);
    assert.equal(result.warning, null, '正常复权不应产生任何告警');
    assert.equal(result.adjusted, true);
  }
});

/* ════════════════════════════════════════════════════════════════
 * 十三、buildFactors 契约
 * ════════════════════════════════════════════════════════════════ */

test('buildFactors 返回结构完整，字段类型正确', () => {
  const factors = buildFactors(MANUAL_BARS, MANUAL_EVENTS);

  assert.equal(factors.length, 1);
  const [f] = factors;
  assert.deepEqual(Object.keys(f).sort(), ['date', 'event', 'factor', 'prevClose', 'theo']);
  assert.equal(typeof f.date, 'string');
  assert.match(f.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof f.factor, 'number');
  assert.equal(typeof f.theo, 'number');
  assert.equal(typeof f.prevClose, 'number');
  assert.equal(typeof f.event, 'object');
  near(f.theo, 9.75, 1e-12);
  near(f.factor, 9.75 / 20.5, 1e-12);
  assert.equal(f.prevClose, 20.5);

  // 因子是对「除权日之前」的缩放比例，必然落在 (0, 1] 区间
  assert.ok(f.factor > 0 && f.factor <= 1, '除权只会让历史价格下移，因子应在 (0,1]');
});

test('buildFactors 在无 bars / 无 events 时返回空数组', () => {
  assert.deepEqual(buildFactors([], MANUAL_EVENTS), []);
  assert.deepEqual(buildFactors(MANUAL_BARS, []), []);
  assert.deepEqual(buildFactors(null, null), []);
});

test('buildFactors 的 prevClose 取的是除权日前最后一个交易日，而不是除权日当天', () => {
  // 除权日 2024-06-19 缺一根（例如停牌），前收应是 06-18 的收盘价
  const bars = makeBars([
    flat('2024-06-14', 30),
    flat('2024-06-17', 30),
    flat('2024-06-18', 30),
    flat('2024-06-20', 15),
    flat('2024-06-21', 15.2),
  ]);
  const factors = buildFactors(bars, [{ exDate: '2024-06-19', song: 10, zhuan: 0, pai: 0 }]);

  assert.equal(factors.length, 1);
  assert.equal(factors[0].prevClose, 30, '除权日缺 K 线时取更早的最后一根');
  assert.equal(factors[0].factor, 0.5);
});

/* ════════════════════════════════════════════════════════════════
 * 十四、不变量遍历（把 BUG-1 这类边界一次性锁死）
 * ════════════════════════════════════════════════════════════════ */

/** 极简确定性随机数，避免测试结果每次不同。 */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

test('不变量遍历：任意日期组合与事件组合下，末根 close 严格不变且无 NaN', () => {
  const rand = makeRandom(20240620);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  // 刻意混入乱序、重复、非字符串、空串日期 —— 真实数据里都可能出现
  const DATES = [
    '2024-01-02', '2024-01-03', '2024-02-01', '2024-05-31',
    '2024-06-19', '2024-06-20', '2024-12-31', 'zzz', '', '2024-1-2',
  ];
  const PRICES = [10, 20, 0.5, 0, -1, null, '12.5', undefined];
  const EVENT_POOL = [
    { exDate: '2024-06-20', song: 10, zhuan: 0, pai: 0 },
    { exDate: '2024-06-19', song: 0, zhuan: 0, pai: 200 },
    { exDate: '2024-01-05', song: 0, zhuan: 0, pai: 10 },
    { exDate: '2024-12-31', song: 0, zhuan: 5, pai: 3 },
    { exDate: '2024-02-01', song: 10, zhuan: 10, pai: 100 },
    { exDate: null, pai: 5 },
    { ex: '2024-06-20', pai: 50 },
  ];

  let adjustedCount = 0;
  let unchangedCount = 0;

  for (let iter = 0; iter < 400; iter += 1) {
    const n = 1 + Math.floor(rand() * 6);
    const bars = [];
    for (let i = 0; i < n; i += 1) {
      bars.push({
        date: pick(DATES),
        open: pick(PRICES),
        high: pick(PRICES),
        low: pick(PRICES),
        close: pick(PRICES),
        volume: pick(PRICES),
      });
    }
    const events = [];
    const m = Math.floor(rand() * 4);
    for (let i = 0; i < m; i += 1) events.push(pick(EVENT_POOL));

    const label = `第 ${iter} 轮 ${JSON.stringify(bars)} / ${JSON.stringify(events)}`;

    // 绝不抛异常
    let result;
    assert.doesNotThrow(() => { result = adjustBars(bars, events); }, label);

    // 返回结构恒完整
    assert.equal(result.bars.length, bars.length, label);
    assert.ok(Array.isArray(result.factors), label);
    assert.equal(typeof result.adjusted, 'boolean', label);
    assert.equal(typeof result.events, 'number', label);

    // 所有数值字段要么保持 null，要么是有限数字
    for (const bar of result.bars) {
      for (const key of ['open', 'high', 'low', 'close', 'volume']) {
        if (bar[key] === null) continue;
        assert.ok(Number.isFinite(bar[key]), `${label} 的 ${key} 不是有限数字：${bar[key]}`);
      }
    }

    // 核心不变量：末根的 close 与 volume 严格不变（前复权锚点）
    const last = bars.length - 1;
    const rawClose = bars[last].close;
    const adjClose = result.bars[last].close;
    if (typeof rawClose === 'number' && Number.isFinite(rawClose)) {
      assert.equal(adjClose, rawClose, `${label} 末根 close 被改动了`);
    } else if (rawClose === null) {
      assert.equal(adjClose, null, `${label} 末根 close 原为 null，不应变成数字`);
    }

    if (result.adjusted) adjustedCount += 1;
    else unchangedCount += 1;
  }

  // 确认随机样本没有退化成「全部不生效」，否则上面的不变量是空转
  assert.ok(adjustedCount > 20, `应有一批样本真的发生了复权，实际 ${adjustedCount}`);
  assert.ok(unchangedCount > 20, `应有一批样本不发生复权，实际 ${unchangedCount}`);
});

test('多次除权：复权后相邻价格不出现 2 倍级假跳空，且最早段乘满全部因子', () => {
  // 事件 1：2023-06-20，前收 40，10 送 10 → f1 = 0.5
  // 事件 2：2024-06-20，前收 22（注意是 2024-06-19 的 22，不是 20），派 10 元
  //         div = 1，theo = 21，f2 = 21/22 ≈ 0.95454545
  const bars = makeBars([
    flat('2023-01-03', 40),
    flat('2023-06-19', 40),
    flat('2023-06-20', 20),
    flat('2023-12-29', 21),
    flat('2024-06-19', 22),
    flat('2024-06-21', 22.5),
  ]);
  const events = [
    { exDate: '2023-06-20', song: 10, zhuan: 0, pai: 0 },
    { exDate: '2024-06-20', song: 0, zhuan: 0, pai: 10 },
  ];
  const result = adjustBars(bars, events);

  // 复权后相邻可比值（同一价格体系下）大致连续，不应出现 2 倍级跳空
  for (let i = 1; i < result.bars.length; i += 1) {
    const prev = result.bars[i - 1].close;
    const cur = result.bars[i].close;
    const ratio = cur / prev;
    assert.ok(
      ratio > 0.5 && ratio < 2,
      `第 ${i} 根复权后出现异常跳空：${prev} → ${cur}（比值 ${ratio}）`,
    );
  }

  // 精确值（价格保留 4 位小数，故断言这些确定值）：
  //   2023-01-03/06-19/06-20：40 * 0.5 = 20，再 * 21/22 = 19.0909...
  //   2023-12-29：            21 * 21/22 = 20.0454545... → 20.0455
  //   2024-06-19：            22 * 21/22 = 21（除权日之前最后一根）
  //   2024-06-21：            不动
  assert.deepEqual(closes(result), [
    ['2023-01-03', 19.0909],
    ['2023-06-19', 19.0909],
    ['2023-06-20', 19.0909],
    ['2023-12-29', 20.0455],
    ['2024-06-19', 21],
    ['2024-06-21', 22.5],
  ]);

  // 累乘关系：最早段 / 原始价 ≈ f1 * f2（4 位舍入带来 ~1e-7 误差）
  near(result.bars[0].close / 40, 0.5 * (21 / 22), 1e-6, '最早段应乘满两个因子');
  near(result.bars[3].close / 21, 21 / 22, 1e-5, '中间段只乘后一个因子');
  assert.equal(result.bars[5].close, 22.5, '末根不变');
});
