/**
 * dsh-astock / lib/backtest.js
 * 单标的滚动回测引擎。
 *
 * ── 为什么需要这个文件 ─────────────────────────────────────────────
 * lib/score.js 给出的只是「此刻」的多因子快照。用户真正想问的是：
 * 如果我历史上一直按这套纪律操作，结果会怎样？回测就是回答这个问题。
 * 但回测同时也是最容易把自己骗到的模块 —— 一个不小心的
 * bars.slice(-250) 就能把未来数据喂进信号里，让收益率漂亮到 100%+，
 * 而实盘完全是另一回事。所以本文件的第一设计目标不是「跑得快」，
 * 而是「不撒谎」。
 *
 * ── 防未来函数的四道保险 ─────────────────────────────────────────
 *  1) 滚动窗口：第 t 日的决策只把 bars.slice(0, t + 1) 交给策略与评分
 *     引擎。slice 剪出来的是**新数组**，策略对象拿不到原数组的引用，
 *     物理上不可能读到第 t 日之后的数据。
 *  2) 成交前置：第 t 日收盘产生的信号，只能用第 t+1 日的开盘价成交。
 *     A 股 T+1，且当日收盘价买入在现实中不存在（收盘时你才知道信号）。
 *  3) 顺序固定：每轮循环严格按四步走，不许调换 ——
 *     「执行昨日挂起信号（用今日开盘价）→ 用今日窗口算今日信号 →
 *       记今日收盘净值 → 把今日信号挂起到明日」。
 *     净值记录在信号挂起之前，所以当日净值不包含当日信号的成交，符合现实。
 *  4) 测试兜底：tests/backtest.test.mjs 用「截断等价性」验证 —— 把数据
 *     截断到第 k 根重跑一遍，前 k 根内的全部交易与净值必须与全量回测
 *     逐个完全相同。只要实现里有任何一丝未来数据泄漏，这个断言立刻失败。
 *
 * ── 纯函数 ───────────────────────────────────────────────────────
 * 不联网、不读文件、不读环境变量、零 npm 依赖。所以 1251 步滚动回测
 * （每步一次完整评分）能在 300ms 量级跑完，而且能脱离网络做单元测试。
 * 数据获取与计算必须彻底分离 —— 一旦回测里掺杂网络请求或缓存，
 * 性能会掉两三个数量级，且再也无法单测。
 *
 * ── 免责 ─────────────────────────────────────────────────────────
 * 回测结果是历史数据的机械计算结果。历史表现不代表未来收益，
 * 参数反复调优极易过拟合。本模块刻意不提供参数寻优功能。
 */

import { evaluateStock, computeIndicators } from './score.js';

/* ════════════════════════════════════════════════════════════════
 * 0. 常量与文案
 * ════════════════════════════════════════════════════════════════ */

/**
 * 默认引擎参数。
 *
 * warmup 取 120 而不是 250 的理由：
 *   score.js 是**按数据量分级降级**的——30 根就能出分（60 日均线不可得），
 *   60 根补上 60 日均线，250 根才有 250 日高低点。
 *
 *   注意回测窗口是**累积**的（bars.slice(0, t+1)），不是滚动窗口：
 *   第 t 步的窗口长度就是 t+1。所以 warmup 只决定「前多少步不参与决策」，
 *   一旦跨过 250 步，warmup=120 与 warmup=250 的窗口完全相同。warmup 越大
 *   丢掉的决策点越多（1200 根数据下 250 会丢掉约 20%），但前 120~249 步的
 *   position/risk 因子（依赖 250 日高低点）确实会被削弱。
 *
 *   这里默认 120 是权衡：120 根已能让 MA60 / MACD / BOLL / ATR 全部就位，
 *   而 score.js 自己会在 dataQuality.warnings 里如实标注降级，不会静默弱化。
 *   **想要严格口径的用户可以自己传 warmup: 250**（见 options.warmup），
 *   250 能保证每一个决策步的窗口都够 250 日高低点用。
 */
export const DEFAULT_OPTIONS = Object.freeze({
  warmup: 120,
  initialCash: 100000,
  feeRate: 0.0003,
  stampDuty: 0.001,
  slippage: 0,
  thresholdBuy: 60,
  thresholdSell: 40,
  confirmBars: 2,
});

/** 默认策略名。未知策略名会静默退回它，但会在 warnings 里留痕。 */
export const DEFAULT_STRATEGY = 'score-threshold';

/**
 * 固定免责声明。
 * 说明：BacktestResult 的字段表里没有 disclaimer，这里是**契约外的附加字段**。
 * 保留它是因为 QUANT.md 7.1 要求「回测结果具有误导性」这一点必须在结果里
 * 强制标注，且强度要与 score.js 的免责声明对齐。附加字段不影响既有消费方。
 */
export const DISCLAIMER =
  '回测结果基于历史行情与固定策略参数做机械计算，历史表现不代表未来收益。策略参数经过反复调整后得到的漂亮曲线通常是过拟合，不具预测力。本模块刻意不提供参数寻优，所有指标不构成任何投资建议。';

/** A 股一手 = 100 股。买入时优先按整手撮合，小资金才退化为零股。 */
const LOT_SIZE = 100;

/** 一年的交易日数，夏普年化用。 */
const TRADING_DAYS_PER_YEAR = 252;

/** 一年自然日数，年化收益折算用。 */
const DAYS_PER_YEAR = 365;

/** 一天的毫秒数。 */
const MS_PER_DAY = 86400000;

/* ════════════════════════════════════════════════════════════════
 * 1. 基础数值工具（与 score.js 同风格）
 * ════════════════════════════════════════════════════════════════ */

/** 转成有限数字，否则 null。空串/NaN/Infinity/对象一律 null。 */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 是否有限数字。 */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 转字符串，非字符串返回空串。 */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 保留小数位，非有限返回 null。-0 归一为 0。
 * 输出前统一 round，避免 0.30000000000000004 这类浮点尾巴污染 JSON。
 */
function round(v, digits = 2) {
  if (!isNum(v)) return null;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f + 0;
}

function mean(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/** 样本标准差（除以 n-1）。与 score.js 的 BOLL 口径保持一致。 */
function stdev(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  const m = mean(arr);
  let acc = 0;
  for (const v of arr) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (n - 1));
}

/**
 * 两个 'YYYY-MM-DD' 之间的自然日差。
 * 解析失败返回 null —— holdDays 宁可缺，也不要给一个假的 0。
 */
function naturalDays(fromDate, toDate) {
  const a = Date.parse(`${str(fromDate)}T00:00:00Z`);
  const b = Date.parse(`${str(toDate)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/* ════════════════════════════════════════════════════════════════
 * 2. 输入规范化
 * ════════════════════════════════════════════════════════════════ */

/**
 * 规范化单根 K 线。收盘价无效（null/0/负/非数）的整根丢弃，
 * 因为任何收益率、均线在它上面都会算出无意义的值。
 *
 * open/high/low 缺失时用 close 兜底（与 score.js 的 normalizeBars 完全一致），
 * 这样回测里算出来的指标和面板上看到的一致 —— 两边口径不同会让用户困惑。
 *
 * @returns {object|null} null 表示该根不可用
 */
function normalizeBar(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const close = num(raw.close);
  if (close === null || close <= 0) return null;

  const openRaw = num(raw.open);
  const highRaw = num(raw.high);
  const lowRaw = num(raw.low);
  const volumeRaw = num(raw.volume);

  // open 缺失时用 close 填充，但要留痕：成交价用 close 替补必须在 warnings 里说清楚
  const openMissing = !(openRaw !== null && openRaw > 0);
  const open = openMissing ? close : openRaw;
  const high = Math.max(close, open, highRaw !== null && highRaw > 0 ? highRaw : close);
  const low = Math.min(close, open, lowRaw !== null && lowRaw > 0 ? lowRaw : close);
  const volume = volumeRaw !== null && volumeRaw >= 0 ? volumeRaw : 0;

  return { date: str(raw.date), open, close, high, low, volume, openMissing };
}

/**
 * 规范化整个 K 线序列。
 * 只做「剔除不可用」和「数值兜底」，**不做排序**：顺序错了要让调用方知道
 * （回测结果会明显异常并在 warnings 里报出来），而不是偷偷修好。
 */
function normalizeBars(rawList) {
  const bars = [];
  let invalid = 0;
  const invalidDates = [];
  for (const raw of rawList) {
    const bar = normalizeBar(raw);
    if (!bar) {
      invalid += 1;
      if (invalidDates.length < 5 && raw && typeof raw === 'object') {
        invalidDates.push(str(raw.date) || '(无日期)');
      }
      continue;
    }
    bars.push(bar);
  }
  return { bars, invalid, invalidDates };
}

/**
 * 规范化引擎参数。任何非法值都退回默认值而不是抛异常 ——
 * 回测是「多一步计算就多一分误导」的模块，宁可按默认参数跑出带告警的结果，
 * 也不要让用户拿到一个空白页面。
 */
function normalizeOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];

  const warmupRaw = num(o.warmup);
  let warmup = warmupRaw === null ? DEFAULT_OPTIONS.warmup : Math.floor(warmupRaw);
  if (!(warmup >= 2)) {
    if (warmupRaw !== null) warnings.push(`warmup=${String(o.warmup)} 非法（需 ≥ 2 的整数），已退回默认 ${DEFAULT_OPTIONS.warmup}`);
    warmup = DEFAULT_OPTIONS.warmup;
  }

  const cashRaw = num(o.initialCash);
  let initialCash = cashRaw === null ? DEFAULT_OPTIONS.initialCash : cashRaw;
  if (!(initialCash > 0)) {
    if (cashRaw !== null) warnings.push(`initialCash=${String(o.initialCash)} 非法（需 > 0），已退回默认 ${DEFAULT_OPTIONS.initialCash}`);
    initialCash = DEFAULT_OPTIONS.initialCash;
  }

  const pickRate = (key) => {
    const v = num(o[key]);
    if (v === null) return DEFAULT_OPTIONS[key];
    if (v < 0 || v >= 1) {
      warnings.push(`${key}=${String(o[key])} 超出 [0, 1) 合理区间，已退回默认 ${DEFAULT_OPTIONS[key]}`);
      return DEFAULT_OPTIONS[key];
    }
    return v;
  };

  const pickScore = (key) => {
    const v = num(o[key]);
    if (v === null) return DEFAULT_OPTIONS[key];
    if (v < 0 || v > 100) {
      warnings.push(`${key}=${String(o[key])} 超出 [0, 100]，已退回默认 ${DEFAULT_OPTIONS[key]}`);
      return DEFAULT_OPTIONS[key];
    }
    return v;
  };

  const thresholdBuy = pickScore('thresholdBuy');
  const thresholdSell = pickScore('thresholdSell');
  if (thresholdSell > thresholdBuy) {
    warnings.push(
      `卖出阈值 ${thresholdSell} 高于买入阈值 ${thresholdBuy}，会导致刚买入就满足卖出条件，手续费被反复磨损`,
    );
  }

  // confirmBars：连续确认天数。0 与 1 都表示「不确认」，即单日穿越就动手。
  // 上限给 60：超过一个季度的确认期在日频策略里没有实际意义，只会让用户
  // 误以为「调大就能变好」——那是在拿参数拟合历史，正是本模块要避免的过拟合。
  const confirmRaw = num(o.confirmBars);
  let confirmBars = DEFAULT_OPTIONS.confirmBars;
  if (confirmRaw !== null) {
    if (confirmRaw < 0 || confirmRaw > 60) {
      warnings.push(`confirmBars=${String(o.confirmBars)} 超出 [0, 60]，已退回默认 ${DEFAULT_OPTIONS.confirmBars}`);
    } else {
      confirmBars = Math.floor(confirmRaw);
    }
  }

  return {
    options: {
      warmup,
      initialCash,
      feeRate: pickRate('feeRate'),
      stampDuty: pickRate('stampDuty'),
      slippage: pickRate('slippage'),
      thresholdBuy,
      thresholdSell,
      confirmBars,
    },
    warnings,
  };
}

/* ════════════════════════════════════════════════════════════════
 * 3. 内置策略
 *
 * 策略接口（也是自定义策略必须遵守的形状）：
 *   onBar({
 *     bars,        // 截止到今日的窗口，bars[0..t]，**只有这些数据**
 *     index,       // 今日在原始序列里的下标 t
 *     date,        // 今日日期
 *     score,       // evaluateStock 给出的多因子总分 0-100，可能为 null
 *     position,    // null 表示空仓；持仓时为 { shares, entryPrice, entryDate, entryScore, holdBars, cost }
 *     params,      // 策略参数（已与默认值合并），**只读**，驱动不了运行期状态
 *     streaks,     // { buy, sell }：截至今日（含今日）连续满足买卖条件的自然日数，由引擎维护
 *     indicators,  // 惰性函数，调用即得 computeIndicators(bars)，不要每步都直接算
 *   }) -> { action: 'buy' | 'sell' | 'hold', reason: string }
 *
 * 为什么 indicators 做成惰性函数：score-threshold 不需要原始指标，
 * 每步都算一遍等于把回测耗时翻倍。惰性求值让只有真的要用指标的策略才付这笔钱。
 *
 * 为什么 streaks 由引擎维护、而不是塞进 params：
 * params 是用户可配置的**配置**，streaks 是随行情演进的**运行期状态**。
 * 两者混在一起会有两个后果：①「同一份配置产生不同结果」，配置不可复现；
 * ② UI 无法把 params 原样展示给用户看。所以运行期状态一律走独立字段。
 * ════════════════════════════════════════════════════════════════ */

/**
 * score-threshold：评分阈值策略，也是最容易解释的一个。
 *
 * ── 为什么需要「信号确认」（confirmBars）──────────────────────────
 * 朴素做法（今日过阈值就明日买卖）在震荡行情里会被反复打脸。实测一段
 * 周期 15 天、振幅 1.5% 的横盘行情：评分在 36~77 之间摆动，连续 400 根
 * K 线里穿越买入阈值 23 次、卖出阈值 22 次，23 笔交易几乎笔笔止损，把
 * 一个「基准只跌 0.27%」的横盘做成了 -41.85%。
 *
 * 根因不是评分器不好，而是「单个交易日的分数」本身就带噪声——它受当日
 * 涨跌、量比、位置分影响，横盘时这些量在阈值附近反复抖动。真实策略都不会
 * 只看一天信号。
 *
 * 所以这里加 confirmBars：要求连续 N 个交易日都满足条件才动手。
 * 代价是错过行情最初几天（趋势策略的固有代价），换来的是把噪声交易过滤掉。
 * 默认 2 天：横盘里的单日假信号基本被消掉，而真趋势持续数周，不受影响。
 * 传 0 或 1 即退化为「单日穿越就动手」的原始行为。
 */
const SCORE_THRESHOLD = {
  name: 'score-threshold',
  label: '评分阈值',
  description:
    '空仓时多因子总分连续 N 日 ≥ 买入阈值即次日开盘全仓买入；持仓时总分连续 N 日 ≤ 卖出阈值即次日开盘清仓。连续确认用来过滤横盘时的假信号。',
  defaults: Object.freeze({ thresholdBuy: 60, thresholdSell: 40, confirmBars: 2 }),
  onBar({ score, position, params, streaks }) {
    if (!isNum(score)) {
      return { action: 'hold', reason: '本次评分不可用，保持现状不动' };
    }
    const { thresholdBuy, thresholdSell } = params;
    // confirmBars 容错：非法值退回 1（不确认），不让一个手滑的配置把策略变成永不交易
    const confirm =
      Number.isFinite(params.confirmBars) && params.confirmBars >= 1 ? Math.floor(params.confirmBars) : 1;

    if (!position) {
      if (score >= thresholdBuy) {
        // streak 由引擎逐日维护并通过独立的 streaks 字段传入，不混进 params
        const streak = isNum(streaks && streaks.buy) ? streaks.buy : 1;
        if (streak >= confirm) {
          return {
            action: 'buy',
            reason: `多因子总分 ${score} 分，已连续 ${streak} 日达到买入阈值 ${thresholdBuy} 分`,
          };
        }
        return { action: 'hold', reason: `买入信号待确认：总分 ${score} 分达标 ${streak}/${confirm} 日` };
      }
      return { action: 'hold', reason: `空仓等待：总分 ${score} 分未达买入阈值 ${thresholdBuy} 分` };
    }

    if (score <= thresholdSell) {
      const streak = isNum(streaks && streaks.sell) ? streaks.sell : 1;
      if (streak >= confirm) {
        return {
          action: 'sell',
          reason: `多因子总分 ${score} 分，已连续 ${streak} 日跌破卖出阈值 ${thresholdSell} 分`,
        };
      }
      return { action: 'hold', reason: `卖出信号待确认：总分 ${score} 分低于阈值 ${streak}/${confirm} 日` };
    }
    return { action: 'hold', reason: `继续持有：总分 ${score} 分介于 ${thresholdSell}-${thresholdBuy} 分之间` };
  },
};

/** ma-cross：均线金叉死叉。用 score.js 的 computeIndicators 保证与面板口径一致。 */
const MA_CROSS = {
  name: 'ma-cross',
  label: '均线交叉',
  description: 'MA5 上穿 MA20（金叉）次日开盘买入，MA5 下穿 MA20（死叉）次日开盘卖出。经典趋势跟随策略。',
  defaults: Object.freeze({ fastPeriod: 5, slowPeriod: 20 }),
  onBar({ position, params, indicators }) {
    const { fastPeriod, slowPeriod } = params;
    const ind = indicators();
    // computeIndicators 只给出 ma5 / ma20 全序列，自定义周期自己算
    const fast = fastPeriod === 5 ? ind.maSeries.ma5 : simpleMaSeries(ind.closes, fastPeriod);
    const slow = slowPeriod === 20 ? ind.maSeries.ma20 : simpleMaSeries(ind.closes, slowPeriod);
    const n = fast.length;
    if (n < 2) return { action: 'hold', reason: '均线序列长度不足，无法判断交叉' };

    const fastNow = fast[n - 1];
    const slowNow = slow[n - 1];
    const fastPrev = fast[n - 2];
    const slowPrev = slow[n - 2];
    if (!isNum(fastNow) || !isNum(slowNow) || !isNum(fastPrev) || !isNum(slowPrev)) {
      return { action: 'hold', reason: `MA${fastPeriod}/MA${slowPeriod} 尚未形成完整序列，等待中` };
    }

    const crossedUp = fastPrev <= slowPrev && fastNow > slowNow;
    const crossedDown = fastPrev >= slowPrev && fastNow < slowNow;

    if (!position && crossedUp) {
      return {
        action: 'buy',
        reason: `MA${fastPeriod}(${round(fastNow, 2)}) 上穿 MA${slowPeriod}(${round(slowNow, 2)})，形成金叉`,
      };
    }
    if (position && crossedDown) {
      return {
        action: 'sell',
        reason: `MA${fastPeriod}(${round(fastNow, 2)}) 下穿 MA${slowPeriod}(${round(slowNow, 2)})，形成死叉`,
      };
    }
    const above = fastNow > slowNow;
    return {
      action: 'hold',
      reason: `均线${above ? '多头' : '空头'}排列（MA${fastPeriod} ${round(fastNow, 2)} vs MA${slowPeriod} ${round(slowNow, 2)}），未出现新的交叉`,
    };
  },
};

/** breakout：唐奇安通道突破，海龟法则的简化版。 */
const BREAKOUT = {
  name: 'breakout',
  label: '区间突破',
  description:
    '收盘价突破前 20 日最高价次日开盘买入，跌破前 10 日最低价次日开盘卖出。「前 N 日」不含当日，否则当天的最高价会让突破条件永远成立。',
  defaults: Object.freeze({ entryLookback: 20, exitLookback: 10 }),
  onBar({ bars, position, params }) {
    const { entryLookback, exitLookback } = params;
    const n = bars.length;

    if (!position) {
      // 需要 N 根历史 + 1 根当日，共 N+1 根才能判断「突破前 N 日高点」
      if (n < entryLookback + 1) {
        return { action: 'hold', reason: `需要至少 ${entryLookback + 1} 根 K 线才能判断 ${entryLookback} 日突破` };
      }
      let highest = -Infinity;
      for (let i = n - 1 - entryLookback; i < n - 1; i += 1) {
        if (bars[i].high > highest) highest = bars[i].high;
      }
      const close = bars[n - 1].close;
      if (isNum(highest) && close > highest) {
        return {
          action: 'buy',
          reason: `收盘价 ${round(close, 2)} 突破前 ${entryLookback} 日最高价 ${round(highest, 2)}`,
        };
      }
      return { action: 'hold', reason: `收盘价 ${round(close, 2)} 未突破前 ${entryLookback} 日最高价 ${round(highest, 2)}` };
    }

    if (n < exitLookback + 1) {
      return { action: 'hold', reason: `需要至少 ${exitLookback + 1} 根 K 线才能判断 ${exitLookback} 日止损位` };
    }
    let lowest = Infinity;
    for (let i = n - 1 - exitLookback; i < n - 1; i += 1) {
      if (bars[i].low < lowest) lowest = bars[i].low;
    }
    const close = bars[n - 1].close;
    if (isNum(lowest) && close < lowest) {
      return {
        action: 'sell',
        reason: `收盘价 ${round(close, 2)} 跌破前 ${exitLookback} 日最低价 ${round(lowest, 2)}，触发离场`,
      };
    }
    return { action: 'hold', reason: `持仓中：收盘价 ${round(close, 2)} 未跌破前 ${exitLookback} 日最低价 ${round(lowest, 2)}` };
  },
};

/** 简单移动平均序列（带 null 前缀），用于 ma-cross 的自定义周期。 */
function simpleMaSeries(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (period < 1) return out;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 内置策略注册表。冻结，防止运行时被意外改写。 */
export const STRATEGIES = Object.freeze({
  [SCORE_THRESHOLD.name]: SCORE_THRESHOLD,
  [MA_CROSS.name]: MA_CROSS,
  [BREAKOUT.name]: BREAKOUT,
});

/**
 * 把 options 里属于策略参数的项挑出来，透传给策略。
 *
 * 为什么按策略 defaults 的键做白名单过滤：options 里的 feeRate / slippage /
 * warmup 是引擎的成本与窗口参数，不该混进策略的 params。否则自定义策略会看到
 * 一个语义混杂的 params 对象，很容易误以为「thresholdBuy 是所有策略都懂的参数」。
 * 只有策略自己声明过的键才透传。
 */
function strategyParamsFromOptions(defaults, options) {
  const params = {};
  for (const key of Object.keys(defaults)) {
    if (isNum(options[key])) params[key] = options[key];
  }
  return params;
}

/**
 * 按名取策略，未知名称退回默认策略。
 *
 * 同时返回 `requestedName`，让 runBacktest 能对比出「你要的策略不存在、
 * 我给你换成了默认策略」这件事并写进 warnings。静默降级是回测里最危险的行为：
 * 用户以为自己在测 A 策略，实际上测的是 B，结论完全无效。
 *
 * @param {string} name 策略名
 * @param {object} [params] 策略参数，覆盖 defaults
 * @returns {{ name: string, label: string, description: string, params: object, onBar: Function, requestedName: string, fellBack: boolean }}
 */
export function resolveStrategy(name, params) {
  const requested = str(name);
  const known = Object.prototype.hasOwnProperty.call(STRATEGIES, requested);
  const base = known ? STRATEGIES[requested] : STRATEGIES[DEFAULT_STRATEGY];

  const cleanParams = {};
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      cleanParams[key] = value;
    }
  }

  return {
    name: base.name,
    label: base.label,
    description: base.description,
    params: { ...base.defaults, ...cleanParams },
    onBar: base.onBar,
    requestedName: requested,
    fellBack: !known,
  };
}

/**
 * 把 runBacktest 的 strategy 入参统一成策略对象。
 * 支持三种写法：字符串名、{ name, params }、以及自带 onBar 的自定义对象。
 */
function normalizeStrategy(strategy, options, warn) {
  // ① 字符串：最常见
  if (typeof strategy === 'string' && strategy.trim()) {
    const name = strategy.trim();
    const defaults = Object.prototype.hasOwnProperty.call(STRATEGIES, name)
      ? STRATEGIES[name].defaults
      : STRATEGIES[DEFAULT_STRATEGY].defaults;
    const resolved = resolveStrategy(name, strategyParamsFromOptions(defaults, options));
    if (resolved.fellBack) {
      warn(`未找到名为「${name}」的策略，已退回默认策略「${resolved.name}」；本次回测结果对应的不是你想测的策略`);
    }
    return resolved;
  }

  // ② 对象
  if (strategy && typeof strategy === 'object') {
    const hasCustomOnBar = typeof strategy.onBar === 'function';
    if (hasCustomOnBar) {
      const customName = str(strategy.name) || 'custom';
      return {
        name: customName,
        label: str(strategy.label) || customName,
        description: str(strategy.description) || '',
        // 自定义策略自己声明 params，引擎不往里塞任何东西
        params: strategy.params && typeof strategy.params === 'object' ? { ...strategy.params } : {},
        onBar: strategy.onBar,
        requestedName: customName,
        fellBack: false,
      };
    }
    if (str(strategy.name)) {
      const name = str(strategy.name);
      const defaults = Object.prototype.hasOwnProperty.call(STRATEGIES, name)
        ? STRATEGIES[name].defaults
        : STRATEGIES[DEFAULT_STRATEGY].defaults;
      const resolved = resolveStrategy(name, {
        ...strategyParamsFromOptions(defaults, options),
        ...(strategy.params && typeof strategy.params === 'object' ? strategy.params : {}),
      });
      if (resolved.fellBack) {
        warn(`未找到名为「${name}」的策略，已退回默认策略「${resolved.name}」`);
      }
      return resolved;
    }
  }

  // ③ 没给 / 给了个看不懂的东西：用默认策略，但要说清楚
  if (strategy !== undefined && strategy !== null) {
    warn('strategy 参数无法识别（既不是策略名也不是带 onBar 的对象），已使用默认策略');
  }
  return resolveStrategy(
    DEFAULT_STRATEGY,
    strategyParamsFromOptions(STRATEGIES[DEFAULT_STRATEGY].defaults, options),
  );
}

/* ════════════════════════════════════════════════════════════════
 * 4. 统计指标
 * ════════════════════════════════════════════════════════════════ */

/**
 * 由净值曲线 + 交易明细算出全部统计项。
 * 单独抽成导出函数有两个原因：主流程复用它（口径唯一），
 * 测试可以手工构造净值序列直接核对（不必造一段完整 K 线）。
 *
 * @param {{ equity: {date: string, equity: number, benchmark: number|null}[], trades: object[], initialCash: number }} input
 * @returns {object} stats
 */
export function computeStats({ equity, trades, initialCash }) {
  const curve = Array.isArray(equity) ? equity : [];
  const list = Array.isArray(trades) ? trades : [];

  const equityValues = curve.map((p) => (isNum(p.equity) ? p.equity : null)).filter(isNum);
  const firstEquity = equityValues.length ? equityValues[0] : null;
  const lastEquity = equityValues.length ? equityValues[equityValues.length - 1] : null;

  /* ── 总收益 ─────────────────────────────────────────────── */
  const totalReturn =
    isNum(firstEquity) && isNum(lastEquity) && initialCash > 0
      ? round((lastEquity / initialCash - 1) * 100, 2)
      : null;

  /* ── 年化收益：按自然日折算 ───────────────────────────────── */
  // 用自然日而不是交易日：用户对「持有了多久」的直觉是日历天数。
  // 不足 1 天不年化（会放大成天文数字），直接返回 null。
  let annualReturn = null;
  if (isNum(totalReturn) && curve.length >= 2 && initialCash > 0 && isNum(lastEquity)) {
    const days = naturalDays(curve[0].date, curve[curve.length - 1].date);
    const ratio = lastEquity / initialCash;
    if (days !== null && days > 0 && ratio > 0) {
      annualReturn = round((Math.pow(ratio, DAYS_PER_YEAR / days) - 1) * 100, 2);
    }
  }

  /* ── 最大回撤：峰值到谷底的最大跌幅，正数表示 ─────────────── */
  let maxDrawdown = null;
  if (equityValues.length >= 2) {
    let peak = -Infinity;
    let worst = 0;
    for (const v of equityValues) {
      if (v > peak) peak = v;
      if (peak > 0) {
        const dd = ((peak - v) / peak) * 100;
        if (dd > worst) worst = dd;
      }
    }
    maxDrawdown = round(worst, 2);
  }

  /* ── 夏普比率：日收益均值 / 日收益标准差 × √252，无风险利率取 0 ── */
  let sharpe = null;
  if (equityValues.length >= 2) {
    const rets = [];
    for (let i = 1; i < equityValues.length; i += 1) {
      const prev = equityValues[i - 1];
      const cur = equityValues[i];
      if (prev > 0) rets.push(cur / prev - 1);
    }
    const m = mean(rets);
    const s = stdev(rets);
    // 标准差为 0（净值一条直线，通常是全程空仓）时夏普无定义，给 null 而不是 Infinity
    if (isNum(m) && isNum(s) && s > 0) {
      sharpe = round((m / s) * Math.sqrt(TRADING_DAYS_PER_YEAR), 3);
    }
  }

  /* ── 胜率 / 盈亏比 / 持仓天数 ─────────────────────────────── */
  // winRate 是 0-1 的比例（不是百分数），与 upProbability 同口径，由展示层决定怎么显示。
  let winRate = null;
  let profitFactor = null;
  let avgHoldDays = null;

  if (list.length > 0) {
    let wins = 0;
    let grossWin = 0;
    let grossLoss = 0;
    const holds = [];

    for (const t of list) {
      const pnl = num(t.pnl);
      if (pnl === null) continue;
      if (pnl > 0) {
        wins += 1;
        grossWin += pnl;
      } else if (pnl < 0) {
        grossLoss += -pnl;
      }
      if (isNum(t.holdDays)) holds.push(t.holdDays);
    }

    winRate = round(wins / list.length, 4);
    // 无亏损交易时盈亏比无定义（不是无穷大），返回 null 由展示层解释
    profitFactor = grossLoss > 0 ? round(grossWin / grossLoss, 3) : null;
    avgHoldDays = holds.length ? round(mean(holds), 1) : null;
  }

  /* ── 基准（同期买入持有）────────────────────────────────── */
  let benchmarkReturn = null;
  const benchValues = curve.map((p) => (isNum(p.benchmark) ? p.benchmark : null));
  const hasBench = benchValues.length >= 2 && benchValues[0] !== null && benchValues[benchValues.length - 1] !== null;
  if (hasBench && benchValues[0] > 0) {
    benchmarkReturn = round((benchValues[benchValues.length - 1] / benchValues[0] - 1) * 100, 2);
  }

  const excessReturn =
    isNum(totalReturn) && isNum(benchmarkReturn) ? round(totalReturn - benchmarkReturn, 2) : null;

  return {
    totalReturn,
    annualReturn,
    maxDrawdown,
    sharpe,
    winRate,
    profitFactor,
    tradeCount: list.length,
    avgHoldDays,
    benchmarkReturn,
    excessReturn,
  };
}

/* ════════════════════════════════════════════════════════════════
 * 5. 空结果与错误结果
 * ════════════════════════════════════════════════════════════════ */

/** 构造一个字段完整、统计项全 null 的失败结果。绝不抛异常是硬要求。 */
function makeEmptyResult(strategyName, warnings) {
  return {
    ok: false,
    strategy: strategyName || DEFAULT_STRATEGY,
    startDate: null,
    endDate: null,
    bars: 0,
    skipped: 0,
    trades: [],
    equity: [],
    stats: {
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
    },
    warnings,
    disclaimer: DISCLAIMER,
  };
}

/* ════════════════════════════════════════════════════════════════
 * 6. 回测主流程
 * ════════════════════════════════════════════════════════════════ */

/**
 * 执行一次单标的滚动回测。
 *
 * @param {object} input
 * @param {object[]} input.bars 前复权、按日期升序的日 K
 * @param {string|object} [input.strategy] 策略名或策略对象，缺省 'score-threshold'
 * @param {object} [input.options] 引擎参数，见 DEFAULT_OPTIONS
 * @returns {object} BacktestResult
 */
export function runBacktest(input) {
  const warnings = [];
  const warn = (msg) => {
    const text = str(msg);
    if (text && !warnings.includes(text)) warnings.push(text);
  };

  const src = input && typeof input === 'object' ? input : {};
  const { options, warnings: optionWarnings } = normalizeOptions(src.options);
  for (const w of optionWarnings) warn(w);

  const strategy = normalizeStrategy(src.strategy, options, warn);

  /* ── 输入校验：宁可返回一个带解释的空结果，也不要抛异常 ─────── */
  if (!Array.isArray(src.bars)) {
    warn('bars 不是数组，无法回测');
    return makeEmptyResult(strategy.name, warnings);
  }
  if (src.bars.length === 0) {
    warn('K 线为空，无法回测');
    return makeEmptyResult(strategy.name, warnings);
  }

  const { bars, invalid, invalidDates } = normalizeBars(src.bars);
  if (invalid > 0) {
    const sample = invalidDates.length ? `（如 ${invalidDates.join('、')}）` : '';
    warn(`共 ${invalid} 根 K 线的收盘价缺失或非正，已剔除${sample}，这些交易日的决策被跳过`);
  }

  const n = bars.length;
  const minBars = options.warmup + 2;
  if (n < minBars) {
    warn(`有效 K 线仅 ${n} 根，少于 warmup+2 = ${minBars} 根（预热 ${options.warmup} 根 + 至少 2 根用于产生并成交信号），无法回测`);
    return makeEmptyResult(strategy.name, warnings);
  }

  // 顺序错乱必须报出来：逆序数据会让所有收益率符号反转，结果看似正常实则完全反了
  let outOfOrder = 0;
  for (let i = 1; i < n; i += 1) {
    if (bars[i - 1].date && bars[i].date && bars[i - 1].date > bars[i].date) outOfOrder += 1;
  }
  if (outOfOrder > 0) {
    warn(`K 线未按日期升序排列（检出 ${outOfOrder} 处逆序），回测结果不可信，请先排序`);
  }

  if (bars.some((b) => b.openMissing)) {
    warn('部分 K 线缺少有效开盘价，成交价以收盘价替代，实际成交成本会有偏差');
  }

  const zeroVolumeAll = bars.every((b) => b.volume === 0);
  if (zeroVolumeAll) {
    warn('全部 K 线成交量为 0（疑似长期停牌），量能因子按中性处理，回测结果参考价值有限');
  }

  /* ── 状态机 ────────────────────────────────────────────────── */
  const { warmup, initialCash, feeRate, stampDuty, slippage } = options;

  let cash = initialCash;
  let shares = 0;
  let position = null; // { entryDate, entryPrice, entryScore, entryIndex, cost }
  let pendingSignal = null; // 昨日产生、待今日开盘执行的信号
  let unfilledSignals = 0; // 信号产生但无法成交的次数（含末根信号）
  let anchorClose = null; // 基准锚点：第一个回测日的收盘价
  let lastValidBar = null;

  const equityCurve = [];
  const trades = [];

  // 每个 t 最多算一次指标，供 ma-cross 这类需要原始指标的策略复用
  let indicatorCache = null;
  let indicatorCacheIndex = -1;

  // 连续满足买入/卖出条件的天数。由引擎逐日维护，作为**独立的运行期状态**
  // 传给策略（而不是混进 params）。只依赖当日及以前的分数，天然不引入未来函数。
  // 为什么引擎管而不是策略自己管：策略实例是共享的（STRATEGIES 冻结复用），
  // 让策略持有状态会导致两次 runBacktest 互相污染。
  const streaks = { buy: 0, sell: 0 };

  // 预热期：前 warmup-1 根无法形成完整窗口，不参与任何决策
  const warmupSkipped = warmup - 1;

  for (let t = warmup - 1; t < n; t += 1) {
    const bar = bars[t];
    lastValidBar = bar;
    if (anchorClose === null && bar.close > 0) anchorClose = bar.close;

    /* ── ① 执行昨日挂起的信号：只能用今日开盘价 ─────────────────
     * 这是防未来函数第二道保险。第 t-1 日收盘才知道的信号，
     * 现实里最早只能在第 t 日开盘成交，所以这里读 bar.open，绝不读 close。 */
    if (pendingSignal) {
      const signal = pendingSignal;
      pendingSignal = null;
      const rawOpen = bar.open;

      if (!(rawOpen > 0)) {
        unfilledSignals += 1;
        warn(`信号日 ${signal.signalDate} 的次日（${bar.date}）开盘价无效，成交无法执行，该信号作废`);
      } else if (signal.action === 'buy' && shares === 0) {
        const execPrice = rawOpen * (1 + slippage);
        const unitCost = execPrice * (1 + feeRate);

        // A 股按整手撮合；资金连一手都不够时才退化为零股
        let qty = Math.floor(cash / (unitCost + 1e-9) / LOT_SIZE) * LOT_SIZE;
        if (qty < LOT_SIZE) qty = Math.floor(cash / (unitCost + 1e-9));

        if (qty <= 0) {
          unfilledSignals += 1;
          warn(`信号日 ${signal.signalDate} 的买入信号因可用资金不足 1 股无法成交（可用 ${round(cash, 2)} 元，价格 ${round(execPrice, 2)} 元）`);
        } else {
          const gross = qty * execPrice;
          const fee = gross * feeRate;
          const totalCost = gross + fee;
          cash -= totalCost;
          if (cash < 0) cash = 0; // 浮点容错，不允许出现负现金
          shares = qty;
          position = {
            entryDate: bar.date,
            entryPrice: execPrice,
            entryScore: signal.score,
            entryIndex: t,
            cost: totalCost,
            entryReason: signal.reason,
          };
        }
      } else if (signal.action === 'sell' && shares > 0) {
        const execPrice = rawOpen * (1 - slippage);
        const gross = shares * execPrice;
        const fee = gross * feeRate;
        const tax = gross * stampDuty; // 印花税只在卖出时收
        const net = gross - fee - tax;
        cash += net;

        const pnl = net - position.cost;
        trades.push({
          entryDate: position.entryDate,
          entryPrice: round(position.entryPrice, 4),
          exitDate: bar.date,
          exitPrice: round(execPrice, 4),
          shares,
          pnl: round(pnl, 2),
          pnlPercent: position.cost > 0 ? round((pnl / position.cost) * 100, 2) : null,
          holdDays: naturalDays(position.entryDate, bar.date),
          entryScore: position.entryScore,
          exitScore: isNum(signal.score) ? signal.score : null,
          // reason 记的是**离场理由**：复盘时用户最想知道的是「为什么卖」。
          // 入场理由单列在 entryReason，两者都保留，不然复盘只看到一半故事。
          reason: signal.reason || '触发卖出条件',
          entryReason: position.entryReason || null,
        });

        shares = 0;
        position = null;
      }
    }

    /* ── ② 用 bars[0..t] 计算今日信号 ────────────────────────────
     * 这是防未来函数第一道保险：slice 产生新数组，策略拿不到更后面的数据。 */
    const window = bars.slice(0, t + 1);

    let score = null;
    try {
      const evaluation = evaluateStock({ bars: window });
      score = evaluation && isNum(evaluation.score) ? evaluation.score : null;
    } catch (err) {
      warn(`第 ${t + 1} 步评分计算异常（${err && err.message ? err.message : '未知错误'}），该步按无法评分处理`);
    }

    const positionView = position
      ? {
          shares,
          entryPrice: position.entryPrice,
          entryDate: position.entryDate,
          entryScore: position.entryScore,
          holdBars: t - position.entryIndex,
          cost: position.cost,
        }
      : null;

    /* 维护连续达标天数。只用到今日的 score，所以这一步天然不引入未来数据。
     * 注意顺序：先更新 streak 再调策略，策略才能看到「含今日在内」的连续天数。 */
    if (isNum(score)) {
      streaks.buy = score >= options.thresholdBuy ? streaks.buy + 1 : 0;
      streaks.sell = score <= options.thresholdSell ? streaks.sell + 1 : 0;
    }

    let decision = { action: 'hold', reason: '本次评分不可用，保持现状不动' };
    try {
      const raw = strategy.onBar({
        bars: window,
        index: t,
        date: bar.date,
        score,
        position: positionView,
        params: strategy.params,
        // 传副本：策略不该有办法改写引擎的运行期状态
        streaks: { buy: streaks.buy, sell: streaks.sell },
        indicators: () => {
          if (indicatorCacheIndex !== t) {
            indicatorCache = computeIndicators(window);
            indicatorCacheIndex = t;
          }
          return indicatorCache;
        },
      });
      if (raw && (raw.action === 'buy' || raw.action === 'sell' || raw.action === 'hold')) {
        decision = { action: raw.action, reason: typeof raw.reason === 'string' ? raw.reason : '' };
      } else {
        warn(`第 ${t + 1} 步策略返回了无法识别的结果（action=${raw ? String(raw.action) : '空'}），按 hold 处理`);
      }
    } catch (err) {
      warn(`第 ${t + 1} 步策略执行异常（${err && err.message ? err.message : '未知错误'}），该步按 hold 处理`);
    }

    /* ── ③ 记今日收盘净值 ────────────────────────────────────────
     * 注意顺序：净值在信号挂起之前记。因为今日信号最早明日开盘才成交，
     * 今日收盘时账户还没有变动。挪到后面会让净值提前反映未来的成交。 */
    equityCurve.push({
      date: bar.date,
      equity: round(cash + shares * bar.close, 2),
      benchmark: anchorClose !== null && anchorClose > 0 ? round((initialCash * bar.close) / anchorClose, 2) : null,
    });

    /* ── ④ 把今日信号挂起到明日 ────────────────────────────────── */
    if (decision.action !== 'hold') {
      const isLastBar = t === n - 1;
      if (isLastBar) {
        // 最后一根 K 线产生的信号没有次日开盘价可以成交，必须作废并说明
        unfilledSignals += 1;
        warn(
          `最后一根 K 线（${bar.date}）产生「${decision.action === 'buy' ? '买入' : '卖出'}」信号，但已无次日开盘价可成交，该信号作废并计入 skipped`,
        );
      } else {
        pendingSignal = { action: decision.action, score, signalDate: bar.date, reason: decision.reason };
      }
    }
  }

  /* ── 期末未平仓头寸：补登一笔「虚拟清仓」到交易明细 ──────────────
   *
   * 这里有一个必须讲清楚的取舍。
   *
   * 不补登的话，最后一段持仓永远不会出现在 trades 里，胜率、盈亏比会
   * 漏掉最大的一笔，统计口径就不完整了。
   *
   * 但补登**绝不能**回头改写 equity 曲线最后一点。净值曲线的每一天都只
   * 由「截至那一日的信息」决定，这是整个防未来函数体系的基础 —— 也正因此，
   * 「把数据截断到第 k 根重跑，前 k 根净值必须逐个相同」这个测试才成立。
   * 一旦拿期末结算反手改最后一点，曲线末尾就带上了「序列到此结束」这个
   * 事后信息，截断等价性会在最后一点恒失配，那道验证就废了。
   *
   * 所以：equity 曲线是纯市值口径（cash + shares × close），最后一个点
   * 就是期末持仓的市值；totalReturn 以曲线终点为准。这笔虚拟清仓只写进
   * trades，供统计盈亏用，其退出成本（手续费/印花税）不计入净值曲线，
   * 已在 warnings 里明确告知。
   *
   * 一个例外：若建仓就发生在最后一根 K 线上（entryIndex === n-1），
   * 这笔「买入当天就虚拟平仓」的记录 holdDays 为 0、盈亏纯粹是手续费摩擦，
   * 它既不是一次真实的持仓决策、又会污染胜率统计。所以这种不补登，
   * 只告警说明「末根建仓未计入交易统计」。 */
  const positionEnteredOnLastBar = position && position.entryIndex === n - 1;
  if (shares > 0 && lastValidBar && positionEnteredOnLastBar) {
    warn(
      `建仓发生在最后一根 K 线（${lastValidBar.date}），没有持有时长可言，该笔未计入交易统计（仅体现为净值曲线的期末持仓市值）`,
    );
    shares = 0;
    position = null;
  }

  if (shares > 0 && lastValidBar) {
    const exitPrice = lastValidBar.close;
    const gross = shares * exitPrice;
    const fee = gross * feeRate;
    const tax = gross * stampDuty;
    const net = gross - fee - tax;
    const pnl = net - position.cost;

    trades.push({
      entryDate: position.entryDate,
      entryPrice: round(position.entryPrice, 4),
      exitDate: lastValidBar.date,
      exitPrice: round(exitPrice, 4),
      shares,
      pnl: round(pnl, 2),
      pnlPercent: position.cost > 0 ? round((pnl / position.cost) * 100, 2) : null,
      holdDays: naturalDays(position.entryDate, lastValidBar.date),
      entryScore: position.entryScore,
      exitScore: null,
      reason: '回测区间结束仍有持仓，按最后一根 K 线收盘价虚拟平仓计入统计（退出成本未计入净值曲线）',
      entryReason: position.entryReason || null,
    });

    shares = 0;
    position = null;

    warn(
      '回测结束时仍有持仓，已按最后一根 K 线收盘价虚拟平仓并计入交易明细；该笔的退出成本未计入净值曲线，因此净值终点略高于税后实际可变现资产',
    );
  }

  /* ── 统计与收尾 ───────────────────────────────────────────── */
  const stats = computeStats({ equity: equityCurve, trades, initialCash });

  // skipped 的口径：没能参与「产生信号并成交」的 K 线根数
  const skipped = warmupSkipped + invalid + unfilledSignals;
  if (warmupSkipped > 0) {
    warn(`前 ${warmupSkipped} 根 K 线为预热期（不足 ${warmup} 根无法计算长周期指标），不参与决策，计入 skipped`);
  }
  if (trades.length === 0) {
    warn('回测区间内没有产生任何完整交易，胜率、盈亏比、平均持仓天数均为 null');
  }

  // 回测区间太短时年化会膨胀到离谱（10 天赚 3% 年化就是 190%），必须提示
  const spanDays = equityCurve.length >= 2 ? naturalDays(equityCurve[0].date, equityCurve[equityCurve.length - 1].date) : null;
  if (spanDays !== null && spanDays < 250) {
    warn(`回测区间仅 ${spanDays} 个自然日（不足 1 年），annualReturn 是按 365 天折算的外推值，波动极大，不宜作为年度收益预期`);
  }

  return {
    ok: true,
    strategy: strategy.name,
    startDate: equityCurve.length ? equityCurve[0].date : null,
    endDate: equityCurve.length ? equityCurve[equityCurve.length - 1].date : null,
    bars: equityCurve.length,
    skipped,
    trades,
    equity: equityCurve,
    stats,
    warnings,
    disclaimer: DISCLAIMER,
  };
}

/** 默认导出主入口，方便 `import backtest from './lib/backtest.js'` 这种写法。 */
export default runBacktest;
