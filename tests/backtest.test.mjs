/**
 * dsh-astock / tests/backtest.test.mjs
 * lib/backtest.js 自测。全部使用合成 K 线，不联网、不读文件、不 mock 网络。
 *
 * ── 这个测试文件的重心 ────────────────────────────────────────────
 * 回测最危险的失效模式不是崩溃，而是「结果看起来很漂亮但是在骗人」。
 * 所以本文件用近乎偏执的方式验证防未来函数，共五层：
 *
 *  ① 窗口长度一致性：onBar 收到的 bars.length 必须恒等于 index + 1，
 *     且最后一根日期必须等于全量数据的第 index 根。
 *  ② 成交价 == T+1 开盘价：构造「信号日在暴涨日、次日跳空高开 25%」的数据，
 *     断言买入成交价精确等于次日开盘价。若实现偷用了信号日收盘价，
 *     或直接吃掉了暴涨，这个断言立刻失败。
 *  ③ 数据不变量：onBar 拿到的窗口做一致性哈希，与「只用 bars[0..t] 独立
 *     算一遍」的结果比对 —— 窗口里不能出现任何未来的数字。
 *  ④ 截断等价性（最强的一条）：把数据截断到第 k 根重跑，前 k 根内的
 *     全部净值点必须与全量回测逐个完全相同。任何形式的数据泄漏都会
 *     让某个中间净值点发生偏移。
 *  ⑤ 暴涨不可预知：暴涨日之前的所有净值点必须与「把暴涨及之后的数据
 *     全部删掉」跑出来的完全一致 —— 也就是未来的暴涨一丝一毫都没有
 *     提前影响过去。
 *
 * 另有常规覆盖：上涨/下跌行情、统计指标手工核对、费用确实扣除、
 * 空数据/极少数据/脏数据不抛异常、三个内置策略行为、纯函数性。
 *
 * 运行：cd dsh-astock && node --test tests/backtest.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runBacktest,
  computeStats,
  resolveStrategy,
  STRATEGIES,
  DEFAULT_OPTIONS,
  DISCLAIMER,
} from '../lib/backtest.js';
import { evaluateStock } from '../lib/score.js';

/* ════════════════════════════════════════════════════════════════
 * 合成 K 线工厂
 * ════════════════════════════════════════════════════════════════ */

/**
 * 生成确定性的合成日 K，从 endDate 往回推 n 天，保证日期连续可控。
 *
 * @param {object} o
 * @param {number} o.n          根数
 * @param {number} o.start      起始价
 * @param {number} o.trendPct   每日复利涨跌幅 %
 * @param {number} o.waveAmp    正弦波振幅 %
 * @param {number} o.wavePeriod 正弦波周期（天）
 * @param {number} o.volume     基准成交量
 * @param {string} o.endDate    最后一根 K 线的日期
 */
function makeBars(o = {}) {
  const {
    n = 400,
    start = 100,
    trendPct = 0,
    waveAmp = 0,
    wavePeriod = 20,
    volume = 100000,
    endDate = '2024-12-31',
  } = o;
  const bars = [];
  let prevClose = start;
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  for (let i = 0; i < n; i += 1) {
    const trend = Math.pow(1 + trendPct / 100, i);
    const wave = 1 + (waveAmp * Math.sin((2 * Math.PI * i) / wavePeriod)) / 100;
    const close = Number((start * trend * wave).toFixed(2));
    const open = Number(prevClose.toFixed(2));
    const high = Number((Math.max(open, close) * 1.004).toFixed(2));
    const low = Number((Math.min(open, close) * 0.996).toFixed(2));
    const d = new Date(endMs - (n - 1 - i) * 86400000);
    bars.push({ date: d.toISOString().slice(0, 10), open, close, high, low, volume });
    prevClose = close;
  }
  return bars;
}

/**
 * 构造「长期横盘 → 第 surgeStart 根起连续暴涨」的 K 线。
 * 这是防未来函数专项测试的主场景：暴涨完全不可预测，
 * 正确的实现不可能在暴涨发生前建立仓位。
 *
 * 关键设计：暴涨日的 open == 前一日的 close（无跳空），
 * 所以「信号日收盘成交」和「次日开盘成交」在这份数据上价格相同 ——
 * 想验证成交时点必须另外造跳空场景（见 makeGapBars）。
 */
function makeSurgeBars(o = {}) {
  const { n = 200, base = 100, surgeStart = 150, surgeDays = 5, dailyPct = 12, endDate = '2024-12-31' } = o;
  const bars = [];
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  let prev = base;
  for (let i = 0; i < n; i += 1) {
    const open = prev;
    let close = prev;
    if (i >= surgeStart && i < surgeStart + surgeDays) {
      close = Number((open * (1 + dailyPct / 100)).toFixed(2));
    }
    const d = new Date(endMs - (n - 1 - i) * 86400000);
    bars.push({
      date: d.toISOString().slice(0, 10),
      open,
      close,
      high: Math.max(open, close),
      low: Math.min(open, close),
      volume: 100000,
    });
    prev = close;
  }
  return bars;
}

/**
 * 构造「横盘 → 第 gapIndex 根暴涨 → 第 gapIndex+1 根跳空高开 25%」的 K 线。
 *
 * 用途唯一：验证成交价到底是 T+1 开盘价还是 T 日收盘价。
 * 这两个价格被刻意拉开 25%，任何混淆都会在断言里暴露。
 */
function makeGapBars(o = {}) {
  const { n = 200, base = 100, gapIndex = 150, gapPct = 25, endDate = '2024-12-31' } = o;
  const bars = makeSurgeBars({ n, base, surgeStart: 9999, endDate }); // 先造一条纯横盘
  // 在 gapIndex 当天做一次 12% 的拉升，把评分推过买入阈值
  bars[gapIndex].open = bars[gapIndex - 1].close;
  bars[gapIndex].close = Number((bars[gapIndex].open * 1.12).toFixed(2));
  bars[gapIndex].high = bars[gapIndex].close;
  bars[gapIndex].low = bars[gapIndex].open;
  // 次日跳空高开 25%，且全天不回落
  const gapOpen = Number((bars[gapIndex].close * (1 + gapPct / 100)).toFixed(2));
  bars[gapIndex + 1].open = gapOpen;
  bars[gapIndex + 1].close = gapOpen;
  bars[gapIndex + 1].high = gapOpen;
  bars[gapIndex + 1].low = gapOpen;
  // 后续价格继续以该价位横盘，避免再次触发交易干扰断言
  for (let i = gapIndex + 2; i < n; i += 1) {
    bars[i].open = gapOpen;
    bars[i].close = gapOpen;
    bars[i].high = gapOpen;
    bars[i].low = gapOpen;
  }
  return bars;
}

/** 把净值曲线压成便于断言/比对的形式。 */
function equityTuples(result) {
  return result.equity.map((p) => [p.date, p.equity, p.benchmark]);
}

/* ════════════════════════════════════════════════════════════════
 * ① 窗口长度一致性
 * ════════════════════════════════════════════════════════════════ */

test('防未来函数①：策略每一步收到的窗口长度恒等于 index+1，最后一根就是当日', () => {
  const bars = makeBars({ n: 200, trendPct: 0.2, waveAmp: 2 });
  const seen = [];

  const probe = {
    name: 'window-probe',
    onBar({ bars: window, index }) {
      seen.push({
        index,
        len: window.length,
        lastDate: window[window.length - 1].date,
        lastClose: window[window.length - 1].close,
      });
      return { action: 'hold', reason: '只观察不交易' };
    },
  };

  const r = runBacktest({ bars, strategy: probe, options: { warmup: 60 } });

  assert.ok(r.ok, '回测应当成功');
  assert.equal(seen.length, r.bars, 'onBar 调用次数应等于实际回测的 K 线根数');

  for (const s of seen) {
    assert.equal(s.len, s.index + 1, `index=${s.index} 时窗口长度应为 ${s.index + 1}，实际 ${s.len}`);
    assert.equal(s.lastDate, bars[s.index].date, `index=${s.index} 时窗口最后一根日期应等于全量数据同位置日期`);
    assert.equal(s.lastClose, bars[s.index].close, `index=${s.index} 时窗口最后一根收盘价应等于全量数据同位置收盘价`);
  }

  assert.equal(seen[0].index, 59, 'warmup=60 时第一个决策下标应为 59（窗口 60 根）');
  assert.equal(seen[seen.length - 1].index, 199, '最后一个决策下标应为最后一根');
});

test('防未来函数①：给策略的窗口是独立数组，改写它不会污染原始 bars', () => {
  const bars = makeBars({ n: 120, trendPct: 0.2 });
  const originalFirstClose = bars[0].close;
  const originalLastClose = bars[bars.length - 1].close;

  const vandal = {
    name: 'vandal',
    onBar({ bars: window }) {
      // 恶意改动窗口：如果 slice 返回的是共享引用，原始数据会被破坏
      window[0].close = -999;
      window[window.length - 1].close = -888;
      return { action: 'hold', reason: '破坏性测试' };
    },
  };

  const r = runBacktest({ bars, strategy: vandal, options: { warmup: 60 } });
  assert.ok(r.ok);
  assert.equal(bars[0].close, originalFirstClose, '原始 bars 首根不应被策略改写');
  assert.equal(bars[bars.length - 1].close, originalLastClose, '原始 bars 末根不应被策略改写');
});

/* ════════════════════════════════════════════════════════════════
 * ② 成交价必须是 T+1 开盘价
 * ════════════════════════════════════════════════════════════════ */

test('防未来函数②：成交价必须是信号次日开盘价，不是信号日收盘价', () => {
  // 用 confirmBars: 1 把「信号日」钉死成单日穿越点，才能精确断言「信号日 + 1」。
  // 两个价格被刻意拉开 25%（信号日 close vs 次日 open），混淆必暴露。
  const bars = makeGapBars({ n: 200, gapIndex: 150, gapPct: 25 });
  const signalBar = bars[150];
  const nextBar = bars[151];

  // 先用同一份窗口独立算一遍，确认第 150 根确实会产生买入信号
  const scoreAtSignal = evaluateStock({ bars: bars.slice(0, 151) }).score;
  assert.ok(
    scoreAtSignal >= DEFAULT_OPTIONS.thresholdBuy,
    `测试前提：信号日（含）的评分 ${scoreAtSignal} 应已达到买入阈值 ${DEFAULT_OPTIONS.thresholdBuy}`,
  );

  const r = runBacktest({ bars, options: { warmup: 60, confirmBars: 1 } });
  assert.ok(r.ok);
  assert.ok(r.trades.length >= 1, '应当至少产生一笔交易');

  const first = r.trades[0];
  assert.equal(first.entryDate, nextBar.date, '买入日应为信号日的次日（T+1）');
  assert.equal(
    first.entryPrice,
    Number(nextBar.open.toFixed(4)),
    `买入成交价必须是次日开盘价 ${nextBar.open}；若等于信号日收盘价 ${signalBar.close} 说明偷用了未来`,
  );
  assert.notEqual(
    first.entryPrice,
    Number(signalBar.close.toFixed(4)),
    '成交价绝不能等于信号日收盘价 —— 收盘时才知道信号，现实中按这个价格买不进',
  );
});

test('防未来函数②：confirmBars=2 时成交价仍必须是「确认日次日」开盘价', () => {
  // 信号确认机制会把入场推迟 N-1 天，但无论推迟几天，
  // 「决策日 → 次日开盘成交」这条规则都不能变。
  // 这里验证两种 confirmBars 的成交价各自等于其自身信号日的次日开盘价。
  const bars = makeGapBars({ n: 200, gapIndex: 150, gapPct: 25 });

  for (const confirmBars of [1, 2, 3]) {
    const r = runBacktest({ bars, options: { warmup: 60, confirmBars } });
    assert.ok(r.ok, `confirmBars=${confirmBars} 应成功`);
    assert.ok(r.trades.length >= 1, `confirmBars=${confirmBars} 应产生交易`);

    const entry = r.trades[0];
    const entryIdx = bars.findIndex((b) => b.date === entry.entryDate);
    assert.ok(entryIdx > 0, '建仓日下标必须为正（不可能是第一根）');
    assert.equal(
      entry.entryPrice,
      Number(bars[entryIdx].open.toFixed(4)),
      `confirmBars=${confirmBars}：成交价必须等于建仓日开盘价 ${bars[entryIdx].open}`,
    );

    // 建仓日必须晚于「首次达标日」，证明确认机制确实推迟了入场
    const firstQualifyIdx = 150;
    assert.ok(
      entryIdx >= firstQualifyIdx + confirmBars,
      `confirmBars=${confirmBars}：建仓日下标 ${entryIdx} 应不早于首次达标日 ${firstQualifyIdx} + 确认期 ${confirmBars} = ${firstQualifyIdx + confirmBars}`,
    );
  }
});

test('防未来函数②：卖出也必须在信号次日开盘成交', () => {
  // 上涨段把仓位建起来，然后急跌把评分打到卖出阈值以下
  const bars = makeBars({ n: 260, trendPct: 0.4 });
  const crashStart = 240;
  let prev = bars[crashStart].open;
  for (let i = crashStart; i < bars.length; i += 1) {
    const open = prev;
    const close = Number((open * 0.9).toFixed(2)); // 每天跌 10%
    bars[i] = { ...bars[i], open, close, high: open, low: close };
    prev = close;
  }

  const r = runBacktest({ bars, options: { warmup: 60 } });
  assert.ok(r.ok);

  const closed = r.trades.filter((t) => t.reason && t.reason.includes('跌破卖出阈值'));
  if (closed.length === 0) {
    // 若该数据未能触发阈值卖出（评分未跌破），至少验证不出现时序倒挂
    for (const t of r.trades) {
      assert.ok(t.exitDate >= t.entryDate, '平仓日不得早于建仓日');
    }
    return;
  }

  for (const t of closed) {
    const exitIdx = bars.findIndex((b) => b.date === t.exitDate);
    const entryIdx = bars.findIndex((b) => b.date === t.entryDate);
    assert.ok(exitIdx > entryIdx, '平仓日下标必须大于建仓日下标');

    // 卖出成交价必须等于平仓日开盘价（滑点为 0 时精确相等）
    assert.equal(
      t.exitPrice,
      Number(bars[exitIdx].open.toFixed(4)),
      `卖出成交价应为平仓日开盘价 ${bars[exitIdx].open}`,
    );
    assert.ok(
      t.exitPrice > bars[exitIdx].close,
      '卖出价（开盘）应高于当日收盘价，证明没按收盘价成交',
    );
  }
});

/* ════════════════════════════════════════════════════════════════
 * ③ 窗口内容不变量：不含任何未来数字
 * ════════════════════════════════════════════════════════════════ */

test('防未来函数③：策略窗口的每一个数字都来自 bars[0..t]，不含未来数据', () => {
  const bars = makeBars({ n: 150, trendPct: 0.3, waveAmp: 3 });
  let checked = 0;

  const auditor = {
    name: 'auditor',
    onBar({ bars: window, index }) {
      // 逐步与「只用 bars[0..index] 手工重建的窗口」比对
      assert.equal(window.length, index + 1, `index=${index}：窗口长度应为 ${index + 1}`);

      for (let i = 0; i <= index; i += 1) {
        assert.equal(window[i].date, bars[i].date, `index=${index} 的窗口第 ${i} 根日期被篡改`);
        assert.equal(window[i].open, bars[i].open, `index=${index} 的窗口第 ${i} 根开盘价被篡改`);
        assert.equal(window[i].close, bars[i].close, `index=${index} 的窗口第 ${i} 根收盘价被篡改`);
        assert.equal(window[i].high, bars[i].high, `index=${index} 的窗口第 ${i} 根最高价被篡改`);
        assert.equal(window[i].low, bars[i].low, `index=${index} 的窗口第 ${i} 根最低价被篡改`);
        assert.equal(window[i].volume, bars[i].volume, `index=${index} 的窗口第 ${i} 根成交量被篡改`);
      }
      checked += 1;
      return { action: 'hold', reason: '审计' };
    },
  };

  const r = runBacktest({ bars, strategy: auditor, options: { warmup: 40 } });
  assert.ok(r.ok);
  assert.ok(checked > 50, `应逐根审计了足够多的步数，实际 ${checked}`);
});

/* ════════════════════════════════════════════════════════════════
 * ④ 截断等价性 —— 最强的数据泄漏检验
 * ════════════════════════════════════════════════════════════════ */

test('防未来函数④：截断数据重跑，前段净值必须与全量回测逐个完全相同', () => {
  const bars = makeBars({ n: 400, trendPct: 0.25, waveAmp: 2.5, wavePeriod: 25 });
  const full = runBacktest({ bars, strategy: 'score-threshold', options: { warmup: 60 } });
  assert.ok(full.ok);
  assert.ok(full.equity.length > 200, '全量回测的净值点应足够多');

  // 取多个截断点，覆盖「截断在空仓期」「截断在持仓期」两种情况
  for (const k of [100, 180, 300, 380]) {
    const part = runBacktest({ bars: bars.slice(0, k), strategy: 'score-threshold', options: { warmup: 60 } });
    assert.ok(part.ok, `k=${k} 的回测应当成功`);

    const fullPrefix = full.equity.slice(0, part.equity.length);
    assert.equal(
      part.equity.length,
      k - 59,
      `k=${k} 的净值点数应为 ${k - 59}（warmup=60，从第 60 根开始）`,
    );

    for (let i = 0; i < part.equity.length; i += 1) {
      assert.equal(
        part.equity[i].equity,
        fullPrefix[i].equity,
        `k=${k} 第 ${i} 个净值点（${part.equity[i].date}）与全量回测不一致：` +
          `截断后 ${part.equity[i].equity} vs 全量 ${fullPrefix[i].equity}。` +
          '这说明该日净值受到了未来数据的影响',
      );
      assert.equal(part.equity[i].date, fullPrefix[i].date, `k=${k} 第 ${i} 个净值点日期不一致`);
      assert.equal(part.equity[i].benchmark, fullPrefix[i].benchmark, `k=${k} 第 ${i} 个基准点不一致`);
    }
  }
});

test('防未来函数④：截断等价性在三个内置策略上都成立', () => {
  const bars = makeBars({ n: 320, trendPct: 0.15, waveAmp: 4, wavePeriod: 22 });

  for (const name of Object.keys(STRATEGIES)) {
    const full = runBacktest({ bars, strategy: name, options: { warmup: 60 } });
    const part = runBacktest({ bars: bars.slice(0, 250), strategy: name, options: { warmup: 60 } });
    assert.ok(full.ok && part.ok, `策略 ${name} 应成功运行`);

    const fullPrefix = full.equity.slice(0, part.equity.length);
    for (let i = 0; i < part.equity.length; i += 1) {
      assert.equal(
        part.equity[i].equity,
        fullPrefix[i].equity,
        `策略 ${name} 在 ${part.equity[i].date} 的净值受未来数据影响：` +
          `截断 ${part.equity[i].equity} vs 全量 ${fullPrefix[i].equity}`,
      );
    }
    // 截断点之前的已平仓交易也必须逐个一致
    const partLastDate = part.equity[part.equity.length - 1].date;
    const fullTradesBefore = full.trades.filter((t) => t.exitDate < partLastDate);
    const partTradesBefore = part.trades.filter((t) => t.exitDate < partLastDate);
    assert.equal(
      partTradesBefore.length,
      fullTradesBefore.length,
      `策略 ${name} 截断点之前已平仓的交易笔数应一致`,
    );
    for (let i = 0; i < partTradesBefore.length; i += 1) {
      assert.equal(partTradesBefore[i].entryDate, fullTradesBefore[i].entryDate, `策略 ${name} 第 ${i} 笔建仓日不一致`);
      assert.equal(partTradesBefore[i].exitDate, fullTradesBefore[i].exitDate, `策略 ${name} 第 ${i} 笔平仓日不一致`);
      assert.equal(partTradesBefore[i].pnl, fullTradesBefore[i].pnl, `策略 ${name} 第 ${i} 笔盈亏不一致`);
    }
  }
});

/* ════════════════════════════════════════════════════════════════
 * ④b 未来扰动测试 —— 补上截断等价性的盲区
 *
 * 为什么截断等价性不够：它只能发现「依赖于序列总长度」的泄漏，
 * 比如误写成 bars.slice(-250)（滚动窗口）—— 那种错在截断后窗口内容
 * 会变，净值立刻失配。
 *
 * 但如果实现是「固定多取 1 根」，即 bars.slice(0, t + 2)，那么：
 *   - 全量回测第 t 步用的是 bars[0..t+1]
 *   - 截断到第 k 根后第 t 步用的还是 bars[0..t+1]（t+1 < k 时）
 * 两份数据在同一个 t 上取的窗口完全一样，截断等价性**必然通过**，
 * 漏检率 100%。（我实测验证过：故意注入这个 bug，截断等价性测试全绿。）
 *
 * 所以必须有这一条：**扰动未来，过去必须纹丝不动**。
 * 做法：把第 K 根之后的所有价格乘以一个夸张的因子，重跑回测，
 * 断言第 K 根及之前的所有净值点与扰动前逐个完全相同。
 * 只要实现多读了未来任何一根，扰动就会通过那个数字渗进过去的净值。
 * ════════════════════════════════════════════════════════════════ */

test('防未来函数④b：扰动未来价格，过去每一步的决策输入必须纹丝不动', () => {
  // 直接审计「决策输入」，而不是只看净值。
  // 原因：净值是「现金 + 持股 × 收盘价」的市值口径，某日评分从 55 变成 57
  // 未必改变买卖动作，净值可能一动都不动 —— 那样就抓不到泄漏。
  // 所以这里用探针策略把每一步真正喂给策略的东西（窗口长度、末根价格、
  // 算出来的评分、streak）全部录下来，扰动未来后逐字段比对。
  const n = 300;
  const base = makeBars({ n, trendPct: 0.2, waveAmp: 3, wavePeriod: 25 });
  const cutIndex = 200;

  const perturbed = base.map((b, i) => {
    if (i < cutIndex) return { ...b };
    const f = 1 + ((i - cutIndex) % 7) * 1.5; // 1.0 ~ 10.0 倍
    return {
      ...b,
      open: Number((b.open * f).toFixed(2)),
      close: Number((b.close * f).toFixed(2)),
      high: Number((b.high * f).toFixed(2)),
      low: Number((b.low * f).toFixed(2)),
    };
  });

  /** 用探针跑一遍，录下每一步的决策输入快照。 */
  const record = (bars) => {
    const log = [];
    const probe = {
      name: 'audit-probe',
      onBar({ index, date, score, streaks, bars: window }) {
        log.push({
          index,
          date,
          score,
          windowLen: window.length,
          lastClose: window[window.length - 1].close,
          lastDate: window[window.length - 1].date,
          buyStreak: streaks.buy,
          sellStreak: streaks.sell,
        });
        return { action: 'hold', reason: '审计' };
      },
    };
    runBacktest({ bars, strategy: probe, options: { warmup: 60 } });
    return log;
  };

  const beforeLog = record(base);
  const afterLog = record(perturbed);

  assert.equal(afterLog.length, beforeLog.length, '决策步数不应因未来数据而改变');

  const cutDate = base[cutIndex].date;
  let compared = 0;
  for (let i = 0; i < beforeLog.length; i += 1) {
    const b = beforeLog[i];
    const a = afterLog[i];
    // 只比对截断点之前的步骤：这些步骤的「未来」被扰动过，结果必须不变
    if (b.date >= cutDate) break;
    compared += 1;

    assert.equal(a.date, b.date, `第 ${i} 步日期不应变化`);
    assert.equal(a.windowLen, b.windowLen, `第 ${i} 步（${b.date}）窗口长度不应变化`);
    assert.equal(a.lastDate, b.lastDate, `第 ${i} 步（${b.date}）窗口末根日期不应变化`);
    assert.equal(
      a.lastClose,
      b.lastClose,
      `第 ${i} 步（${b.date}）窗口末根收盘价从 ${b.lastClose} 变成 ${a.lastClose} —— ` +
        '窗口里混入了未来数据',
    );
    assert.equal(
      a.score,
      b.score,
      `第 ${i} 步（${b.date}）评分从 ${b.score} 变成 ${a.score} —— ` +
        '评分读到了未来数据（这是最隐蔽的泄漏方式）',
    );
    assert.equal(a.buyStreak, b.buyStreak, `第 ${i} 步（${b.date}）买入连续达标天数被未来数据影响`);
    assert.equal(a.sellStreak, b.sellStreak, `第 ${i} 步（${b.date}）卖出连续达标天数被未来数据影响`);
  }

  assert.ok(compared > 100, `应比对足够多的决策步，实际 ${compared}`);
});

test('防未来函数④b：只改动紧邻的下一根，当日决策输入必须完全不变', () => {
  // 最刁钻的情形：只把「明天」那一根改成 5 倍价，昨天的决策不许有任何变化。
  // 这一条专门盯 bars.slice(0, t + 2) 这类「固定多取一根」的写法 ——
  // 这种 bug 对截断等价性完全隐形，只有本测试能抓住。
  const n = 220;
  const base = makeBars({ n, trendPct: 0.25, waveAmp: 2, wavePeriod: 20 });
  const cutIndex = 170;

  const perturbed = base.map((b, i) => {
    if (i !== cutIndex) return { ...b };
    return {
      ...b,
      open: Number((b.open * 5).toFixed(2)),
      close: Number((b.close * 5).toFixed(2)),
      high: Number((b.high * 5).toFixed(2)),
      low: Number((b.low * 5).toFixed(2)),
    };
  });

  const record = (bars) => {
    const log = [];
    runBacktest({
      bars,
      strategy: {
        name: 'audit-probe',
        onBar({ index, date, score, bars: window }) {
          log.push({ index, date, score, lastClose: window[window.length - 1].close, windowLen: window.length });
          return { action: 'hold', reason: '审计' };
        },
      },
      options: { warmup: 60 },
    });
    return log;
  };

  const beforeLog = record(base);
  const afterLog = record(perturbed);
  const cutDate = base[cutIndex].date;

  let compared = 0;
  for (let i = 0; i < beforeLog.length; i += 1) {
    const b = beforeLog[i];
    const a = afterLog[i];
    if (b.date >= cutDate) break; // 只看 cutIndex 之前
    compared += 1;
    assert.equal(a.windowLen, b.windowLen, `第 ${i} 步窗口长度变化`);
    assert.equal(a.lastClose, b.lastClose, `第 ${i} 步（${b.date}）窗口末根收盘价被「明天」的数据污染`);
    assert.equal(a.score, b.score, `第 ${i} 步（${b.date}）评分被「明天」的数据污染：${b.score} → ${a.score}`);
  }
  assert.ok(compared > 80, `应比对足够多的决策步，实际 ${compared}`);
});

/* ════════════════════════════════════════════════════════════════
 * ⑤ 暴涨不可预知
 * ════════════════════════════════════════════════════════════════ */

test('防未来函数⑤：暴涨发生之前的净值，与「把暴涨之后全部删掉」的结果完全一致', () => {
  const surgeStart = 150;
  const withSurge = makeSurgeBars({ n: 200, surgeStart, surgeDays: 5, dailyPct: 12 });
  // 只保留到暴涨前一天
  const withoutSurge = withSurge.slice(0, surgeStart);

  const a = runBacktest({ bars: withSurge, options: { warmup: 60 } });
  const b = runBacktest({ bars: withoutSurge, options: { warmup: 60 } });
  assert.ok(a.ok && b.ok);

  // b 的全部净值点都应能在 a 的相同位置上找到
  assert.equal(b.equity.length, surgeStart - 59, `截至暴涨前应有 ${surgeStart - 59} 个净值点`);
  for (let i = 0; i < b.equity.length; i += 1) {
    assert.equal(
      a.equity[i].equity,
      b.equity[i].equity,
      `第 ${i} 个净值点（${b.equity[i].date}）在「有未来暴涨」与「没有未来暴涨」两种数据下应当相同，` +
        `实际 ${a.equity[i].equity} vs ${b.equity[i].equity}`,
    );
  }

  // 更直接的一点：暴涨日之前不能有任何一笔交易
  for (const t of a.trades) {
    assert.ok(
      t.entryDate >= withSurge[surgeStart].date,
      `建仓日 ${t.entryDate} 早于暴涨日 ${withSurge[surgeStart].date}，说明提前知道了未来`,
    );
  }
});

test('防未来函数⑤：暴涨前的信号不吃到暴涨收益（盈利必须来自暴涨之后）', () => {
  const surgeStart = 150;
  const bars = makeSurgeBars({ n: 200, surgeStart, surgeDays: 5, dailyPct: 12 });
  const r = runBacktest({ bars, options: { warmup: 60 } });
  assert.ok(r.ok);

  // 这段数据只有暴涨那几天在涨，其它时候完全横盘。
  // 正确实现只能买到暴涨后的价格，所以策略收益必然明显跑输「从头持有」。
  // 如果实现偷看未来，会在暴涨前建仓，收益就会接近甚至超过基准。
  assert.ok(
    r.stats.benchmarkReturn > 0,
    `测试前提：基准（全程持有）应盈利，实际 ${r.stats.benchmarkReturn}`,
  );
  assert.ok(
    r.stats.totalReturn < r.stats.benchmarkReturn,
    `策略收益 ${r.stats.totalReturn}% 应当低于基准 ${r.stats.benchmarkReturn}%：` +
      '暴涨不可预测，正确的实现只能在暴涨已发生后入场，必然错过第一段涨幅',
  );

  // 买入价必须是暴涨之后的价格，绝不能是横盘期的 100 元附近
  assert.ok(r.trades.length >= 1, '至少应有一笔交易');
  const entryPrice = r.trades[0].entryPrice;
  assert.ok(
    entryPrice > 100,
    `建仓价 ${entryPrice} 应显著高于横盘价 100 —— 若买在 100 附近，说明暴涨前就"预知"了行情`,
  );
});

/* ════════════════════════════════════════════════════════════════
 * 行情场景：上涨 / 下跌 / 横盘
 * ════════════════════════════════════════════════════════════════ */

test('上涨行情：策略应当盈利，且净值终值 == 初始资金 × (1+总收益率)', () => {
  const bars = makeBars({ n: 400, trendPct: 0.35 });
  const r = runBacktest({ bars, options: { warmup: 60 } });

  assert.ok(r.ok);
  assert.ok(r.trades.length >= 1, '单调上涨应触发买入');
  assert.ok(r.stats.totalReturn > 0, `单调上涨行情应盈利，实际 ${r.stats.totalReturn}%`);

  const lastEquity = r.equity[r.equity.length - 1].equity;
  const expected = DEFAULT_OPTIONS.initialCash * (1 + r.stats.totalReturn / 100);
  // totalReturn 是保留 2 位小数的百分数，反算回金额后允许 20 元误差
  // （30 万级别的净值上，0.01 个百分点的舍入就是 30 元量级）
  assert.ok(
    Math.abs(lastEquity - expected) < 20,
    `净值终点 ${lastEquity} 应与 初始资金×(1+总收益) = ${expected.toFixed(2)} 一致（误差 20 元内）`,
  );
});

test('下跌行情：策略应当亏损或全程空仓，绝不出现正收益', () => {
  const bars = makeBars({ n: 400, trendPct: -0.35 });
  const r = runBacktest({ bars, options: { warmup: 60 } });

  assert.ok(r.ok);
  // 两种都算合格：(a) 空仓无交易 → 收益 0；(b) 误入场 → 亏损
  if (r.trades.length === 0) {
    assert.equal(r.stats.totalReturn, 0, '全程空仓时收益应为 0');
    assert.equal(r.stats.winRate, null, '无交易时胜率应为 null 而不是 0 或 NaN');
    assert.equal(r.stats.profitFactor, null, '无交易时盈亏比应为 null');
  } else {
    assert.ok(
      r.stats.totalReturn <= 0,
      `单调下跌行情不应盈利，实际 ${r.stats.totalReturn}%`,
    );
  }
  assert.ok(r.stats.benchmarkReturn < 0, '基准（全程持有）在这段下跌行情中应为负收益');
});

test('横盘震荡：不应产生大量交易，收益接近 0', () => {
  // 振幅 1%、周期 20 天的正弦横盘：评分稳定在 46-54 之间，不会穿越 60/40 阈值。
  // 注意振幅不能太小之外也不能太大 —— 振幅 1.5%、周期 15 天那种斜率陡的正弦
  // 会被趋势类因子读成真实趋势，评分在 36-77 之间摆动，产生 20+ 笔交易。
  // 那属于「假趋势」，不是横盘样本。
  const bars = makeBars({ n: 400, trendPct: 0, waveAmp: 1, wavePeriod: 20 });
  const r = runBacktest({ bars, options: { warmup: 60 } });

  assert.ok(r.ok);
  // 横盘时评分类因子会向 50 分收敛，不该反复穿越 60/40 阈值
  assert.equal(r.trades.length, 0, `真正的横盘不该产生交易，实际 ${r.trades.length} 笔`);
  assert.equal(r.stats.totalReturn, 0, `横盘行情空仓时收益应为 0，实际 ${r.stats.totalReturn}%`);
});

/* ════════════════════════════════════════════════════════════════
 * 统计指标手工核对
 * ════════════════════════════════════════════════════════════════ */

test('统计指标：maxDrawdown 用已知净值序列手工核对（峰谷最大回撤）', () => {
  // 净值 100 → 150 → 120 → 200 → 100
  // 峰值 150 回撤到 120 = 20%；峰值 200 回撤到 100 = 50%（最大）
  const stats = computeStats({
    equity: [
      { date: '2024-01-01', equity: 100, benchmark: 100 },
      { date: '2024-02-01', equity: 150, benchmark: 100 },
      { date: '2024-03-01', equity: 120, benchmark: 100 },
      { date: '2024-04-01', equity: 200, benchmark: 100 },
      { date: '2024-05-01', equity: 100, benchmark: 100 },
    ],
    trades: [],
    initialCash: 100,
  });
  assert.equal(stats.maxDrawdown, 50, '应在峰值 200 处回撤到 100，最大回撤 50%');
});

test('统计指标：maxDrawdown 为正数，且单调上涨时为 0', () => {
  const up = computeStats({
    equity: [
      { date: '2024-01-01', equity: 100000 },
      { date: '2024-01-02', equity: 110000 },
      { date: '2024-01-03', equity: 120000 },
    ],
    trades: [],
    initialCash: 100000,
  });
  assert.equal(up.maxDrawdown, 0, '单调上涨没有回撤，应为 0（正数表示回撤幅度）');
  assert.equal(up.totalReturn, 20, '总收益应为 (120000/100000-1)*100 = 20');
});

test('统计指标：winRate 与 profitFactor 用已知交易手工核对', () => {
  const stats = computeStats({
    equity: [
      { date: '2024-01-01', equity: 100000 },
      { date: '2024-02-01', equity: 103000 },
    ],
    trades: [
      { pnl: 3000, holdDays: 10 },
      { pnl: -1000, holdDays: 4 },
      { pnl: 2000, holdDays: 16 },
    ],
    initialCash: 100000,
  });
  // 3 笔中 2 笔盈利 → 2/3 = 0.6667；总盈利 5000，总亏损 1000 → 盈亏比 5
  assert.equal(stats.winRate, 0.6667);
  assert.equal(stats.profitFactor, 5);
  assert.equal(stats.tradeCount, 3);
  assert.equal(stats.avgHoldDays, 10, '(10+4+16)/3 = 10');
});

test('统计指标：无交易时 winRate / profitFactor / avgHoldDays 均为 null，不是 0 或 NaN', () => {
  const stats = computeStats({
    equity: [
      { date: '2024-01-01', equity: 100000 },
      { date: '2024-01-02', equity: 100000 },
    ],
    trades: [],
    initialCash: 100000,
  });
  assert.equal(stats.winRate, null);
  assert.equal(stats.profitFactor, null);
  assert.equal(stats.avgHoldDays, null);
  assert.equal(stats.tradeCount, 0);
  assert.equal(stats.totalReturn, 0, '净值不变时总收益应为 0（不是 null）');
});

test('统计指标：annualReturn 按自然日复利折算', () => {
  // 正好 365 自然日、净值翻倍 → 年化恰好 100%
  const stats = computeStats({
    equity: [
      { date: '2024-01-01', equity: 100000 },
      { date: '2024-12-31', equity: 200000 }, // 365 天后
    ],
    trades: [],
    initialCash: 100000,
  });
  assert.equal(stats.annualReturn, 100, `整 365 天翻倍应年化 100%，实际 ${stats.annualReturn}`);

  // 半年（约 183 天）翻倍 → 年化约 300%（2^2-1）
  const half = computeStats({
    equity: [
      { date: '2024-01-01', equity: 100000 },
      { date: '2024-07-02', equity: 200000 }, // 183 天后
    ],
    trades: [],
    initialCash: 100000,
  });
  const expected = (Math.pow(2, 365 / 183) - 1) * 100;
  assert.ok(
    Math.abs(half.annualReturn - expected) < 0.1,
    `183 天翻倍的年化应为 ${expected.toFixed(2)}%，实际 ${half.annualReturn}%`,
  );
});

test('统计指标：sharpe 对带波动的上涨净值序列应为正且有限', () => {
  // 必须构造「收益有波动」的序列：若每日复利涨幅完全相同，
  // 日收益的标准差恰好为 0，夏普数学上无定义（实现会返回 null）。
  // 这里用 +0.2% / -0.05% 交替，制造真实存在的日波动。
  const equity = [];
  let v = 100000;
  const startMs = Date.parse('2024-01-01T00:00:00Z');
  for (let i = 0; i < 100; i += 1) {
    const d = new Date(startMs + i * 86400000);
    equity.push({ date: d.toISOString().slice(0, 10), equity: Math.round(v * 100) / 100 });
    v *= i % 2 === 0 ? 1.002 : 0.9995;
  }
  const stats = computeStats({ equity, trades: [], initialCash: 100000 });
  assert.ok(stats.sharpe > 0, `震荡上涨的净值序列夏普应为正，实际 ${stats.sharpe}`);
  assert.ok(Number.isFinite(stats.sharpe), '夏普必须是有限数字');

  // 手工核对：(mean/sd) × √252
  const rets = [];
  for (let i = 1; i < equity.length; i += 1) rets.push(equity[i].equity / equity[i - 1].equity - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
  const expected = (m / sd) * Math.sqrt(252);
  assert.ok(
    Math.abs(stats.sharpe - expected) < 0.01,
    `夏普应为 ${expected.toFixed(3)}，实际 ${stats.sharpe}`,
  );
});

test('统计指标：日收益恒定时 sharpe 退化为 null（标准差为 0，数学上无定义）', () => {
  // 每日恰好 +0.1% 的净值序列：标准差为 0，夏普 → ∞。
  // 实现必须返回 null 而不是 Infinity 或 NaN，否则序列化后前端会崩。
  const equity = [];
  let v = 100000;
  const startMs = Date.parse('2024-01-01T00:00:00Z');
  for (let i = 0; i < 100; i += 1) {
    const d = new Date(startMs + i * 86400000);
    equity.push({ date: d.toISOString().slice(0, 10), equity: v });
    v *= 1.001;
  }
  const stats = computeStats({ equity, trades: [], initialCash: 100000 });
  assert.equal(stats.sharpe, null, '标准差为 0 时夏普应返回 null');
  assert.equal(stats.totalReturn, 10.4, '总收益仍应正常计算');
});

test('统计指标：净值完全不变时 sharpe 为 null 而不是 Infinity', () => {
  const equity = [];
  const startMs = Date.parse('2024-01-01T00:00:00Z');
  for (let i = 0; i < 30; i += 1) {
    const d = new Date(startMs + i * 86400000);
    equity.push({ date: d.toISOString().slice(0, 10), equity: 100000 });
  }
  const stats = computeStats({ equity, trades: [], initialCash: 100000 });
  assert.equal(stats.sharpe, null, '日收益标准差为 0 时夏普无定义，应为 null');
});

test('统计指标：excessReturn = 策略收益 - 基准收益', () => {
  const r = runBacktest({ bars: makeBars({ n: 400, trendPct: 0.3 }), options: { warmup: 60 } });
  assert.ok(r.ok);
  const expected = Number((r.stats.totalReturn - r.stats.benchmarkReturn).toFixed(2));
  assert.equal(r.stats.excessReturn, expected);
});

/* ════════════════════════════════════════════════════════════════
 * 费用与滑点确实生效
 * ════════════════════════════════════════════════════════════════ */

test('费用：feeRate 越高收益越低，且必须真的被扣除', () => {
  // 用震荡行情制造多笔交易，让费用累积效果明显
  const bars = makeBars({ n: 400, trendPct: 0.05, waveAmp: 6, wavePeriod: 30 });

  const free = runBacktest({ bars, options: { warmup: 60, feeRate: 0, stampDuty: 0 } });
  const normal = runBacktest({ bars, options: { warmup: 60, feeRate: 0.0003, stampDuty: 0.001 } });
  const expensive = runBacktest({ bars, options: { warmup: 60, feeRate: 0.003, stampDuty: 0.001 } });

  assert.ok(free.ok && normal.ok && expensive.ok);
  assert.ok(normal.trades.length > 2, `测试前提：应产生多笔交易，实际 ${normal.trades.length}`);

  // 同样的信号、同样的数据，唯一的差别是费率 → 收益必须严格递减
  assert.ok(
    free.stats.totalReturn > normal.stats.totalReturn,
    `零费用收益 ${free.stats.totalReturn}% 应高于正常费率 ${normal.stats.totalReturn}%`,
  );
  assert.ok(
    normal.stats.totalReturn > expensive.stats.totalReturn,
    `正常费率 ${normal.stats.totalReturn}% 应高于高费率 ${expensive.stats.totalReturn}%`,
  );

  // 逐笔核对：同一笔交易在零费用下的盈亏必须严格大于有费用时
  assert.equal(free.trades.length, normal.trades.length, '费率不影响交易笔数（只影响金额）');
  for (let i = 0; i < free.trades.length; i += 1) {
    assert.equal(free.trades[i].entryDate, normal.trades[i].entryDate, `第 ${i} 笔建仓日应相同`);
    assert.ok(
      free.trades[i].pnl > normal.trades[i].pnl,
      `第 ${i} 笔零费用盈亏 ${free.trades[i].pnl} 应大于含费用 ${normal.trades[i].pnl}`,
    );
  }
});

test('费用：印花税只在卖出时收，买入不产生印花税', () => {
  const bars = makeBars({ n: 200, trendPct: 0.4 });
  const withTax = runBacktest({ bars, options: { warmup: 60, feeRate: 0, stampDuty: 0.01 } });
  const noTax = runBacktest({ bars, options: { warmup: 60, feeRate: 0, stampDuty: 0 } });

  assert.ok(withTax.ok && noTax.ok);
  assert.ok(withTax.trades.length >= 1, '应有交易');
  // 买入不扣印花税，所以「买入时的成本」两种设置下相同 → 持股数相同
  assert.equal(withTax.trades[0].shares, noTax.trades[0].shares, '买入不扣印花税，持股数应完全一致');
  // 卖出扣了印花税，同一笔的盈亏会更低
  assert.ok(
    withTax.trades[0].pnl < noTax.trades[0].pnl,
    `卖出收 1% 印花税后的盈亏 ${withTax.trades[0].pnl} 应低于零印花税 ${noTax.trades[0].pnl}`,
  );
});

test('滑点：买入价按 (1+slippage) 上浮，卖出价按 (1-slippage) 下调', () => {
  const bars = makeBars({ n: 200, trendPct: 0.4 });
  const noSlip = runBacktest({ bars, options: { warmup: 60, feeRate: 0, stampDuty: 0, slippage: 0 } });
  const slip = runBacktest({ bars, options: { warmup: 60, feeRate: 0, stampDuty: 0, slippage: 0.01 } });

  assert.ok(noSlip.ok && slip.ok);
  assert.ok(noSlip.trades.length >= 1 && slip.trades.length >= 1);

  const baseEntry = noSlip.trades[0].entryPrice;
  const slipEntry = slip.trades[0].entryPrice;
  assert.ok(
    Math.abs(slipEntry - baseEntry * 1.01) < 0.01,
    `1% 滑点后买入价应为 ${(baseEntry * 1.01).toFixed(4)}，实际 ${slipEntry}`,
  );
  assert.ok(slip.stats.totalReturn < noSlip.stats.totalReturn, '滑点会侵蚀收益');
});

test('费用：手续费按成交金额比例收取（万 3）', () => {
  // 单笔买入后立即用极端数据收尾，便于反推手续费
  const bars = makeBars({ n: 120, trendPct: 0.8 });
  const r = runBacktest({
    bars,
    options: { warmup: 60, feeRate: 0.0003, stampDuty: 0, slippage: 0, initialCash: 100000 },
  });
  assert.ok(r.ok);
  const t = r.trades[0];
  assert.ok(t, '应有交易');

  const grossCost = t.shares * t.entryPrice;
  const fee = grossCost * 0.0003;
  // 持仓成本 ≈ 成交金额 + 手续费 = 可用资金的绝大部分（按整手撮合会有零头）
  assert.ok(
    grossCost + fee <= 100000 + 1e-6,
    `成交金额 ${grossCost.toFixed(2)} + 手续费 ${fee.toFixed(2)} 不应超过初始资金 100000`,
  );
  assert.ok(
    grossCost + fee > 100000 - t.entryPrice * 100,
    '按整手撮合后剩余现金应不足一手，否则说明买入金额算错了',
  );
});

/* ════════════════════════════════════════════════════════════════
 * 边界：空数据 / 极少数据 / 脏数据 —— 绝不能抛异常
 * ════════════════════════════════════════════════════════════════ */

test('边界：bars 为空返回结构完整的 ok:false，不抛异常', () => {
  const r = runBacktest({ bars: [] });
  assert.equal(r.ok, false);
  assert.equal(r.bars, 0);
  assert.deepEqual(r.trades, []);
  assert.deepEqual(r.equity, []);
  assert.deepEqual(r.stats, {
    totalReturn: null,
    annualReturn: null,
    maxDrawdown: null,
    sharpe: null,
    winRate: null,
    profitFactor: null,
    tradeCount: 0,
    avgHoldDays: null,
    benchmarkReturn: null,
    excessReturn: null,
  });
  assert.ok(r.warnings.some((w) => w.includes('K 线为空')), '应说明 K 线为空');
  assert.equal(typeof r.strategy, 'string', 'strategy 字段仍应存在');
});

test('边界：bars 不是数组、入参为空、入参为 null 都不抛异常', () => {
  for (const input of [undefined, null, {}, { bars: null }, { bars: 'not-an-array' }, { bars: 42 }]) {
    assert.doesNotThrow(() => runBacktest(input), `入参 ${JSON.stringify(input)} 不应抛异常`);
    const r = runBacktest(input);
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.warnings) && r.warnings.length > 0, '应给出告警说明原因');
  }
});

test('边界：K 线少于 warmup+2 根返回 ok:false，并说明缺口', () => {
  const bars = makeBars({ n: 100, trendPct: 0.3 });
  const r = runBacktest({ bars, options: { warmup: 250 } });
  assert.equal(r.ok, false);
  assert.ok(
    r.warnings.some((w) => w.includes('250') && w.includes('252')),
    '告警应说明 warmup+2 = 252 根的门槛',
  );
});
test('边界：正好 warmup+2 根时能跑，但净值点极少、不可能完成完整交易', () => {
  // warmup=60、62 根数据 → 决策从第 60 根开始（下标 59），到最后一根（下标 61），
  // 共 3 个净值点。默认 confirmBars=2 需要连续 2 天达标才能买，而 62 根数据
  // 只给 3 个决策点，来不及「确认 → 次日成交 → 持仓」的完整流程。
  const bars = makeBars({ n: 62, trendPct: 0.5 });
  const r = runBacktest({ bars, options: { warmup: 60 } });

  assert.equal(r.ok, true, '62 根 = warmup+2，应当能跑');
  assert.equal(r.bars, 3, 'warmup=60、62 根数据 → 净值点为下标 59/60/61，共 3 个');
  assert.equal(r.skipped, 59, '预热期跳过 59 根');
  assert.equal(r.trades.length, 0, '数据刚好够门槛时无法完成一次完整交易');
});

test('边界：末根建仓不计入交易统计，只体现为期末持仓市值', () => {
  // 若买入恰好发生在最后一根，这笔「买入当天就虚拟平仓」的记录 holdDays=0、
  // 盈亏纯粹是手续费摩擦，不该污染胜率。用 confirmBars=1 让末根能建仓。
  const bars = makeBars({ n: 62, trendPct: 0.5 });
  const r = runBacktest({ bars, options: { warmup: 60, confirmBars: 1 } });

  assert.equal(r.ok, true);
  for (const t of r.trades) {
    assert.ok(
      t.holdDays === null || t.holdDays > 0,
      `不应出现 holdDays=0 的「同日买卖」交易记录，实际 ${JSON.stringify(t)}`,
    );
    assert.notEqual(t.entryDate, t.exitDate, '不应出现建仓日与平仓日相同的交易');
  }
});

test('边界：价格含 0 和 null 的脏数据被跳过并计入告警，不抛异常', () => {
  const bars = makeBars({ n: 200, trendPct: 0.3 });
  // 注入脏数据
  bars[70] = { ...bars[70], close: 0 };
  bars[80] = { ...bars[80], close: null };
  bars[90] = { ...bars[90], close: -5 };
  bars[100] = null;
  bars[110] = { ...bars[110], close: 'abc' };

  let r;
  assert.doesNotThrow(() => {
    r = runBacktest({ bars, options: { warmup: 60 } });
  }, '脏数据不应抛异常');

  assert.equal(r.ok, true, '部分脏数据不应导致整体失败');
  assert.ok(
    r.warnings.some((w) => w.includes('已剔除')),
    `应告警脏数据被剔除，实际告警：${JSON.stringify(r.warnings)}`,
  );
  assert.ok(r.skipped >= 5, `被剔除的根数应计入 skipped，实际 ${r.skipped}`);
  // 净值曲线不应出现 NaN
  for (const p of r.equity) {
    assert.ok(Number.isFinite(p.equity), `净值 ${p.equity} 在 ${p.date} 不是有限数字`);
  }
});

test('边界：停牌（成交量全为 0）照常计算但不产生交易，并有告警', () => {
  const bars = makeBars({ n: 200, trendPct: 0, volume: 0 });
  let r;
  assert.doesNotThrow(() => {
    r = runBacktest({ bars, options: { warmup: 60 } });
  });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('成交量为 0')), '应告警停牌');
  for (const p of r.equity) {
    assert.ok(Number.isFinite(p.equity), '停牌时净值仍应是有限数字');
  }
});

test('边界：参数非法时退回默认值而不是抛异常', () => {
  const bars = makeBars({ n: 300, trendPct: 0.3 });
  const cases = [
    { warmup: -5 },
    { warmup: 1.7 },
    { warmup: 'abc' },
    { initialCash: 0 },
    { initialCash: -1000 },
    { feeRate: -0.1 },
    { feeRate: 5 },
    { stampDuty: 'x' },
    { slippage: 99 },
    { thresholdBuy: 200 },
    { thresholdSell: -10 },
  ];
  for (const options of cases) {
    assert.doesNotThrow(
      () => runBacktest({ bars, options }),
      `options=${JSON.stringify(options)} 不应抛异常`,
    );
    const r = runBacktest({ bars, options });
    assert.equal(r.ok, true, `options=${JSON.stringify(options)} 应退回默认值后正常回测`);
    assert.ok(Array.isArray(r.warnings), 'warnings 必须是数组');
  }
});

test('边界：卖出阈值高于买入阈值时给出明确告警', () => {
  const bars = makeBars({ n: 300, trendPct: 0.3 });
  const r = runBacktest({ bars, options: { warmup: 60, thresholdBuy: 40, thresholdSell: 70 } });
  assert.ok(
    r.warnings.some((w) => w.includes('卖出阈值') && w.includes('买入阈值')),
    '应告警阈值设置反向',
  );
});

/* ════════════════════════════════════════════════════════════════
 * 策略注册表与 resolveStrategy
 * ════════════════════════════════════════════════════════════════ */

test('策略：内置三个策略，注册表结构完整且被冻结', () => {
  const names = Object.keys(STRATEGIES);
  assert.deepEqual(names.sort(), ['breakout', 'ma-cross', 'score-threshold']);

  for (const name of names) {
    const s = STRATEGIES[name];
    assert.equal(s.name, name, '注册表键必须等于策略自身的 name');
    assert.equal(typeof s.onBar, 'function', `${name} 必须有 onBar`);
    assert.equal(typeof s.label, 'string', `${name} 必须有中文标签`);
    assert.equal(typeof s.description, 'string', `${name} 必须有说明`);
    assert.ok(s.description.length > 10, `${name} 的说明应当是有意义的人话`);
    assert.ok(s.defaults && typeof s.defaults === 'object', `${name} 必须有默认参数`);
  }

  // 冻结：运行时改写不应生效
  assert.ok(Object.isFrozen(STRATEGIES), 'STRATEGIES 必须被冻结');
  assert.throws(() => {
    'use strict';
    STRATEGIES['score-threshold'] = null;
  }, '冻结后不应允许改写');
});

test('策略：resolveStrategy 按名取策略，参数覆盖 defaults', () => {
  const s = resolveStrategy('score-threshold');
  assert.equal(s.name, 'score-threshold');
  assert.equal(s.fellBack, false);
  assert.equal(s.params.thresholdBuy, 60);
  assert.equal(s.params.thresholdSell, 40);

  const custom = resolveStrategy('score-threshold', { thresholdBuy: 80, thresholdSell: 20 });
  assert.equal(custom.params.thresholdBuy, 80);
  assert.equal(custom.params.thresholdSell, 20);

  const ma = resolveStrategy('ma-cross');
  assert.equal(ma.params.fastPeriod, 5);
  assert.equal(ma.params.slowPeriod, 20);
});

test('策略：未知策略名退回默认策略，并在回测里留下明确告警', () => {
  const s = resolveStrategy('不存在的策略');
  assert.equal(s.name, 'score-threshold', '未知策略应退回默认策略');
  assert.equal(s.fellBack, true, '应标记为降级');
  assert.equal(s.requestedName, '不存在的策略', '应保留用户原本要的策略名');

  const bars = makeBars({ n: 300, trendPct: 0.3 });
  const r = runBacktest({ bars, strategy: '不存在的策略', options: { warmup: 60 } });
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'score-threshold', '结果里的 strategy 应是实际执行的策略');
  assert.ok(
    r.warnings.some((w) => w.includes('不存在的策略') && w.includes('退回')),
    '必须告警策略降级 —— 静默降级会让用户以为测的是另一个策略',
  );
});

test('策略：也支持传 { name, params } 和自定义 onBar 对象', () => {
  const bars = makeBars({ n: 300, trendPct: 0.3 });

  const byObject = runBacktest({ bars, strategy: { name: 'ma-cross', params: { slowPeriod: 10 } } });
  assert.equal(byObject.ok, true);
  assert.equal(byObject.strategy, 'ma-cross');

  let calls = 0;
  const custom = runBacktest({
    bars,
    strategy: {
      name: 'my-custom',
      onBar() {
        calls += 1;
        return { action: 'hold', reason: '自定义策略什么都不做' };
      },
    },
    options: { warmup: 60 },
  });
  assert.equal(custom.ok, true);
  assert.equal(custom.strategy, 'my-custom');
  assert.ok(calls > 200, `自定义 onBar 应被逐步调用，实际 ${calls} 次`);
  assert.equal(custom.trades.length, 0, '自定义策略不交易则不应有交易');
});

test('策略：自定义策略抛异常时不炸整个回测，该步按 hold 处理', () => {
  const bars = makeBars({ n: 200, trendPct: 0.3 });
  let nCalls = 0;
  const r = runBacktest({
    bars,
    strategy: {
      name: 'explosive',
      onBar() {
        nCalls += 1;
        if (nCalls === 5) throw new Error('故意炸一个');
        return { action: 'hold', reason: '' };
      },
    },
    options: { warmup: 60 },
  });
  assert.equal(r.ok, true);
  assert.ok(
    r.warnings.some((w) => w.includes('策略执行异常') && w.includes('故意炸一个')),
    '应告警策略异常并带上原始错误信息',
  );
});

test('策略：ma-cross 金叉建仓、死叉离场，交易理由含交叉描述', () => {
  // 三段式行情：跌（制造死叉状态）→ 涨（金叉建仓）→ 跌（死叉离场）。
  // 必须让末段下跌，否则唯一一笔会是「期末虚拟平仓」，验证不到死叉离场。
  const bars = makeBars({ n: 300, trendPct: 0 });
  let p = 100;
  for (let i = 0; i < 300; i += 1) {
    let mult = 1;
    if (i < 90) mult = 0.995; // 前 90 天阴跌
    else if (i < 200) mult = 1.012; // 中段持续上涨，形成金叉
    else mult = 0.985; // 末段下跌，形成死叉
    const open = p;
    const close = Number((p * mult).toFixed(2));
    bars[i] = {
      date: bars[i].date,
      open: Number(open.toFixed(2)),
      close,
      high: Number(Math.max(open, close).toFixed(2)),
      low: Number(Math.min(open, close).toFixed(2)),
      volume: 100000,
    };
    p = close;
  }

  const r = runBacktest({ bars, strategy: 'ma-cross', options: { warmup: 40 } });
  assert.equal(r.ok, true);
  assert.ok(r.trades.length >= 1, '先跌后涨应形成金叉并建仓');

  const closedByCross = r.trades.filter((t) => t.reason.includes('死叉'));
  assert.ok(closedByCross.length >= 1, `应有至少一笔因死叉离场的交易，实际理由：${JSON.stringify(r.trades.map((t) => t.reason))}`);

  const t = closedByCross[0];
  // 入场理由记在 entryReason（金叉），离场理由记在 reason（死叉），两者都要可读
  assert.ok(t.entryReason && t.entryReason.includes('金叉'), `entryReason 应说明金叉，实际 ${t.entryReason}`);
  assert.ok(t.reason.includes('下穿'), '离场理由应说明均线下穿');
  assert.ok(t.entryPrice > 0 && t.exitPrice > 0, '成交价必须为正');
  assert.ok(r.stats.totalReturn > 0, `金叉建仓后赶上上涨应盈利，实际 ${r.stats.totalReturn}%`);
});

test('策略：breakout 突破建仓、跌破离场，理由文案含具体价位', () => {
  // 三段式：横盘 → 向上突破 → 跌破止损位。
  // 末段必须跌，才能验证「跌破前 10 日最低价」的离场路径。
  const bars = makeBars({ n: 300, trendPct: 0 });
  let p = 100;
  for (let i = 0; i < 300; i += 1) {
    let mult = 1;
    if (i < 120) mult = 1 + 0.001 * 2; // 缓慢横盘
    else if (i < 200) mult = 1.02; // 向上突破
    else mult = 0.96; // 跌破离场
    const open = p;
    const close = Number((p * mult).toFixed(2));
    bars[i] = {
      date: bars[i].date,
      open: Number(open.toFixed(2)),
      close,
      high: Number(Math.max(open, close).toFixed(2)),
      low: Number(Math.min(open, close).toFixed(2)),
      volume: 100000,
    };
    p = close;
  }

  const r = runBacktest({ bars, strategy: 'breakout', options: { warmup: 40 } });
  assert.equal(r.ok, true);
  assert.ok(r.trades.length >= 1, '向上突破应建仓');

  const t = r.trades.find((x) => x.reason.includes('跌破'));
  assert.ok(t, `应有因跌破离场的交易，实际理由：${JSON.stringify(r.trades.map((x) => x.reason))}`);
  assert.ok(t.reason.includes('前 10 日最低价'), '离场理由应包含具体止损口径');
  assert.ok(t.entryReason && t.entryReason.includes('突破前 20 日最高价'), `entryReason 应说明突破，实际 ${t.entryReason}`);
  // 理由里必须带具体数字，不能只说「跌破」
  assert.match(t.reason, /\d+\.\d+/, '理由文案应含具体价位数字');
  assert.match(t.entryReason, /\d+\.\d+/, '入场理由应含具体价位数字');
  assert.ok(r.stats.totalReturn > 0, `突破策略在这段行情应盈利，实际 ${r.stats.totalReturn}%`);
});

/* ════════════════════════════════════════════════════════════════
 * 结果结构与契约
 * ════════════════════════════════════════════════════════════════ */

test('结构：BacktestResult 字段完整，trades 与 equity 元素字段齐全', () => {
  const r = runBacktest({
    bars: makeBars({ n: 300, trendPct: 0.35 }),
    options: { warmup: 60 },
  });
  assert.equal(r.ok, true);

  for (const key of ['ok', 'strategy', 'startDate', 'endDate', 'bars', 'skipped', 'trades', 'equity', 'stats', 'warnings']) {
    assert.ok(key in r, `BacktestResult 缺少字段 ${key}`);
  }

  assert.equal(typeof r.strategy, 'string');
  assert.match(r.startDate, /^\d{4}-\d{2}-\d{2}$/, 'startDate 应是 YYYY-MM-DD');
  assert.match(r.endDate, /^\d{4}-\d{2}-\d{2}$/, 'endDate 应是 YYYY-MM-DD');
  assert.ok(r.startDate <= r.endDate, '起始日不应晚于结束日');
  assert.equal(typeof r.bars, 'number');
  assert.equal(typeof r.skipped, 'number');

  // stats 十个字段一个不能少
  for (const key of [
    'totalReturn', 'annualReturn', 'maxDrawdown', 'sharpe', 'winRate',
    'profitFactor', 'tradeCount', 'avgHoldDays', 'benchmarkReturn', 'excessReturn',
  ]) {
    assert.ok(key in r.stats, `stats 缺少字段 ${key}`);
  }

  // equity 元素
  for (const p of r.equity) {
    assert.ok('date' in p && 'equity' in p && 'benchmark' in p, 'equity 元素必须有 date/equity/benchmark');
  }

  // trades 元素
  for (const t of r.trades) {
    for (const key of [
      'entryDate', 'entryPrice', 'exitDate', 'exitPrice', 'shares',
      'pnl', 'pnlPercent', 'holdDays', 'entryScore', 'exitScore', 'reason',
    ]) {
      assert.ok(key in t, `trade 缺少字段 ${key}`);
    }
    assert.ok(t.shares > 0, '持股数必须为正');
    assert.ok(t.exitDate >= t.entryDate, '平仓日不得早于建仓日');
    assert.ok(t.holdDays === null || t.holdDays >= 0, '持仓天数应为非负数或 null');
  }
});

test('结构：所有数值字段不含 NaN / Infinity', () => {
  const scenarios = [
    makeBars({ n: 300, trendPct: 0.35 }),
    makeBars({ n: 300, trendPct: -0.35 }),
    makeBars({ n: 300, trendPct: 0, waveAmp: 3 }),
    makeBars({ n: 300, trendPct: 0, volume: 0 }),
  ];
  for (const bars of scenarios) {
    const r = runBacktest({ bars, options: { warmup: 60 } });
    const walk = (obj, path) => {
      if (obj === null) return;
      if (typeof obj === 'number') {
        assert.ok(Number.isFinite(obj), `${path} = ${obj} 不是有限数字`);
        return;
      }
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
      }
    };
    walk(r.stats, 'stats');
    walk(r.equity, 'equity');
    walk(r.trades, 'trades');
  }
});

test('结构：净值曲线长度 == bars 字段，且日期严格升序不重复', () => {
  const r = runBacktest({ bars: makeBars({ n: 350, trendPct: 0.2, waveAmp: 2 }), options: { warmup: 80 } });
  assert.ok(r.ok);
  assert.equal(r.equity.length, r.bars, 'equity 长度应等于 bars 字段');
  assert.equal(r.bars, 350 - 79, 'warmup=80 → 从第 80 根开始，共 271 个净值点');

  for (let i = 1; i < r.equity.length; i += 1) {
    assert.ok(
      r.equity[i].date > r.equity[i - 1].date,
      `净值日期应严格升序：${r.equity[i - 1].date} -> ${r.equity[i].date}`,
    );
  }
});

test('结构：必须带免责声明，强调历史表现不代表未来', () => {
  const r = runBacktest({ bars: makeBars({ n: 300, trendPct: 0.3 }), options: { warmup: 60 } });
  assert.equal(r.disclaimer, DISCLAIMER);
  assert.ok(r.disclaimer.includes('历史表现不代表未来'), '免责声明必须点明历史表现不代表未来');
  assert.ok(r.disclaimer.includes('过拟合'), '免责声明必须点明过拟合风险');
  assert.ok(r.disclaimer.includes('不构成任何投资建议'), '免责声明必须声明非投资建议');
});

test('结构：skipped 口径 = 预热期 + 剔除的脏数据 + 无法成交的信号', () => {
  // 无脏数据、无末根信号 → skipped 只应包含预热期
  const clean = runBacktest({ bars: makeBars({ n: 200, trendPct: 0 }), options: { warmup: 60 } });
  assert.equal(clean.skipped, 59, 'warmup=60 且无其他跳过项时，skipped 应等于 59');

  // 注入 3 根脏数据 → skipped 增加 3
  const dirty = makeBars({ n: 200, trendPct: 0 });
  dirty[70] = { ...dirty[70], close: 0 };
  dirty[90] = { ...dirty[90], close: null };
  dirty[110] = null;
  const r = runBacktest({ bars: dirty, options: { warmup: 60 } });
  assert.equal(r.skipped, 59 + 3, `3 根脏数据时应为 62，实际 ${r.skipped}`);
});

/* ════════════════════════════════════════════════════════════════
 * 末根信号无法成交
 * ════════════════════════════════════════════════════════════════ */

test('末根信号：最后一根产生买入信号时无法成交，计入 skipped 并告警', () => {
  // 构造「前 99 根横盘（评分中性），最后一根暴力拉升」的数据。
  // 用 confirmBars: 1，否则末根的孤立暴涨因凑不满连续确认天数而根本不算信号，
  // 就验证不到「信号产生但无法成交」这条路径。
  const n = 100;
  const bars = makeBars({ n, trendPct: 0, waveAmp: 1 });
  const last = bars[n - 1];
  last.open = bars[n - 2].close;
  last.close = Number((last.open * 1.35).toFixed(2)); // 最后一根暴涨 35%
  last.high = last.close;

  // 确认最后一根确实产生了买入信号
  const scoreLast = evaluateStock({ bars }).score;
  assert.ok(
    scoreLast >= DEFAULT_OPTIONS.thresholdBuy,
    `测试前提：最后一根评分 ${scoreLast} 应达到买入阈值`,
  );

  const r = runBacktest({ bars, options: { warmup: 60, confirmBars: 1 } });
  assert.equal(r.ok, true);
  assert.ok(
    r.warnings.some((w) => w.includes('最后一根 K 线') && w.includes('无次日开盘价')),
    `应告警末根信号无法成交，实际告警：${JSON.stringify(r.warnings)}`,
  );
  assert.equal(r.trades.length, 0, '末根信号无法成交，不应产生已平仓交易');
  // skipped = 预热 59 + 末根作废信号 1 = 60
  assert.equal(r.skipped, 60, '末根作废的信号应计入 skipped');
});

test('末根信号：confirmBars=2 时末根孤立暴涨不构成信号，不应产生末根作废告警', () => {
  // 反过来验证确认机制的一个正面作用：只有一天的孤立暴涨不会被当成信号，
  // 因此也不会有「信号无法成交」的浪费。
  const n = 100;
  const bars = makeBars({ n, trendPct: 0, waveAmp: 1 });
  const last = bars[n - 1];
  last.open = bars[n - 2].close;
  last.close = Number((last.open * 1.35).toFixed(2));
  last.high = last.close;

  const r = runBacktest({ bars, options: { warmup: 60, confirmBars: 2 } });
  assert.equal(r.ok, true);
  assert.equal(r.trades.length, 0);
  assert.equal(r.skipped, 59, '没有末根作废信号时，skipped 只含预热期 59 根');
  assert.ok(
    !r.warnings.some((w) => w.includes('最后一根 K 线')),
    '单日暴涨不满足 2 日确认，不该出现「末根信号无法成交」的告警',
  );
});

/* ════════════════════════════════════════════════════════════════
 * 纯函数性
 * ════════════════════════════════════════════════════════════════ */

test('纯函数：不修改输入 bars，两次调用结果完全相同', () => {
  const bars = makeBars({ n: 300, trendPct: 0.3, waveAmp: 2 });
  const snapshot = JSON.stringify(bars);

  const r1 = runBacktest({ bars, options: { warmup: 60 } });
  const afterFirst = JSON.stringify(bars);
  assert.equal(afterFirst, snapshot, '回测不应修改输入 bars');

  const r2 = runBacktest({ bars, options: { warmup: 60 } });
  assert.equal(JSON.stringify(equityTuples(r2)), JSON.stringify(equityTuples(r1)), '两次调用净值应完全相同');
  assert.deepEqual(r2.trades, r1.trades, '两次调用交易明细应完全相同');
  assert.deepEqual(r2.stats, r1.stats, '两次调用统计应完全相同');
  assert.equal(JSON.stringify(bars), snapshot, '第二次调用后输入仍不应被修改');
});

test('纯函数：调用方传入的 options 对象不被改写', () => {
  const options = { warmup: 60, feeRate: 0.001, thresholdBuy: 70 };
  const snapshot = JSON.stringify(options);
  runBacktest({ bars: makeBars({ n: 200, trendPct: 0.3 }), options });
  assert.equal(JSON.stringify(options), snapshot, 'options 不应被回测改写');
});

/* ════════════════════════════════════════════════════════════════
 * 阈值参数确实生效
 * ════════════════════════════════════════════════════════════════ */

test('confirmBars：默认值为 2，且可通过 options 覆盖', () => {
  const st = resolveStrategy('score-threshold');
  assert.equal(st.params.confirmBars, 2, 'score-threshold 的 confirmBars 默认应为 2');

  // ma-cross / breakout 是跨多日的指标事件，不需要也不应该收到 confirmBars
  assert.equal('confirmBars' in resolveStrategy('ma-cross').params, false, 'ma-cross 不应有 confirmBars 参数');
  assert.equal('confirmBars' in resolveStrategy('breakout').params, false, 'breakout 不应有 confirmBars 参数');
});

test('confirmBars：1 与 2 在同一段横盘数据上交易数不同，确认机制确实抑制噪声', () => {
  // 用一段周期 25 天、振幅 1.5% 的横盘：单日穿越会产生 14 笔噪声交易，
  // 2 日确认后压到 1 笔。
  const bars = makeBars({ n: 400, trendPct: 0, waveAmp: 1.5, wavePeriod: 25 });

  const cb1 = runBacktest({ bars, options: { warmup: 60, confirmBars: 1 } });
  const cb2 = runBacktest({ bars, options: { warmup: 60, confirmBars: 2 } });

  assert.ok(cb1.ok && cb2.ok);
  assert.ok(cb1.trades.length >= 10, `confirmBars=1 应产生较多噪声交易，实际 ${cb1.trades.length}`);
  assert.ok(
    cb2.trades.length < cb1.trades.length,
    `confirmBars=2 的交易数 ${cb2.trades.length} 应少于 confirmBars=1 的 ${cb1.trades.length}`,
  );
  assert.ok(
    cb2.stats.totalReturn > cb1.stats.totalReturn,
    `抑制噪声后收益应改善：confirmBars=2 的 ${cb2.stats.totalReturn}% vs confirmBars=1 的 ${cb1.stats.totalReturn}%`,
  );
});

test('confirmBars：0 与 1 行为等价（都表示不做确认）', () => {
  const bars = makeBars({ n: 400, trendPct: 0, waveAmp: 1.5, wavePeriod: 25 });
  const cb0 = runBacktest({ bars, options: { warmup: 60, confirmBars: 0 } });
  const cb1 = runBacktest({ bars, options: { warmup: 60, confirmBars: 1 } });

  assert.equal(cb0.trades.length, cb1.trades.length, 'confirmBars=0 与 =1 应产生相同交易数');
  assert.equal(cb0.stats.totalReturn, cb1.stats.totalReturn, 'confirmBars=0 与 =1 收益应相同');
});

test('confirmBars：确认机制不削弱强趋势行情的捕获（趋势持续数周，2 日确认无所谓）', () => {
  // 单调上涨的强趋势：确认期只让入场晚 1 天，收益略降但仍在同一量级
  const bars = makeBars({ n: 400, trendPct: 0.35 });
  const cb1 = runBacktest({ bars, options: { warmup: 60, confirmBars: 1 } });
  const cb2 = runBacktest({ bars, options: { warmup: 60, confirmBars: 2 } });

  assert.ok(cb1.ok && cb2.ok);
  assert.ok(cb1.trades.length >= 1 && cb2.trades.length >= 1, '两种设置都应建仓');
  assert.ok(cb2.trades[0].entryDate >= cb1.trades[0].entryDate, '确认机制只会让入场更晚，不会更早');
  assert.ok(
    Math.abs(cb2.stats.totalReturn - cb1.stats.totalReturn) < 5,
    `强趋势下 2 日确认的收益损失应可接受：${cb2.stats.totalReturn}% vs ${cb1.stats.totalReturn}%`,
  );
});

test('confirmBars：非法值退回默认，不抛异常', () => {
  const bars = makeBars({ n: 300, trendPct: 0.3 });
  for (const cb of [-1, 1.9, 100, 'abc', null]) {
    assert.doesNotThrow(
      () => runBacktest({ bars, options: { warmup: 60, confirmBars: cb } }),
      `confirmBars=${String(cb)} 不应抛异常`,
    );
    const r = runBacktest({ bars, options: { warmup: 60, confirmBars: cb } });
    assert.equal(r.ok, true, `confirmBars=${String(cb)} 应正常回测`);
  }
});

test('阈值：买入阈值越高，建仓越晚或越少', () => {
  const bars = makeBars({ n: 400, trendPct: 0.3, waveAmp: 3, wavePeriod: 25 });

  const low = runBacktest({ bars, options: { warmup: 60, thresholdBuy: 55, thresholdSell: 30 } });
  const high = runBacktest({ bars, options: { warmup: 60, thresholdBuy: 80, thresholdSell: 30 } });

  assert.ok(low.ok && high.ok);
  assert.ok(low.trades.length >= 1, '低阈值应至少建仓一次');
  if (high.trades.length > 0) {
    assert.ok(
      high.trades[0].entryDate >= low.trades[0].entryDate,
      `高阈值建仓日 ${high.trades[0].entryDate} 不应早于低阈值建仓日 ${low.trades[0].entryDate}`,
    );
  }
});

test('阈值：初始资金影响持股数，但不影响收益率（按比例缩放）', () => {
  const bars = makeBars({ n: 400, trendPct: 0.35 });
  const small = runBacktest({ bars, options: { warmup: 60, initialCash: 50000 } });
  const large = runBacktest({ bars, options: { warmup: 60, initialCash: 500000 } });

  assert.ok(small.ok && large.ok);
  assert.ok(small.trades.length >= 1 && large.trades.length >= 1);
  assert.ok(large.trades[0].shares > small.trades[0].shares, '资金多则应买到更多股');

  // 收益率应基本一致（整手撮合会带来微小差异）
  assert.ok(
    Math.abs(small.stats.totalReturn - large.stats.totalReturn) < 1,
    `不同初始资金的收益率应基本一致：${small.stats.totalReturn}% vs ${large.stats.totalReturn}%`,
  );
});

/* ════════════════════════════════════════════════════════════════
 * 性能护栏
 * ════════════════════════════════════════════════════════════════ */

test('性能：1251 根数据的滚动回测在合理时间内完成（纯函数才有这个速度）', () => {
  // 真实回测的典型规模：1251 根 K 线。用默认 warmup，决策步数由它决定。
  const bars = makeBars({ n: 1251, trendPct: 0.05, waveAmp: 3, wavePeriod: 25 });
  const t0 = Date.now();
  const r = runBacktest({ bars, strategy: 'score-threshold' });
  const ms = Date.now() - t0;

  assert.equal(r.ok, true);
  // 净值点数 = n - (warmup - 1)，不硬编码 warmup —— 它可能被调成 120 或 250
  assert.equal(
    r.bars,
    1251 - (DEFAULT_OPTIONS.warmup - 1),
    `默认 warmup=${DEFAULT_OPTIONS.warmup} → 应有 ${1251 - (DEFAULT_OPTIONS.warmup - 1)} 个净值点`,
  );
  assert.equal(r.skipped, DEFAULT_OPTIONS.warmup - 1, 'skipped 应等于预热期根数');
  assert.ok(ms < 15000, `1251 根数据的回测耗时 ${ms}ms，超出 15 秒护栏（说明实现有性能退化）`);
});
