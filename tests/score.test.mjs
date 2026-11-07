/**
 * dsh-astock / tests/score.test.mjs
 * lib/score.js 自测。全部使用合成 K 线，不联网、不读文件。
 *
 * 覆盖 CONTRACT.md 要求的 (a)-(g) 七种情况：
 *   (a) 单调上涨 → bull / strong-bull
 *   (b) 单调下跌 → bear / strong-bear
 *   (c) 横盘震荡 → neutral
 *   (d) 空数据 / 极少数据 → 不抛异常
 *   (e) 停牌 → 不抛异常
 *   (f) 权重和 = 1
 *   (g) 分数恒在 0-100
 * 另外补充：指标算法手工校验、Evaluation 结构完整性、纯函数性（不改输入）、
 *           evaluateMany 批量行为。
 *
 * 运行：cd dsh-astock && node --test tests/score.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeIndicators,
  evaluateStock,
  evaluateMany,
  WEIGHTS,
  DISCLAIMER,
} from '../lib/score.js';

/* ════════════════════════════════════════════════════════════════
 * 合成 K 线工厂
 * ════════════════════════════════════════════════════════════════ */

/**
 * 生成确定性的合成日 K。
 * @param {object} o
 * @param {number} o.n         根数
 * @param {number} o.start     起始价
 * @param {number} o.trendPct  每日复利涨跌幅 %
 * @param {number} o.waveAmp   正弦波振幅 %
 * @param {number} o.wavePeriod 正弦波周期（天）
 * @param {number} o.volume    基准成交量
 * @param {number} o.volPct    每日成交量复利增速 %
 * @param {number} o.lastVolume 指定最后一根成交量（用于停牌/放量场景）
 */
function makeBars(o = {}) {
  const {
    n = 260,
    start = 100,
    trendPct = 0,
    waveAmp = 0,
    wavePeriod = 20,
    volume = 100000,
    volPct = 0,
    lastVolume = null,
    endDate = '2024-01-01',
  } = o;
  const bars = [];
  let prevClose = start;
  // 从 endDate 往回推 n 天，保证末条 K 线的日期可控（stale 判定需要它）
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  for (let i = 0; i < n; i += 1) {
    const trend = Math.pow(1 + trendPct / 100, i);
    const wave = 1 + (waveAmp * Math.sin((2 * Math.PI * i) / wavePeriod)) / 100;
    const close = Number((start * trend * wave).toFixed(2));
    const open = Number(prevClose.toFixed(2));
    const high = Number((Math.max(open, close) * 1.004).toFixed(2));
    const low = Number((Math.min(open, close) * 0.996).toFixed(2));
    const vol = Math.round(volume * Math.pow(1 + volPct / 100, i));
    const d = new Date(endMs - (n - 1 - i) * 86400000);
    bars.push({
      date: d.toISOString().slice(0, 10),
      open,
      close,
      high,
      low,
      volume: i === n - 1 && lastVolume !== null ? lastVolume : vol,
    });
    prevClose = close;
  }
  return bars;
}

/** 构造一个完整的 quote 对象（结构照 CONTRACT 的 Quote）。 */
function makeQuote(overrides = {}) {
  return {
    code: '600519',
    secid: 'sh600519',
    market: 'sh',
    name: '贵州茅台',
    price: 1500,
    prevClose: 1480,
    open: 1485,
    high: 1510,
    low: 1478,
    change: 20,
    changePercent: 1.35,
    volume: 30000,
    amount: 4500000000,
    turnoverRate: 0.24,
    peTtm: 28.5,
    pb: 8.2,
    volumeRatio: 1.35,
    amplitude: 2.16,
    floatCap: 18800,
    totalCap: 18800,
    limitUp: 1628,
    limitDown: 1332,
    timestamp: '2026-11-07 15:00:00',
    isIndex: false,
    isSuspended: false,
    ...overrides,
  };
}

/* ════════════════════════════════════════════════════════════════
 * (f) 权重契约
 * ════════════════════════════════════════════════════════════════ */

test('(f) 六个因子权重之和严格等于 1', () => {
  const keys = ['trend', 'momentum', 'volume', 'position', 'volatility', 'risk'];
  assert.equal(Object.keys(WEIGHTS).length, 6, '必须恰好 6 个因子');

  let sum = 0;
  for (const k of keys) {
    assert.equal(typeof WEIGHTS[k], 'number', `权重 ${k} 必须是数字`);
    sum += WEIGHTS[k];
  }
  // 浮点求和会有末位误差，用极小容差
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重和应为 1，实际 ${sum}`);

  // 与 CONTRACT 声明的默认值逐项核对
  assert.equal(WEIGHTS.trend, 0.28);
  assert.equal(WEIGHTS.momentum, 0.22);
  assert.equal(WEIGHTS.volume, 0.18);
  assert.equal(WEIGHTS.position, 0.16);
  assert.equal(WEIGHTS.volatility, 0.1);
  assert.equal(WEIGHTS.risk, 0.06);
});

test('(f) Evaluation.factors 的权重和 = 1 且按权重降序排列', () => {
  const ev = evaluateStock({ quote: makeQuote(), bars: makeBars({ n: 260, trendPct: 0.4 }) });
  assert.equal(ev.factors.length, 6);

  let sum = 0;
  for (const f of ev.factors) sum += f.weight;
  assert.ok(Math.abs(sum - 1) < 1e-9, `factors 权重和应为 1，实际 ${sum}`);

  for (let i = 1; i < ev.factors.length; i += 1) {
    assert.ok(
      ev.factors[i - 1].weight >= ev.factors[i].weight,
      `factors 必须按权重降序：${ev.factors[i - 1].key}(${ev.factors[i - 1].weight}) < ${ev.factors[i].key}(${ev.factors[i].weight})`,
    );
  }

  // contribution 必须等于 score * weight（四舍五入到 2 位）
  for (const f of ev.factors) {
    assert.equal(f.contribution, Math.round(f.score * f.weight * 100) / 100 + 0, `${f.key} 的 contribution 不符`);
  }
});

/* ════════════════════════════════════════════════════════════════
 * (a) 单调上涨
 * ════════════════════════════════════════════════════════════════ */

test('(a) 单调上涨趋势给出高分，verdict 为 bull 或 strong-bull', () => {
  const bars = makeBars({ n: 260, start: 50, trendPct: 0.8 });
  const ev = evaluateStock({ quote: null, bars });

  assert.ok(ev.score >= 60, `单调上涨总分应 >= 60，实际 ${ev.score}`);
  assert.ok(
    ['bull', 'strong-bull'].includes(ev.verdict),
    `verdict 应为 bull/strong-bull，实际 ${ev.verdict}`,
  );
  assert.equal(ev.verdictLabel, ev.verdict === 'bull' ? '偏多' : '强烈看多');

  // 趋势与动量必须明显站在多头一侧
  const trend = ev.factors.find((f) => f.key === 'trend');
  const momentum = ev.factors.find((f) => f.key === 'momentum');
  assert.ok(trend.score >= 80, `单调上涨的趋势因子应 >= 80，实际 ${trend.score}`);
  assert.ok(momentum.score > 50, `单调上涨的动量因子应 > 50，实际 ${momentum.score}`);

  // 指标层面交叉验证
  const ind = computeIndicators(bars);
  assert.ok(ind.ma.ma5 > ind.ma.ma20, 'MA5 应大于 MA20');
  assert.ok(ind.ma.ma20 > ind.ma.ma60, 'MA20 应大于 MA60');
  assert.ok(ind.ma20SlopePercent > 0, 'MA20 斜率应为正');
  assert.equal(ind.consecutiveUp, 259, '应连续上涨 259 天');
});

test('(a) 极强单边上涨（+2%/日）应触发 strong-bull 且趋势因子满分', () => {
  const bars = makeBars({ n: 260, start: 10, trendPct: 2 });
  const ev = evaluateStock({ quote: null, bars });
  assert.equal(ev.verdict, 'strong-bull', `应给出 strong-bull，实际 ${ev.verdict} (score ${ev.score})`);
  const trend = ev.factors.find((f) => f.key === 'trend');
  assert.equal(trend.score, 100, '极强上涨的趋势因子应为 100 分');
});

/* ════════════════════════════════════════════════════════════════
 * (b) 单调下跌
 * ════════════════════════════════════════════════════════════════ */

test('(b) 单调下跌趋势给出低分，verdict 为 bear 或 strong-bear', () => {
  const bars = makeBars({ n: 260, start: 300, trendPct: -0.8 });
  const ev = evaluateStock({ quote: null, bars });

  assert.ok(ev.score <= 45, `单调下跌总分应 <= 45，实际 ${ev.score}`);
  assert.ok(
    ['bear', 'strong-bear'].includes(ev.verdict),
    `verdict 应为 bear/strong-bear，实际 ${ev.verdict}`,
  );
  assert.equal(ev.verdictLabel, ev.verdict === 'bear' ? '偏空' : '强烈看空');

  const trend = ev.factors.find((f) => f.key === 'trend');
  assert.ok(trend.score <= 20, `单调下跌的趋势因子应 <= 20，实际 ${trend.score}`);

  const ind = computeIndicators(bars);
  assert.ok(ind.ma.ma5 < ind.ma.ma20, 'MA5 应小于 MA20');
  assert.ok(ind.ma20SlopePercent < 0, 'MA20 斜率应为负');
  assert.equal(ind.consecutiveDown, 259, '应连续下跌 259 天');
  assert.equal(ind.aboveMa20Days, 0, '不应有任何一天站上 MA20');
});

test('(b) 上涨与下跌的分数必须显著分离（区分度）', () => {
  const up = evaluateStock({ quote: null, bars: makeBars({ n: 260, start: 50, trendPct: 0.8 }) });
  const down = evaluateStock({ quote: null, bars: makeBars({ n: 260, start: 300, trendPct: -0.8 }) });
  assert.ok(up.score - down.score >= 30, `多空分差应 >= 30，实际 ${up.score} vs ${down.score}`);
});

/* ════════════════════════════════════════════════════════════════
 * (c) 横盘震荡
 * ════════════════════════════════════════════════════════════════ */

test('(c) 横盘震荡给出 neutral，分数贴近 50', () => {
  const bars = makeBars({ n: 261, start: 100, waveAmp: 2, wavePeriod: 20 });
  const ev = evaluateStock({ quote: null, bars });

  assert.equal(ev.verdict, 'neutral', `横盘应给 neutral，实际 ${ev.verdict} (score ${ev.score})`);
  assert.equal(ev.verdictLabel, '中性');
  assert.ok(Math.abs(ev.score - 50) <= 12, `横盘总分应贴近 50，实际 ${ev.score}`);
  assert.ok(ev.upProbability > 0.35 && ev.upProbability < 0.65, `横盘概率应居中，实际 ${ev.upProbability}`);
});

test('(c) 多个相位的横盘都不应被判成单边', () => {
  // 取不同末相位（周期 20，末根相位 0..19），确保不是「碰巧落在中位」才给 neutral
  for (const extra of [0, 3, 6, 9, 12, 15, 18]) {
    const bars = makeBars({ n: 260 + extra, start: 100, waveAmp: 2, wavePeriod: 20 });
    const ev = evaluateStock({ quote: null, bars });
    assert.equal(
      ev.verdict,
      'neutral',
      `相位 +${extra} 的横盘被判成 ${ev.verdict}（score ${ev.score}），过于敏感`,
    );
  }
});

/* ════════════════════════════════════════════════════════════════
 * (d) 空数据 / 极少数据
 * ════════════════════════════════════════════════════════════════ */

test('(d) bars 为空不抛异常，返回结构完整的中性结果', () => {
  let ev;
  assert.doesNotThrow(() => {
    ev = evaluateStock({ quote: null, bars: [] });
  }, 'bars 为空时不应抛异常');

  assert.equal(ev.score, 50, `空数据应为中性 50 分，实际 ${ev.score}`);
  assert.equal(ev.verdict, 'neutral');
  assert.equal(ev.price, null);
  assert.equal(ev.changePercent, null);
  assert.deepEqual(ev.levels.support, []);
  assert.deepEqual(ev.levels.resistance, []);
  assert.equal(ev.dataQuality.bars, 0);
  assert.equal(ev.dataQuality.hasQuote, false);
  assert.ok(ev.dataQuality.warnings.length >= 1, '必须说明降级原因');
  assert.ok(
    ev.dataQuality.warnings.some((w) => w.includes('K 线数据为空')),
    `warnings 应包含空数据说明，实际 ${JSON.stringify(ev.dataQuality.warnings)}`,
  );
  assert.equal(ev.disclaimer, DISCLAIMER);
  // 空数据时六个因子仍必须齐全
  assert.equal(ev.factors.length, 6);
});

test('(d) input 为 null / undefined / 非对象都不抛异常', () => {
  for (const input of [null, undefined, 42, 'x', {}, { bars: null }, { bars: 'oops' }]) {
    let ev;
    assert.doesNotThrow(() => {
      ev = evaluateStock(input);
    }, `input=${JSON.stringify(input)} 时不应抛异常`);
    assert.equal(ev.score, 50);
    assert.equal(ev.factors.length, 6);
    assert.equal(typeof ev.summary, 'string');
    assert.ok(ev.summary.length > 0);
  }
});

test('(d) 极少数据（1/3/10/29 根）不抛异常并给出降级 warning', () => {
  for (const n of [1, 3, 10, 29]) {
    const bars = makeBars({ n, start: 20, trendPct: 0.5 });
    let ev;
    assert.doesNotThrow(() => {
      ev = evaluateStock({ quote: null, bars });
    }, `${n} 根 K 线时不应抛异常`);

    assert.equal(ev.factors.length, 6, `${n} 根时仍要输出 6 个因子`);
    assert.equal(ev.dataQuality.bars, n);
    assert.ok(ev.dataQuality.warnings.length >= 1, `${n} 根时必须有降级 warning`);
    // 分数仍须在合法区间
    assert.ok(ev.score >= 0 && ev.score <= 100);
    for (const f of ev.factors) {
      assert.ok(f.score >= 0 && f.score <= 100, `${n} 根时 ${f.key} 分数越界：${f.score}`);
      assert.ok(f.signals.length >= 2 && f.signals.length <= 5, `${n} 根时 ${f.key} 的 signals 必须 2-5 条`);
    }
  }
});

test('(d) 30 根以下必须出现「少于 30 根」的降级提示', () => {
  const ev = evaluateStock({ quote: null, bars: makeBars({ n: 20, start: 20 }) });
  assert.ok(
    ev.dataQuality.warnings.some((w) => w.includes('少于 30 根')),
    `warnings 应提示样本不足 30 根，实际 ${JSON.stringify(ev.dataQuality.warnings)}`,
  );
});

test('(d) 脏数据（含 null / NaN / 负价 / 缺字段的 bar）不抛异常', () => {
  const dirty = [
    { date: '2024-01-01', open: 10, close: 10.5, high: 11, low: 9.5, volume: 1000 },
    null,
    { date: '2024-01-03', open: 10, close: null, high: 11, low: 9, volume: 1000 },
    { date: '2024-01-04', open: 10, close: NaN, high: 11, low: 9, volume: 1000 },
    { date: '2024-01-05', open: 10, close: -5, high: 11, low: 9, volume: 1000 },
    { date: '2024-01-08', close: 10.8 },
    { date: '2024-01-09', open: 10.8, close: 11, high: 11.2, low: 10.7, volume: 0 },
  ];
  let ev;
  assert.doesNotThrow(() => {
    ev = evaluateStock({ quote: null, bars: dirty });
  }, '脏数据不应抛异常');
  assert.ok(ev.score >= 0 && ev.score <= 100);
  assert.ok(ev.dataQuality.bars < dirty.length, '无效 bar 应被剔除');
  assert.ok(
    ev.dataQuality.warnings.some((w) => w.includes('剔除')),
    `应提示剔除无效 K 线，实际 ${JSON.stringify(ev.dataQuality.warnings)}`,
  );
});

/* ════════════════════════════════════════════════════════════════
 * (e) 停牌
 * ════════════════════════════════════════════════════════════════ */

test('(e) 停牌（quote.isSuspended = true）不抛异常，量能因子回到中性', () => {
  const bars = makeBars({ n: 260, start: 100, trendPct: 0.2, lastVolume: 0 });
  const quote = makeQuote({ price: 100, changePercent: 0, volume: 0, isSuspended: true });

  let ev;
  assert.doesNotThrow(() => {
    ev = evaluateStock({ quote, bars });
  }, '停牌不应抛异常');

  const volume = ev.factors.find((f) => f.key === 'volume');
  assert.equal(volume.score, 50, `停牌时量能因子应为中性 50，实际 ${volume.score}`);
  assert.ok(
    volume.signals.some((s) => s.includes('停牌')),
    `量能 signals 应提到停牌，实际 ${JSON.stringify(volume.signals)}`,
  );
  assert.ok(
    ev.risks.some((r) => r.includes('停牌')),
    `risks 应包含停牌风险，实际 ${JSON.stringify(ev.risks)}`,
  );
});

test('(e) 停牌（price = 0）改用最后一根 K 线收盘价，不抛异常', () => {
  const bars = makeBars({ n: 120, start: 80, trendPct: 0.1 });
  const quote = makeQuote({ price: 0, changePercent: 0, volume: 0, isSuspended: true });

  let ev;
  assert.doesNotThrow(() => {
    ev = evaluateStock({ quote, bars });
  }, 'price=0 不应抛异常');

  assert.ok(ev.price > 0, `应回退到 K 线收盘价，实际 ${ev.price}`);
  assert.equal(ev.dataQuality.stale, true, 'stale 应标记为 true');
  assert.ok(
    ev.dataQuality.warnings.some((w) => w.includes('价格为 0')),
    `warnings 应说明价格 0，实际 ${JSON.stringify(ev.dataQuality.warnings)}`,
  );
});

test('(e) 全部 K 线成交量为 0（长期停牌）不抛异常并给出 warning', () => {
  const bars = makeBars({ n: 100, start: 50 }).map((b) => ({ ...b, volume: 0 }));
  let ev;
  assert.doesNotThrow(() => {
    ev = evaluateStock({ quote: null, bars });
  }, '全零成交量不应抛异常');
  assert.ok(
    ev.dataQuality.warnings.some((w) => w.includes('成交量为 0')),
    `warnings 应说明成交量异常，实际 ${JSON.stringify(ev.dataQuality.warnings)}`,
  );
  assert.ok(ev.score >= 0 && ev.score <= 100);
});

/* ════════════════════════════════════════════════════════════════
 * (g) 分数恒在 0-100
 * ════════════════════════════════════════════════════════════════ */

test('(g) 各种极端行情下，总分与因子分恒在 0-100，概率恒在 0-1', () => {
  const scenarios = [
    ['暴涨 +9%/日', makeBars({ n: 200, start: 5, trendPct: 9 })],
    ['暴跌 -9%/日', makeBars({ n: 200, start: 500, trendPct: -9 })],
    ['极高波动', makeBars({ n: 200, start: 100, waveAmp: 40, wavePeriod: 7 })],
    ['零波动', makeBars({ n: 200, start: 100, waveAmp: 0, trendPct: 0 })],
    ['天量成交', makeBars({ n: 200, start: 100, trendPct: 1, volPct: 10 })],
    ['地量成交', makeBars({ n: 200, start: 100, trendPct: 1, volume: 1 })],
    ['超高价股', makeBars({ n: 200, start: 3000, trendPct: 0.5 })],
    ['超低价股', makeBars({ n: 200, start: 0.35, trendPct: 0.5 })],
    ['先涨后跌', [...makeBars({ n: 130, start: 100, trendPct: 1 }), ...makeBars({ n: 130, start: 260, trendPct: -1 })]],
    ['仅 2 根', makeBars({ n: 2, start: 10 })],
    ['空', []],
  ];

  for (const [label, bars] of scenarios) {
    const ev = evaluateStock({ quote: null, bars });
    assert.ok(
      typeof ev.score === 'number' && Number.isFinite(ev.score) && ev.score >= 0 && ev.score <= 100,
      `${label}：总分越界 ${ev.score}`,
    );
    assert.ok(ev.upProbability >= 0 && ev.upProbability <= 1, `${label}：概率越界 ${ev.upProbability}`);
    for (const f of ev.factors) {
      assert.ok(
        Number.isFinite(f.score) && f.score >= 0 && f.score <= 100,
        `${label}：因子 ${f.key} 分数越界 ${f.score}`,
      );
      assert.ok(Number.isFinite(f.contribution), `${label}：因子 ${f.key} 的 contribution 非有限数`);
    }
  }
});

test('(g) 加权总分必须等于各因子 score*weight 之和', () => {
  const ev = evaluateStock({ quote: makeQuote(), bars: makeBars({ n: 260, trendPct: 0.3 }) });
  let manual = 0;
  for (const f of ev.factors) manual += f.score * f.weight;
  assert.ok(
    Math.abs(ev.score - manual) < 0.15,
    `总分 ${ev.score} 与手工加权和 ${manual} 不符（容差 0.15，含四舍五入）`,
  );
});

/* ════════════════════════════════════════════════════════════════
 * 指标算法正确性
 * ════════════════════════════════════════════════════════════════ */

test('指标：SMA 与手算一致', () => {
  const bars = makeBars({ n: 10, start: 100, trendPct: 1 });
  const ind = computeIndicators(bars);
  const closes = ind.closes;

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  assert.ok(Math.abs(ind.ma.ma5 - avg(closes.slice(-5))) < 1e-9, 'MA5 不符');
  assert.ok(Math.abs(ind.ma.ma10 - avg(closes.slice(-10))) < 1e-9, 'MA10 不符');
  // 10 根数据算不出 MA20 / MA60
  assert.equal(ind.ma.ma20, null, '10 根数据时 MA20 必须为 null');
  assert.equal(ind.ma.ma60, null, '10 根数据时 MA60 必须为 null');
});

test('指标：RSI14 在单边行情下饱和到 0 / 100，横盘约为 50', () => {
  const up = computeIndicators(makeBars({ n: 60, start: 10, trendPct: 1 }));
  assert.equal(up.rsi14, 100, '单调上涨的 RSI 应为 100');

  const down = computeIndicators(makeBars({ n: 60, start: 100, trendPct: -1 }));
  assert.equal(down.rsi14, 0, '单调下跌的 RSI 应为 0');

  // 严格对称的锯齿：涨跌幅度相等，RSI 应在 50 附近
  const zigzag = [];
  for (let i = 0; i < 60; i += 1) {
    const c = i % 2 === 0 ? 100 : 101;
    zigzag.push({ date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`, open: c, close: c, high: c, low: c, volume: 1000 });
  }
  const ind = computeIndicators(zigzag);
  assert.ok(Math.abs(ind.rsi14 - 50) < 5, `对称锯齿的 RSI 应接近 50，实际 ${ind.rsi14}`);
});

test('指标：RSI 需要 period+1 根（15 根）才可得，14 根时为 null', () => {
  // Wilder 平滑：前 period 根算初始均幅，第 period+1 根才产出第一个 RSI 值。
  // 实现（rsiWilder 中 `if (n < period + 1) return null`）与注释口径一致。
  assert.equal(computeIndicators(makeBars({ n: 13 })).rsi14, null);
  assert.equal(computeIndicators(makeBars({ n: 14 })).rsi14, null, '14 根不足 period+1，必须为 null');
  assert.ok(Number.isFinite(computeIndicators(makeBars({ n: 15 })).rsi14), '15 根起应可算出 RSI');
});

test('指标：MACD 结构与关系自洽（hist = dif - dea）', () => {
  const ind = computeIndicators(makeBars({ n: 260, trendPct: 0.5 }));
  assert.ok(Number.isFinite(ind.macd.dif), 'DIF 应为有限数');
  assert.ok(Number.isFinite(ind.macd.dea), 'DEA 应为有限数');
  assert.ok(Math.abs(ind.macd.hist - (ind.macd.dif - ind.macd.dea)) < 1e-12, 'hist 必须等于 dif - dea');
  assert.ok(ind.macd.dif > 0, '持续上涨时 DIF 应为正');
  assert.ok(Number.isFinite(ind.macdPrevHist), 'macdPrevHist 应为有限数');

  // 不足 26 根时 MACD 全部为 null
  const short = computeIndicators(makeBars({ n: 25 }));
  assert.equal(short.macd.dif, null);
  assert.equal(short.macd.dea, null);
  assert.equal(short.macd.hist, null);
});

test('指标：BOLL 中轨等于 20 日均值，上下轨对称', () => {
  const ind = computeIndicators(makeBars({ n: 60, trendPct: 0.3, waveAmp: 3 }));
  const closes = ind.closes;
  const mid = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  assert.ok(Math.abs(ind.boll.mid - mid) < 1e-9, 'BOLL 中轨应为 20 日均值');

  const halfWidth = ind.boll.upper - ind.boll.mid;
  assert.ok(Math.abs(halfWidth - (ind.boll.mid - ind.boll.lower)) < 1e-9, '上下轨应对称');
  assert.ok(ind.boll.upper > ind.boll.mid && ind.boll.mid > ind.boll.lower, '轨道顺序应正确');

  // %B = (close - lower) / (upper - lower)
  const last = closes[closes.length - 1];
  const expectB = (last - ind.boll.lower) / (ind.boll.upper - ind.boll.lower);
  assert.ok(Math.abs(ind.boll.percentB - expectB) < 1e-9, '%B 公式不符');
  assert.ok(ind.boll.bandwidth > 0, '带宽应为正');
});

test('指标：ATR14 为正且 atrPercent = atr14 / close * 100', () => {
  const ind = computeIndicators(makeBars({ n: 60, trendPct: 0.5 }));
  assert.ok(ind.atr14 > 0, `ATR14 应为正，实际 ${ind.atr14}`);
  const expect = (ind.atr14 / ind.closes[ind.closes.length - 1]) * 100;
  assert.ok(Math.abs(ind.atrPercent - expect) < 1e-9, 'atrPercent 换算不符');
});

test('指标：60/250 日高低点正确，样本不足时退化', () => {
  const bars = makeBars({ n: 300, start: 100, waveAmp: 15, wavePeriod: 50 });
  const ind = computeIndicators(bars);

  const last60 = bars.slice(-60);
  const h60 = Math.max(...last60.map((b) => b.high));
  const l60 = Math.min(...last60.map((b) => b.low));
  assert.equal(ind.high60, h60, 'high60 不符');
  assert.equal(ind.low60, l60, 'low60 不符');

  const h250 = Math.max(...bars.slice(-250).map((b) => b.high));
  assert.equal(ind.high250, h250, 'high250 不符');

  // 只有 40 根时，60 日高点退化为全样本区间
  const short = computeIndicators(bars.slice(-40));
  assert.equal(short.high60, Math.max(...bars.slice(-40).map((b) => b.high)));
});

test('指标：多周期收益率与连续涨跌天数正确', () => {
  const bars = makeBars({ n: 100, start: 100, trendPct: 1 });
  const ind = computeIndicators(bars);
  const closes = ind.closes;
  const n = closes.length;

  const expectD5 = (closes[n - 1] / closes[n - 6] - 1) * 100;
  assert.ok(Math.abs(ind.returns.d5 - expectD5) < 1e-9, 'd5 收益率不符');
  assert.ok(Math.abs(ind.returns.d1 - (closes[n - 1] / closes[n - 2] - 1) * 100) < 1e-9, 'd1 不符');
  assert.ok(ind.returns.d60 > 0, '持续上涨的 d60 应为正');
  assert.equal(ind.consecutiveUp, 99, '应连续上涨 99 天');
  assert.equal(ind.consecutiveDown, 0);

  // 只有 3 根时 d20 / d60 应为 null
  const tiny = computeIndicators(bars.slice(-3));
  assert.equal(tiny.returns.d20, null);
  assert.equal(tiny.returns.d60, null);
});

test('指标：maSeries 与输入等长，前置不足处为 null', () => {
  const ind = computeIndicators(makeBars({ n: 50 }));
  assert.equal(ind.maSeries.ma5.length, 50);
  assert.equal(ind.maSeries.ma20.length, 50);
  assert.equal(ind.maSeries.ma5[3], null, '第 4 根时 MA5 应为 null');
  assert.ok(Number.isFinite(ind.maSeries.ma5[4]), '第 5 根起 MA5 应有值');
  assert.equal(ind.maSeries.ma20[18], null, '第 19 根时 MA20 应为 null');
  assert.ok(Number.isFinite(ind.maSeries.ma20[19]), '第 20 根起 MA20 应有值');
});

test('指标：连续站上 MA20 天数与 MA20 斜率', () => {
  const up = computeIndicators(makeBars({ n: 120, start: 50, trendPct: 1 }));
  assert.equal(up.aboveMa20Days, 101, '持续上涨应一直站在 MA20 之上');
  assert.ok(up.ma20SlopePercent > 0, '持续上涨的 MA20 斜率应为正');

  const down = computeIndicators(makeBars({ n: 120, start: 300, trendPct: -1 }));
  assert.equal(down.aboveMa20Days, 0);
  assert.ok(down.ma20SlopePercent < 0, '持续下跌的 MA20 斜率应为负');
});

test('computeIndicators 对空输入返回结构完整的全 null 指标', () => {
  for (const input of [[], null, undefined, 'x']) {
    let ind;
    assert.doesNotThrow(() => {
      ind = computeIndicators(input);
    });
    assert.deepEqual(ind.closes, []);
    assert.equal(ind.ma.ma5, null);
    assert.equal(ind.rsi14, null);
    assert.equal(ind.macd.dif, null);
    assert.equal(ind.boll.mid, null);
    assert.equal(ind.atr14, null);
    assert.equal(ind.high60, null);
    assert.equal(ind.returns.d1, null);
    assert.equal(ind.consecutiveUp, 0);
    assert.equal(ind.aboveMa20Days, 0);
    assert.deepEqual(ind.maSeries.ma5, []);
  }
});

/* ════════════════════════════════════════════════════════════════
 * Evaluation 结构完整性
 * ════════════════════════════════════════════════════════════════ */

test('关键位：跳空 / 复权突变时，支撑压力位不会给出远离现价的无意义价位', () => {
  const quote = makeQuote({ price: 1500, prevClose: 1482, changePercent: 1.2 });
  // 构造一段与现价严重脱节的历史（模拟复权口径切换或长期停牌后跳空）
  const bars = makeBars({ n: 260, start: 140, trendPct: 0.05, endDate: '2026-11-07' });
  bars[bars.length - 1] = { ...bars[bars.length - 1], close: 1500 };

  const ev = evaluateStock({ quote, bars });
  assert.equal(ev.price, 1500);

  // 所有支撑/压力位都必须落在现价 ±25% 以内
  for (const s of ev.levels.support) {
    assert.ok(s < ev.price, `支撑位 ${s} 必须低于现价`);
    assert.ok(s >= ev.price * 0.75, `支撑位 ${s} 距现价 ${(((s / ev.price) - 1) * 100).toFixed(1)}%，过远且无参考意义`);
  }
  for (const r of ev.levels.resistance) {
    assert.ok(r > ev.price, `压力位 ${r} 必须高于现价`);
    assert.ok(r <= ev.price * 1.25, `压力位 ${r} 距现价过远，无参考意义`);
  }
  // 仍然要保证 2-3 个，不能因为过滤而变空
  assert.ok(ev.levels.support.length >= 2, `过滤后支撑位不足：${JSON.stringify(ev.levels.support)}`);
  assert.ok(ev.levels.resistance.length >= 2, `过滤后压力位不足：${JSON.stringify(ev.levels.resistance)}`);
});

test('Evaluation 结构完整：字段齐全、类型正确、文案为中文', () => {
  const quote = makeQuote();
  // K 线末条对齐快照日期，这样 stale 才应该是 false（见 stale 专项测试）
  const bars = makeBars({ n: 260, start: 1400, trendPct: 0.1, endDate: '2026-11-07' });
  const ev = evaluateStock({ quote, bars });

  // 基础字段
  assert.equal(ev.code, '600519');
  assert.equal(ev.secid, 'sh600519');
  assert.equal(ev.name, '贵州茅台');
  assert.equal(typeof ev.asOf, 'string');
  assert.equal(ev.asOf, '2026-11-07 15:00:00');
  assert.equal(ev.price, 1500);
  assert.equal(ev.changePercent, 1.35);

  // 评级
  assert.ok(['strong-bull', 'bull', 'neutral', 'bear', 'strong-bear'].includes(ev.verdict));
  assert.ok(['强烈看多', '偏多', '中性', '偏空', '强烈看空'].includes(ev.verdictLabel));
  assert.equal(typeof ev.upProbability, 'number');

  // 因子
  const expectKeys = ['trend', 'momentum', 'volume', 'position', 'volatility', 'risk'];
  assert.deepEqual(ev.factors.map((f) => f.key), expectKeys, '因子 key 集合与顺序不符');
  const expectLabels = { trend: '趋势', momentum: '动量', volume: '量能', position: '位置', volatility: '波动', risk: '风险' };
  for (const f of ev.factors) {
    assert.equal(f.label, expectLabels[f.key], `${f.key} 的中文名不符`);
    assert.ok(typeof f.signals === 'object' && Array.isArray(f.signals));
    assert.ok(f.signals.length >= 2 && f.signals.length <= 5, `${f.key} 的 signals 必须 2-5 条，实际 ${f.signals.length}`);
    for (const s of f.signals) {
      assert.equal(typeof s, 'string');
      assert.ok(s.trim().length > 0, `${f.key} 有空白 signal`);
      // 中文文案检查：至少包含一个汉字
      assert.ok(/[\u4e00-\u9fa5]/.test(s), `${f.key} 的 signal 应为中文：${s}`);
    }
  }

  // 关键位
  assert.ok(Array.isArray(ev.levels.support));
  assert.ok(Array.isArray(ev.levels.resistance));
  for (const s of ev.levels.support) {
    assert.ok(s < ev.price, `支撑位 ${s} 必须低于现价 ${ev.price}`);
  }
  for (const r of ev.levels.resistance) {
    assert.ok(r > ev.price, `压力位 ${r} 必须高于现价 ${ev.price}`);
  }
  for (let i = 1; i < ev.levels.support.length; i += 1) {
    assert.ok(ev.levels.support[i - 1] > ev.levels.support[i], '支撑位必须降序');
  }
  for (let i = 1; i < ev.levels.resistance.length; i += 1) {
    assert.ok(ev.levels.resistance[i - 1] < ev.levels.resistance[i], '压力位必须升序');
  }
  assert.ok(ev.levels.support.length >= 2 && ev.levels.support.length <= 3, `支撑位应 2-3 个，实际 ${ev.levels.support.length}`);
  assert.ok(ev.levels.resistance.length >= 2 && ev.levels.resistance.length <= 3, `压力位应 2-3 个，实际 ${ev.levels.resistance.length}`);

  // 风险与摘要
  assert.ok(Array.isArray(ev.risks));
  assert.equal(typeof ev.summary, 'string');
  assert.ok(ev.summary.length >= 20, 'summary 应为 2-4 句完整中文');
  assert.ok(/[\u4e00-\u9fa5]/.test(ev.summary), 'summary 应为中文');
  assert.ok(
    ev.summary.includes('启发式') || ev.disclaimer.includes('启发式'),
    'summary 或 disclaimer 必须标注「启发式估计，非概率模型输出」',
  );
  assert.ok(ev.disclaimer.includes('启发式'), 'disclaimer 必须写明启发式');

  // 数据质量
  assert.equal(ev.dataQuality.bars, 260);
  assert.equal(ev.dataQuality.hasQuote, true);
  assert.equal(ev.dataQuality.stale, false);
  assert.ok(Array.isArray(ev.dataQuality.warnings));
});

test('Evaluation 中 signals 必须是人话：包含具体数值而不是占位符', () => {
  const ev = evaluateStock({ quote: makeQuote(), bars: makeBars({ n: 260, start: 1400, trendPct: 0.15 }) });
  const all = ev.factors.flatMap((f) => f.signals);
  assert.ok(all.length >= 12, `6 个因子合计至少 12 条 signal，实际 ${all.length}`);
  // 至少有若干条带具体数字（价格 / 百分比 / 天数 / 倍数）
  const withNumber = all.filter((s) => /\d/.test(s));
  assert.ok(withNumber.length >= 8, `带具体数值的 signal 应至少 8 条，实际 ${withNumber.length}`);
  for (const s of all) {
    assert.ok(!s.includes('undefined'), `signal 不应出现 undefined：${s}`);
    assert.ok(!s.includes('NaN'), `signal 不应出现 NaN：${s}`);
    assert.ok(!s.includes('null'), `signal 不应出现 null：${s}`);
  }
});

test('summary 必须包含启发式概率标注', () => {
  const ev = evaluateStock({ quote: makeQuote(), bars: makeBars({ n: 260 }) });
  assert.ok(ev.summary.includes('启发式'), 'summary 必须包含「启发式」');
  assert.ok(ev.summary.includes('非概率模型输出'), 'summary 必须包含「非概率模型输出」');
});

test('summary 句子之间必须有标点分隔，不得出现两句黏连', () => {
  for (const input of [
    { quote: makeQuote(), bars: makeBars({ n: 260, endDate: '2026-11-07' }) },
    { quote: null, bars: makeBars({ n: 260, trendPct: 0.8 }) },
    { quote: null, bars: [] },
  ]) {
    const ev = evaluateStock(input);
    // 除末句外，每个句号后都应紧接下一句的开头，不允许「。」后直接跟无标点的紧邻
    assert.ok(/。$/.test(ev.summary), `summary 应以句号结尾：${ev.summary}`);
    assert.ok(!/风险上文/.test(ev.summary), `summary 出现黏连：${ev.summary}`);
    assert.ok(!/分上文/.test(ev.summary), `summary 出现黏连：${ev.summary}`);
    // 句子数量在 2-4 之间
    const count = (ev.summary.match(/。/g) || []).length;
    assert.ok(count >= 2 && count <= 4, `summary 应 2-4 句，实际 ${count} 句：${ev.summary}`);
  }
});

test('risks 为空时 summary 不得出现「主要风险」句式（无风险不能说成有风险）', () => {
  // 温和横盘：不应触发连续涨跌、偏离、涨跌停等风险项
  const ev = evaluateStock({ quote: null, bars: makeBars({ n: 261, waveAmp: 2, wavePeriod: 20 }) });
  if (ev.risks.length === 0) {
    assert.ok(!ev.summary.includes('主要风险'), `无风险时不应写「主要风险：」：${ev.summary}`);
    assert.ok(
      ev.summary.includes('未触发') || ev.summary.includes('暂未'),
      `无风险时应明确说未检测到风险：${ev.summary}`,
    );
  }
  // risks 数组里不得再塞「未检测到风险」这类占位文案，否则调用方会误读
  for (const r of ev.risks) {
    assert.ok(!/未检测到显著的短线过热/.test(r), `risks 不应包含占位文案：${r}`);
  }
});

/* ════════════════════════════════════════════════════════════════
 * dataQuality.stale 语义
 * ════════════════════════════════════════════════════════════════ */

test('stale 只描述数据时间是否陈旧，不描述「有没有实时快照」', () => {
  // 1) K 线末条与快照同日 → 不陈旧，即使走了 quote 价格
  const aligned = evaluateStock({
    quote: makeQuote({ timestamp: '2026-11-07 15:00:00' }),
    bars: makeBars({ n: 120, start: 1400, endDate: '2026-11-07' }),
  });
  assert.equal(aligned.dataQuality.stale, false, 'K 线与快照同日时不应判为陈旧');

  // 2) K 线落后于快照 → 陈旧
  const lagging = evaluateStock({
    quote: makeQuote({ timestamp: '2026-11-07 15:00:00' }),
    bars: makeBars({ n: 120, start: 1400, endDate: '2026-10-20' }),
  });
  assert.equal(lagging.dataQuality.stale, true, 'K 线早于快照日期时必须判为陈旧');
  assert.ok(
    lagging.dataQuality.warnings.some((w) => w.includes('早于快照时间')),
    `应说明 stale 的具体原因，实际 ${JSON.stringify(lagging.dataQuality.warnings)}`,
  );

  // 3) 完全没有快照 → stale 不是「有快照但过期」，但仍然无法核验时效，
  //    此时不应谎称「陈旧」（避免 UI 误报），只给 hasQuote=false 和 warning
  const noQuote = evaluateStock({ quote: null, bars: makeBars({ n: 120, start: 100 }) });
  assert.equal(noQuote.dataQuality.hasQuote, false);
  assert.equal(noQuote.dataQuality.stale, false, '无快照不等于数据陈旧');
  assert.ok(
    noQuote.dataQuality.warnings.some((w) => w.includes('无法核验')),
    `应说明无法核验时效，实际 ${JSON.stringify(noQuote.dataQuality.warnings)}`,
  );

  // 4) 无 K 线 → 无可评估数据，判为陈旧
  const empty = evaluateStock({ quote: null, bars: [] });
  assert.equal(empty.dataQuality.stale, true, '没有 K 线数据时应判为陈旧');
});

/* ════════════════════════════════════════════════════════════════
 * 纯函数性
 * ════════════════════════════════════════════════════════════════ */

test('纯函数：不修改传入的 bars 与 quote，且多次调用结果一致', () => {
  const bars = makeBars({ n: 120, start: 100, trendPct: 0.3 });
  const quote = makeQuote();
  const barsSnapshot = JSON.stringify(bars);
  const quoteSnapshot = JSON.stringify(quote);

  const a = evaluateStock({ quote, bars });
  const b = evaluateStock({ quote, bars });

  assert.equal(JSON.stringify(bars), barsSnapshot, 'bars 被修改了');
  assert.equal(JSON.stringify(quote), quoteSnapshot, 'quote 被修改了');
  assert.deepEqual(a, b, '相同输入必须得到相同输出（无隐藏状态）');

  // computeIndicators 同样必须是纯的
  const indSnapshot = JSON.stringify(bars);
  computeIndicators(bars);
  assert.equal(JSON.stringify(bars), indSnapshot, 'computeIndicators 修改了输入');
});

test('纯函数：源码中不得出现 IO / 网络 / 环境变量访问', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/score.js', import.meta.url), 'utf8');
  const forbidden = [
    ['fetch(', '网络请求'],
    ['node:http', 'HTTP 模块'],
    ['node:https', 'HTTPS 模块'],
    ['node:fs', '文件系统'],
    ['process.env', '环境变量'],
    ['XMLHttpRequest', 'XHR'],
    ['require(', 'CommonJS require'],
  ];
  for (const [needle, label] of forbidden) {
    assert.ok(!src.includes(needle), `score.js 不应包含 ${label}（${needle}）`);
  }
});

/* ════════════════════════════════════════════════════════════════
 * evaluateMany
 * ════════════════════════════════════════════════════════════════ */

test('evaluateMany 批量评分：长度一致、顺序一致、不抛异常', () => {
  const inputs = [
    { quote: makeQuote({ code: '600519', name: '贵州茅台' }), bars: makeBars({ n: 260, start: 1400, trendPct: 0.2 }) },
    { quote: makeQuote({ code: '000001', name: '平安银行', price: 12 }), bars: makeBars({ n: 260, start: 15, trendPct: -0.4 }) },
    { quote: null, bars: [] },
    null,
  ];

  let out;
  assert.doesNotThrow(() => {
    out = evaluateMany(inputs);
  }, 'evaluateMany 不应抛异常');

  assert.equal(out.length, inputs.length, '输出长度必须与输入一致');
  assert.equal(out[0].code, '600519');
  assert.equal(out[1].code, '000001');
  assert.ok(['bull', 'strong-bull'].includes(out[0].verdict) || out[0].score > 50);
  assert.ok(['bear', 'strong-bear'].includes(out[1].verdict) || out[1].score < 50);
  assert.equal(out[2].score, 50);
  assert.equal(out[3].score, 50, 'null 项应降级为中性');
  for (const ev of out) {
    assert.equal(ev.factors.length, 6);
    assert.equal(typeof ev.summary, 'string');
    assert.ok(ev.score >= 0 && ev.score <= 100);
  }
});

test('evaluateMany 对非数组输入返回空数组', () => {
  for (const bad of [null, undefined, 42, 'x', {}]) {
    assert.deepEqual(evaluateMany(bad), []);
  }
});

/* ════════════════════════════════════════════════════════════════
 * 评分口径的单调性（回归保护）
 * ════════════════════════════════════════════════════════════════ */

test('单调性：温和区间内趋势越强总分越高', () => {
  // 在「可持续上涨」区间（-1.5% ~ +1.0%/日）内，总分必须严格单调。
  // 超过 +1%/日 后不再单调，见下一个测试：那是风险因子的刻意惩罚，不是缺陷。
  const steps = [-1.5, -0.8, -0.2, 0, 0.2, 0.8];
  const scores = steps.map(
    (p) => evaluateStock({ quote: null, bars: makeBars({ n: 260, start: 100, trendPct: p }) }).score,
  );
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(
      scores[i] > scores[i - 1],
      `趋势由弱转强时总分应单调上升，第 ${i} 项 ${scores[i]} 未大于 ${scores[i - 1]}（${JSON.stringify(scores)}）`,
    );
  }
});

test('单调性：抛物线式加速上涨会被风险因子压回，不追求全局单调', () => {
  // 设计取舍：+0.8%/日 → +1.5%/日 → +2%/日 时总分不再递增。
  // 理由：+2%/日 复利 260 天是天文数字，必然伴随 RSI 极高、偏离 MA20 近 20%、
  // 连续上涨 259 天，这些是真实的追高风险，风险因子应当扣分。
  // 我们要保证的是：它仍然落在最强的 verdict 区间，而不是被压回中间。
  const mild = evaluateStock({ quote: null, bars: makeBars({ n: 260, start: 100, trendPct: 0.8 }) });
  const parabolic = evaluateStock({ quote: null, bars: makeBars({ n: 260, start: 10, trendPct: 2 }) });

  // 两者都必须是强烈看多
  assert.equal(mild.verdict, 'strong-bull', `+0.8%/日 应为 strong-bull，实际 ${mild.verdict}`);
  assert.equal(parabolic.verdict, 'strong-bull', `+2%/日 应为 strong-bull，实际 ${parabolic.verdict}`);

  // 极端加速的风险分必须明显低于温和上涨
  const mildRisk = mild.factors.find((f) => f.key === 'risk').score;
  const paraRisk = parabolic.factors.find((f) => f.key === 'risk').score;
  assert.ok(paraRisk < mildRisk, `+2%/日的风险分(${paraRisk}) 应低于 +0.8%/日(${mildRisk})`);

  // 且必须给出可读的风险提示
  assert.ok(
    parabolic.risks.some((r) => r.includes('连续') || r.includes('偏离')),
    `极端加速应给出风险提示，实际 ${JSON.stringify(parabolic.risks)}`,
  );
});

test('单调性：下跌越深总分越低', () => {
  const steps = [-0.2, -0.8, -1.5];
  const scores = steps.map(
    (p) => evaluateStock({ quote: null, bars: makeBars({ n: 260, start: 100, trendPct: p }) }).score,
  );
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i] < scores[i - 1], `下跌加深时总分应下降：${JSON.stringify(scores)}`);
  }
});

test('放量上涨的量能因子应高于缩量上涨', () => {
  const base = makeBars({ n: 60, start: 100, trendPct: 0.5, volume: 100000 });
  const lastBar = base[base.length - 1];

  const heavy = [...base.slice(0, -1), { ...lastBar, volume: 300000 }];
  const light = [...base.slice(0, -1), { ...lastBar, volume: 40000 }];

  const q = makeQuote({ price: lastBar.close, changePercent: 2 });
  const heavyScore = evaluateStock({ quote: q, bars: heavy }).factors.find((f) => f.key === 'volume').score;
  const lightScore = evaluateStock({ quote: q, bars: light }).factors.find((f) => f.key === 'volume').score;

  assert.ok(heavyScore > lightScore, `放量上涨的量能分(${heavyScore}) 应高于缩量上涨(${lightScore})`);
});

test('放量下跌的量能因子应低于放量上涨', () => {
  const bars = makeBars({ n: 60, start: 100, trendPct: 0.2, volume: 100000 });
  const lastBar = bars[bars.length - 1];
  const heavyBars = [...bars.slice(0, -1), { ...lastBar, volume: 300000 }];

  const upQuote = makeQuote({ price: lastBar.close, changePercent: 3 });
  const downQuote = makeQuote({ price: lastBar.close, changePercent: -3 });

  const upV = evaluateStock({ quote: upQuote, bars: heavyBars }).factors.find((f) => f.key === 'volume').score;
  const downV = evaluateStock({ quote: downQuote, bars: heavyBars }).factors.find((f) => f.key === 'volume').score;
  assert.ok(upV > downV, `放量上涨(${upV}) 的量能分应高于放量下跌(${downV})`);
});

test('连续大涨会通过风险因子压低总分', () => {
  // 前 250 天温和上行，最后 8 天加速
  const calm = makeBars({ n: 250, start: 100, trendPct: 0.1 });
  const spike = [...calm];
  let last = calm[calm.length - 1].close;
  for (let i = 0; i < 8; i += 1) {
    const close = Number((last * 1.05).toFixed(2));
    spike.push({
      date: `2025-02-${String(i + 1).padStart(2, '0')}`,
      open: last,
      close,
      high: Number((close * 1.004).toFixed(2)),
      low: Number((last * 0.996).toFixed(2)),
      volume: 100000,
    });
    last = close;
  }

  const calmEv = evaluateStock({ quote: null, bars: calm });
  const spikeEv = evaluateStock({ quote: null, bars: spike });

  const calmRisk = calmEv.factors.find((f) => f.key === 'risk').score;
  const spikeRisk = spikeEv.factors.find((f) => f.key === 'risk').score;
  assert.ok(spikeRisk < calmRisk, `加速上涨的风险分(${spikeRisk}) 应低于平稳上涨(${calmRisk})`);
  assert.ok(
    spikeEv.risks.length > 0 && spikeEv.risks.some((r) => r.includes('连续') || r.includes('偏离')),
    `加速上涨应产生风险提示，实际 ${JSON.stringify(spikeEv.risks)}`,
  );
});
