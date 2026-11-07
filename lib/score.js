/**
 * dsh-stock-surf / lib/score.js
 * 多因子技术评分引擎 —— 本插件的核心计算模块。
 *
 * 设计约束（严格对齐 CONTRACT.md「lib/score.js 必须导出的 API（冻结）」）：
 *   - 纯函数：不联网、不读文件、不读环境变量、不引用任何 npm 依赖、零 IO。
 *   - 输入只有 { quote, bars }，输出结构固定为 Indicators / Evaluation。
 *   - 所有中文文案在本文件内直接产出，不依赖 locale 资源。
 *
 * ── 评分口径总览 ───────────────────────────────────────────────
 * 每个因子先独立算出一个 0-100 的「看多程度」分，再按权重加权求和：
 *   trend 0.28 │ momentum 0.22 │ volume 0.18 │ position 0.16 │ volatility 0.10 │ risk 0.06
 *
 * 三条刻意为之的设计原则：
 *  1) 权重恒定为 1，数据不足也不重新分配。缺数据的因子退回 50 分（中性），
 *     并在 dataQuality.warnings 说明原因。这样「权重和 = 1」在任何输入下都成立，
 *     降级也不会凭空放大剩余因子的影响力。
 *  2) 每个因子的原始分都以 50 为中性基准，向多/空两个方向加减可解释的子项分数，
 *     所以「涨 1% 该给多少分」这种问题可以逐条追到代码。
 *  3) 均线/整数位的强弱比较带 0.05% 的相对容差：横盘时均线纠缠不应被读成
 *     「多头排列」或「空头排列」，否则震荡市会被随机噪声推成单边判断。
 *
 * 免责：所有分数、upProbability 都是启发式估计，不是概率模型输出，不构成投资建议。
 */

/* ════════════════════════════════════════════════════════════════
 * 0. 常量与文案
 * ════════════════════════════════════════════════════════════════ */

/** 6 个因子的权重。冻结，和为 1（0.28+0.22+0.18+0.16+0.10+0.06）。 */
export const WEIGHTS = Object.freeze({
  trend: 0.28,
  momentum: 0.22,
  volume: 0.18,
  position: 0.16,
  volatility: 0.1,
  risk: 0.06,
});

/** verdict 的分数阈值（含下界）。 */
export const VERDICT_THRESHOLDS = Object.freeze({
  strongBull: 75,
  bull: 60,
  bear: 45,
  strongBear: 30,
});

/** 固定免责声明。契约要求 Evaluation.disclaimer 是固定文本。 */
export const DISCLAIMER =
  '本工具依据公开行情数据做技术指标计算与多因子打分，所有评分、评级与上行倾向均为启发式估计，非概率模型输出，不构成任何投资建议。数据可能存在延迟或缺失，技术指标亦可能失效，请自行独立判断并承担投资风险。';

/** 因子中文名。 */
const FACTOR_LABELS = Object.freeze({
  trend: '趋势',
  momentum: '动量',
  volume: '量能',
  position: '位置',
  volatility: '波动',
  risk: '风险',
});

/** 因子输出顺序 = 权重降序（契约要求 factors 按权重降序）。 */
const FACTOR_ORDER = Object.freeze(['trend', 'momentum', 'volume', 'position', 'volatility', 'risk']);

/** verdict → 中文标签。 */
const VERDICT_LABELS = Object.freeze({
  'strong-bull': '强烈看多',
  bull: '偏多',
  neutral: '中性',
  bear: '偏空',
  'strong-bear': '强烈看空',
});

/** 均线/整数位比较的相对容差：相差 0.05% 以内视为「基本持平」。 */
const NEUTRAL_BAND = 0.0005;

/* ════════════════════════════════════════════════════════════════
 * 1. 基础数值工具
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

function clamp(v, lo, hi) {
  if (!isNum(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** 保留小数位，非有限返回 null。-0 归一为 0。 */
function round(v, digits = 2) {
  if (!isNum(v)) return null;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f + 0;
}

/** 分数保留 1 位小数。 */
function roundScore(v) {
  return round(v, 1);
}

function mean(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/** 样本标准差（除以 n-1），与通达信/同花顺的 BOLL 口径一致。 */
function stdev(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  const m = mean(arr);
  let acc = 0;
  for (const v of arr) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (n - 1));
}

/**
 * 分段线性插值。points 必须是 [x, y] 且按 x 升序。
 * 超出范围取端点值。这是本文件「分数映射规则」的统一表达方式：
 * 每个映射规则都是一串可读的锚点，便于解释「为何这个数值给了这个分」。
 */
function piecewise(points, x) {
  if (!isNum(x) || !points.length) return null;
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i += 1) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (x <= x2) {
      if (x2 === x1) return y2;
      const t = (x - x1) / (x2 - x1);
      return y1 + t * (y2 - y1);
    }
  }
  return last[1];
}

/** 两数相对差是否在容差内（视为持平）。 */
function isTie(a, b, tol = NEUTRAL_BAND) {
  if (!isNum(a) || !isNum(b)) return false;
  if (b === 0) return Math.abs(a) <= tol;
  return Math.abs(a - b) / Math.abs(b) <= tol;
}

/** 方向符号：+1 多 / -1 空 / 0 持平。 */
function dirOf(a, b) {
  if (!isNum(a) || !isNum(b)) return 0;
  if (isTie(a, b)) return 0;
  return a > b ? 1 : -1;
}

/** 百分比格式化，带正负号。 */
function fmtPct(v, digits = 2) {
  if (!isNum(v)) return '—';
  const r = round(v, digits) + 0;
  return `${r > 0 ? '+' : ''}${String(r)}%`;
}

/** 权重百分比的显示文本，如 28%。 */
function fmtWeight(w) {
  return `${Math.round(w * 100)}%`;
}

function fmtPrice(v) {
  if (!isNum(v)) return '—';
  return String(round(v, v >= 100 ? 2 : 3));
}

/** 字符串清洗。 */
function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/**
 * 保证 signals 落在 2-5 条：不足 2 条用兜底文案补齐，超过 5 条截断。
 * 契约要求每个因子的 signals 有 2-5 条中文可读依据。
 */
function ensureSignals(signals, fallbacks) {
  const out = (Array.isArray(signals) ? signals : []).filter(
    (s) => typeof s === 'string' && s.trim().length > 0,
  );
  const fb = Array.isArray(fallbacks) ? fallbacks : [String(fallbacks || '该因子参考数据不足，按中性处理')];
  for (const f of fb) {
    if (out.length >= 2) break;
    if (typeof f === 'string' && !out.includes(f)) out.push(f);
  }
  while (out.length < 2) out.push('该因子可得样本有限，结论参考价值下降');
  return out.slice(0, 5);
}

/* ════════════════════════════════════════════════════════════════
 * 2. 序列指标原语
 * ════════════════════════════════════════════════════════════════ */

/** 简单移动平均序列，与输入等长，前置不足处为 null。 */
function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (!(period > 0)) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指数移动平均序列，用第一个值作为种子（与通达信 EMA 口径一致）。 */
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (!(period > 0) || !values.length) return out;
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      out[i] = prev;
      continue;
    }
    prev = prev === null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * RSI（Wilder 平滑）。
 * 前 period 根算初始均值，之后用 avg = (avg*(n-1) + cur)/n 递推。
 * 全跌 → 0；全涨或零跌幅 → 100；完全无波动 → 50（横盘的中性定义）。
 */
function rsiWilder(closes, period = 14) {
  const n = closes.length;
  if (n < period + 1) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d;
    else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < n; i += 1) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD(12,26,9)：dif = EMA12 - EMA26，dea = EMA9(dif)，hist = dif - dea。 */
function macdCalc(closes, fast = 12, slow = 26, signal = 9) {
  const empty = { dif: null, dea: null, hist: null, prevHist: null };
  if (closes.length < slow) return empty;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const difs = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const deas = emaSeries(difs, signal);
  const hists = difs.map((d, i) => d - deas[i]);
  const n = hists.length;
  return {
    dif: difs[n - 1],
    dea: deas[n - 1],
    hist: hists[n - 1],
    prevHist: n > 1 ? hists[n - 2] : null,
  };
}

/** BOLL(20,2)。percentB 为 0-1 比例的经典 %B；bandwidth 为百分比数值。 */
function bollCalc(closes, period = 20, k = 2) {
  const empty = { upper: null, mid: null, lower: null, percentB: null, bandwidth: null };
  if (closes.length < period) return empty;
  const win = closes.slice(-period);
  const mid = mean(win);
  const sd = stdev(win);
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  const width = upper - lower;
  const last = closes[closes.length - 1];
  const percentB = width > 0 ? (last - lower) / width : 0.5;
  const bandwidth = mid > 0 ? (width / mid) * 100 : null;
  return { upper, mid, lower, percentB, bandwidth };
}

/** True Range 序列。首根用 high-low。 */
function trueRangeSeries(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

/** Wilder 平滑的平均值（用于 ATR）。 */
function wilderSmooth(values, period) {
  if (!values.length || values.length < period) return null;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  let avg = sum / period;
  for (let i = period; i < values.length; i += 1) {
    avg = (avg * (period - 1) + values[i]) / period;
  }
  return avg;
}

/** 相对 back 根之前的涨跌幅 %。 */
function pctChange(closes, back) {
  const n = closes.length;
  if (n < back + 1) return null;
  const cur = closes[n - 1];
  const prev = closes[n - 1 - back];
  if (!(prev > 0)) return null;
  return (cur / prev - 1) * 100;
}

/** 区间极值：最近 period 根内的最大 high 或最小 low。 */
function extremeOf(bars, key, period) {
  if (!bars.length) return null;
  const win = bars.slice(-period);
  let out = null;
  for (const b of win) {
    const v = key === 'high' ? b.high : b.low;
    if (!isNum(v)) continue;
    if (out === null) out = v;
    else out = key === 'high' ? Math.max(out, v) : Math.min(out, v);
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════
 * 3. K 线规范化（防御外部脏数据）
 * ════════════════════════════════════════════════════════════════ */

/**
 * 把外部 bars 规范化成 { date, open, close, high, low, volume } 的纯数字对象。
 * 缺少有效收盘价的条目直接剔除并记录 warning；high/low 用 close/open 兜底，
 * 保证后续所有指标不会因为 NaN 而污染整条序列。
 */
function normalizeBars(rawBars, warnings) {
  const out = [];
  let dropped = 0;
  let zeroVolume = 0;
  for (const b of rawBars) {
    if (!b || typeof b !== 'object') {
      dropped += 1;
      continue;
    }
    const close = num(b.close);
    if (close === null || close <= 0) {
      dropped += 1;
      continue;
    }
    const openRaw = num(b.open);
    const highRaw = num(b.high);
    const lowRaw = num(b.low);
    const volumeRaw = num(b.volume);
    const open = openRaw !== null && openRaw > 0 ? openRaw : close;
    // high 必须 >= close/open，low 必须 <= close/open；异常值用 max/min 修正而不是丢弃。
    const high = Math.max(close, open, highRaw !== null && highRaw > 0 ? highRaw : close);
    const low = Math.min(close, open, lowRaw !== null && lowRaw > 0 ? lowRaw : close);
    const volume = volumeRaw !== null && volumeRaw >= 0 ? volumeRaw : 0;
    if (volume === 0) zeroVolume += 1;
    out.push({ date: str(b.date), open, close, high, low, volume });
  }
  if (dropped > 0) {
    warnings.push(`${dropped} 根 K 线缺少有效收盘价，已剔除，实际仅用 ${out.length} 根`);
  }
  if (out.length > 0 && zeroVolume === out.length) {
    warnings.push('全部 K 线成交量为 0，量能类指标不可用，量能因子按中性处理');
  } else if (zeroVolume > 0) {
    warnings.push(`有 ${zeroVolume} 根 K 线成交量为 0（含停牌日），量能指标可能失真`);
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════
 * 4. computeIndicators —— 契约冻结的指标出口
 * ════════════════════════════════════════════════════════════════ */

/**
 * 计算技术指标。纯函数。
 * @param {object[]} bars 升序日 K:[{ date, open, close, high, low, volume }]
 * @returns {object} Indicators（字段见 CONTRACT.md）
 */
export function computeIndicators(bars) {
  const silent = [];
  const list = normalizeBars(Array.isArray(bars) ? bars : [], silent);
  const closes = list.map((b) => b.close);
  const volumes = list.map((b) => b.volume);
  const n = closes.length;

  const ma5All = smaSeries(closes, 5);
  const ma10All = smaSeries(closes, 10);
  const ma20All = smaSeries(closes, 20);
  const ma60All = smaSeries(closes, 60);
  const lastOf = (arr) => (n > 0 ? arr[n - 1] : null);

  const ma = {
    ma5: lastOf(ma5All),
    ma10: lastOf(ma10All),
    ma20: lastOf(ma20All),
    ma60: lastOf(ma60All),
  };

  const macd = macdCalc(closes);
  const boll = bollCalc(closes, 20, 2);

  const atr14 = wilderSmooth(trueRangeSeries(list), 14);
  const lastClose = n > 0 ? closes[n - 1] : null;
  const atrPercent = isNum(atr14) && isNum(lastClose) && lastClose > 0 ? (atr14 / lastClose) * 100 : null;

  const volMa5 = n >= 5 ? lastOf(smaSeries(volumes, 5)) : null;
  const volMa20 = n >= 20 ? lastOf(smaSeries(volumes, 20)) : null;

  // 连续涨跌天数（按收盘价同比，平盘中断连续计数）
  let consecutiveUp = 0;
  let consecutiveDown = 0;
  for (let i = n - 1; i >= 1; i -= 1) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) {
      if (consecutiveDown > 0) break;
      consecutiveUp += 1;
    } else if (d < 0) {
      if (consecutiveUp > 0) break;
      consecutiveDown += 1;
    } else {
      break;
    }
  }

  // MA20 近 5 日斜率（百分比）：反映中期趋势的加速度方向
  let ma20SlopePercent = null;
  if (n >= 6) {
    const latest = ma20All[n - 1];
    const prev = ma20All[n - 6];
    if (isNum(latest) && isNum(prev) && prev > 0) {
      ma20SlopePercent = (latest / prev - 1) * 100;
    }
  }

  // 连续站上 MA20 的天数
  let aboveMa20Days = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    const m = ma20All[i];
    if (!isNum(m)) break;
    if (closes[i] > m) aboveMa20Days += 1;
    else break;
  }

  return {
    closes,
    ma,
    maSeries: { ma5: ma5All, ma20: ma20All },
    rsi14: rsiWilder(closes, 14),
    macd: { dif: macd.dif, dea: macd.dea, hist: macd.hist },
    macdPrevHist: macd.prevHist,
    boll,
    atr14,
    atrPercent,
    volumeMa5: volMa5,
    volumeMa20: volMa20,
    high60: extremeOf(list, 'high', 60),
    low60: extremeOf(list, 'low', 60),
    high250: extremeOf(list, 'high', 250),
    low250: extremeOf(list, 'low', 250),
    returns: {
      d1: pctChange(closes, 1),
      d5: pctChange(closes, 5),
      d20: pctChange(closes, 20),
      d60: pctChange(closes, 60),
    },
    consecutiveUp,
    consecutiveDown,
    ma20SlopePercent,
    aboveMa20Days,
    // 以下为非契约字段，仅供内部/调试使用，不影响契约字段语义
    _ma10Series: ma10All,
    _ma60Series: ma60All,
    _ma20Series: ma20All,
  };
}

/* ════════════════════════════════════════════════════════════════
 * 5. 因子评分
 *    每个因子返回 { score, signals, risks }
 *    score: 0-100 的「看多程度」；signals: 2-5 条中文依据；risks: 可并入全局风险列表
 * ════════════════════════════════════════════════════════════════ */

/** 多周期收益的加权综合（短期权重更高），单位 %。数据不足时降级取可用项。 */
function compositeReturn(returns) {
  const parts = [
    [returns.d1, 0.15],
    [returns.d5, 0.3],
    [returns.d20, 0.35],
    [returns.d60, 0.2],
  ];
  let acc = 0;
  let wsum = 0;
  for (const [v, w] of parts) {
    if (isNum(v)) {
      acc += v * w;
      wsum += w;
    }
  }
  if (wsum === 0) return null;
  return acc / wsum;
}

/**
 * 判断当前处于「有方向的趋势」还是「无方向的震荡」。
 *
 * 这是本引擎最重要的一处口径选择：同一组指标在两种市场状态下的含义是相反的。
 *   - 趋势市：RSI 高 = 强势延续（趋势跟随）
 *   - 震荡市：RSI 高 = 区间超买（均值回归）
 * 如果只做一种假设，那么任何 20 日周期的横盘都会因为处在振荡的上升段而被
 * 判成「多头」，这正是最初版本的主要缺陷。
 *
 * 判据（两条任一满足即视为趋势市）：
 *   1. MA20 近 5 日斜率绝对值 >= 0.25%（5 日累计约 1.25%）
 *   2. MA20 与 MA60 的间距 >= 1.5%（中期均线已经分开，不再是纠缠状态）
 * 判不出来（数据不足）时按震荡保守处理，因为震荡模式的评分更接近中性。
 */
function marketRegime(ind) {
  const slope = ind.ma20SlopePercent;
  if (isNum(slope) && Math.abs(slope) >= 0.25) return true;
  const ma20 = ind.ma.ma20;
  const ma60 = ind.ma.ma60;
  if (isNum(ma20) && isNum(ma60) && ma60 > 0) {
    if (Math.abs(ma20 - ma60) / ma60 >= 0.015) return true;
  }
  return false;
}

/**
 * 趋势因子（权重 0.28）。
 * 基础 50 分，从五个可解释维度加减：
 *   1. 均线排列           ±20（四对均线，每对 ±5，并按间距强度折算：间距达 3% 才计满分，
 *                              避免震荡市里 1% 的均线间差被读成「多头排列」）
 *   2. 价格与均线相对位置  ±12（price 对 MA5 ±4、MA20 ±5、MA60 ±3；震荡市打 6 折）
 *   3. MA20 近 5 日斜率    ±18（斜率每 1% 计 6 分，封顶 ±18）
 *   4. MACD 方向/柱体     ±16（DIF 位置、金叉、柱体正负、柱体增减各 ±4）
 *   5. 连续站上 MA20      0~+8（每日 1 分，封顶 8，但乘以 MA20 斜率置信度：
 *                              MA20 走平时天数再多也只能拿到 25% 的分）
 * 相对差 0.05% 以内视为持平，不计分（避免横盘时被噪声推成单边）。
 */
function scoreTrend(ctx) {
  const { ind, price, trending } = ctx;
  const { ma, macd, macdPrevHist, ma20SlopePercent, aboveMa20Days } = ind;
  const signals = [];
  let score = 50;

  /** 一对均线的排列强度分：方向 × 间距饱和 × 5 分。 */
  const alignStrength = (a, b) => {
    const d = dirOf(a, b);
    if (d === 0) return 0;
    const gap = Math.abs(a - b) / Math.abs(b || 1);
    return d * clamp(gap / 0.03, 0.15, 1) * 5;
  };

  // 1) 均线排列 ±20 ---------------------------------------------------
  const pairs = [
    [ma.ma5, ma.ma10],
    [ma.ma10, ma.ma20],
    [ma.ma20, ma.ma60],
  ];
  let align = 0;
  let alignCount = 0;
  for (const [a, b] of pairs) {
    if (!isNum(a) || !isNum(b)) continue;
    alignCount += 1;
    align += alignStrength(a, b);
  }
  if (isNum(ma.ma5) && isNum(ma.ma60)) {
    alignCount += 1;
    align += alignStrength(ma.ma5, ma.ma60);
  }
  if (alignCount > 0) {
    // 样本不足时按可得对数等比缩放，保持量纲一致
    score += (align * 4) / alignCount;
  }

  if (isNum(ma.ma20)) {
    const full = [ma.ma5, ma.ma10, ma.ma20, ma.ma60].every(isNum);
    const tri = [ma.ma5, ma.ma10, ma.ma20].every(isNum);
    if (full) {
      const bull = dirOf(ma.ma5, ma.ma10) > 0 && dirOf(ma.ma10, ma.ma20) > 0 && dirOf(ma.ma20, ma.ma60) > 0;
      const bear = dirOf(ma.ma5, ma.ma10) < 0 && dirOf(ma.ma10, ma.ma20) < 0 && dirOf(ma.ma20, ma.ma60) < 0;
      if (bull) {
        signals.push('均线系统呈完全多头排列（MA5 > MA10 > MA20 > MA60），短中长期趋势一致向上');
      } else if (bear) {
        signals.push('均线系统呈完全空头排列（MA5 < MA10 < MA20 < MA60），短中长期趋势一致向下');
      } else if (dirOf(ma.ma5, ma.ma10) > 0 && dirOf(ma.ma10, ma.ma20) > 0) {
        signals.push(`短期均线 MA5/MA10/MA20 已呈多头排列，但长期均线 MA60 仍在 MA20 之上形成压制`);
      } else if (dirOf(ma.ma5, ma.ma10) < 0 && dirOf(ma.ma10, ma.ma20) < 0) {
        signals.push('短期均线 MA5/MA10/MA20 呈空头排列，反弹尚未获得均线确认');
      } else {
        signals.push('均线系统方向不一致（MA5/MA10/MA20/MA60 相互缠绕），趋势方向尚未确立');
      }
    } else if (tri) {
      const shortBull = dirOf(ma.ma5, ma.ma10) > 0 && dirOf(ma.ma10, ma.ma20) > 0;
      const shortBear = dirOf(ma.ma5, ma.ma10) < 0 && dirOf(ma.ma10, ma.ma20) < 0;
      if (shortBull) signals.push('短期均线多头排列（MA5 > MA10 > MA20），但样本不足 60 根，中期趋势暂无法确认');
      else if (shortBear) signals.push('短期均线空头排列（MA5 < MA10 < MA20），但样本不足 60 根，中期趋势暂无法确认');
      else signals.push('短期均线相互缠绕，短期方向不明');
    }
  }

  // MA5 / MA20 金叉死叉（用序列的前值判断「穿越」事件）------------------
  const s5 = ind.maSeries.ma5;
  const s20 = ind.maSeries.ma20;
  const m = s5.length;
  if (m >= 2) {
    const a0 = s5[m - 2];
    const b0 = s20[m - 2];
    const a1 = s5[m - 1];
    const b1 = s20[m - 1];
    if (isNum(a0) && isNum(b0) && isNum(a1) && isNum(b1)) {
      if (a0 <= b0 && a1 > b1) signals.push('MA5 上穿 MA20，形成金叉，短期动能转强');
      else if (a0 >= b0 && a1 < b1) signals.push('MA5 下穿 MA20，形成死叉，短期动能转弱');
    }
  }

  // 2) 价格与均线相对位置 ±12（震荡市打 6 折：横盘中价格在均线两侧来回穿）----
  let pos = 0;
  let posCount = 0;
  const relMa = [
    [ma.ma5, 4],
    [ma.ma20, 5],
    [ma.ma60, 3],
  ];
  for (const [mv, w] of relMa) {
    if (!isNum(mv) || !isNum(price)) continue;
    posCount += 1;
    pos += dirOf(price, mv) * w;
  }
  if (posCount > 0) score += ((pos * 3) / posCount) * (trending ? 1 : 0.6);

  if (isNum(ma.ma20) && isNum(price)) {
    const d = dirOf(price, ma.ma20);
    if (d > 0) {
      signals.push(`现价 ${fmtPrice(price)} 站上 MA20（${fmtPrice(ma.ma20)}），中期均线构成支撑`);
    } else if (d < 0) {
      signals.push(`现价 ${fmtPrice(price)} 位于 MA20（${fmtPrice(ma.ma20)}）之下，中期均线转为压制`);
    } else {
      signals.push(`现价与 MA20（${fmtPrice(ma.ma20)}）基本重合，处于方向选择的临界位置`);
    }
  }

  // 3) MA20 斜率 ±18 ------------------------------------------------
  if (isNum(ma20SlopePercent)) {
    score += clamp(ma20SlopePercent * 6, -18, 18);
    if (ma20SlopePercent >= 0.6) {
      signals.push(`MA20 近 5 日斜率 ${fmtPct(ma20SlopePercent)}，中期趋势明确向上`);
    } else if (ma20SlopePercent >= 0.15) {
      signals.push(`MA20 近 5 日斜率 ${fmtPct(ma20SlopePercent)}，中期均线缓慢上倾，方向偏多但力度有限`);
    } else if (ma20SlopePercent <= -0.6) {
      signals.push(`MA20 近 5 日斜率 ${fmtPct(ma20SlopePercent)}，中期趋势明确向下`);
    } else if (ma20SlopePercent <= -0.15) {
      signals.push(`MA20 近 5 日斜率 ${fmtPct(ma20SlopePercent)}，中期均线缓慢下倾，方向偏空但力度有限`);
    } else {
      signals.push(`MA20 近 5 日斜率 ${fmtPct(ma20SlopePercent)}，中期均线基本走平，不构成方向指引`);
    }
  }

  // 4) MACD ±16 -----------------------------------------------------
  if (isNum(macd.dif) && isNum(macd.dea)) {
    let macdScore = 0;
    macdScore += dirOf(macd.dif, 0) * 4;
    macdScore += dirOf(macd.dif, macd.dea) * 4;
    macdScore += dirOf(macd.hist, 0) * 4;
    if (isNum(macdPrevHist)) macdScore += dirOf(macd.hist, macdPrevHist) * 4;
    score += clamp(macdScore, -16, 16);
    // 金叉/死叉本身不区分多空，还要看 DIF 在零轴的哪一侧：
    // 零轴上方的金叉是强势延续，零轴下方的金叉只是弱势反弹。
    if (dirOf(macd.dif, macd.dea) > 0) {
      signals.push(macd.dif >= 0
        ? 'MACD 的 DIF 上穿 DEA 且位于零轴上方，属强势多头格局'
        : 'MACD 的 DIF 上穿 DEA 但仍位于零轴下方，属下跌途中的反弹，尚不构成多头格局');
    } else if (dirOf(macd.dif, macd.dea) < 0) {
      signals.push(macd.dif >= 0
        ? 'MACD 的 DIF 下穿 DEA 且已回落，多头格局出现松动'
        : 'MACD 的 DIF 下穿 DEA 且位于零轴下方，属空头格局');
    }
  }

  // 5) 连续站上 MA20 -------------------------------------------------
  if (aboveMa20Days > 0) {
    // 只有 MA20 本身在走，连续站上才有意义；走平则是区间内反复，只给 25% 的分
    const conf = isNum(ma20SlopePercent) && Math.abs(ma20SlopePercent) >= 0.1 ? 1 : 0.25;
    score += Math.min(aboveMa20Days, 8) * conf;
    if (conf === 1) {
      signals.push(`已连续 ${aboveMa20Days} 个交易日收盘站上 MA20，中期支撑有效性提升`);
    } else {
      signals.push(`已连续 ${aboveMa20Days} 个交易日收盘站上 MA20，但 MA20 本身走平，支撑意义有限`);
    }
  } else if (isNum(ma.ma20)) {
    score -= 4;
    signals.push('最新收盘未能站上 MA20，中期支撑暂时失守');
  }

  return {
    score: clamp(score, 0, 100),
    signals: ensureSignals(signals, [
      '均线样本不足，趋势判断可靠性下降',
      '该因子按可得数据做了降级计算',
    ]),
    risks: [],
  };
}

/**
 * 动量因子（权重 0.22）。
 * 三个子分数加权平均（权重按可用性归一化）：
 *   RSI14 子分数  0.40 —— 分段映射，**映射曲线随市场状态切换**（见下）
 *   MACD  子分数  0.25 —— 50 起算，DIF 正负/金叉/柱体正负/柱体增减各 ±10、±10、±6、±4
 *   收益  子分数  0.35 —— 多周期综合涨幅（d1×.15+d5×.3+d20×.35+d60×.2），每 1% 计 4 分
 *
 * RSI 为什么必须分状态：
 *   趋势市 —— RSI 高代表强势延续，55~70 是「最舒服的强势区」，>85 才开始警惕。
 *   震荡市 —— RSI 高代表区间超买，均值回归压力大，所以 60 以上即开始回落，
 *             25 以下反而给分（超卖反弹）。若不分状态，任何周期性横盘在振荡
 *             上行段都会被 RSI 推成「多头」，这是技术评分最常见的误判来源。
 */
function scoreMomentum(ctx) {
  const { ind, trending } = ctx;
  const { rsi14, macd, macdPrevHist, returns } = ind;
  const signals = [];
  const parts = [];

  // 趋势市：强势延续占主导
  const rsiCurveTrending = [
    [0, 22],
    [15, 24],
    [30, 38],
    [45, 50],
    [55, 68],
    [62, 84],
    [70, 80],
    [75, 66],
    [85, 44],
    [100, 32],
  ];
  // 震荡市：超买回落 / 超卖反弹
  const rsiCurveRanging = [
    [0, 45],
    [10, 50],
    [20, 56],
    [30, 58],
    [40, 54],
    [50, 50],
    [60, 44],
    [70, 36],
    [80, 28],
    [90, 22],
    [100, 18],
  ];

  // RSI 子分数
  if (isNum(rsi14)) {
    const rsiScore = piecewise(trending ? rsiCurveTrending : rsiCurveRanging, rsi14);
    parts.push({ score: rsiScore, weight: 0.4 });
    if (trending) {
      if (rsi14 >= 75) {
        signals.push(`RSI14 = ${round(rsi14, 1)}，已进入超买区（>70 且继续走高），短线追高风险上升`);
      } else if (rsi14 <= 30) {
        signals.push(`RSI14 = ${round(rsi14, 1)}，处于超卖区（<30），技术性反弹需求存在但趋势仍弱`);
      } else if (rsi14 > 50) {
        signals.push(`RSI14 = ${round(rsi14, 1)}，位于 50 上方的强势区，多头动能占优`);
      } else {
        signals.push(`RSI14 = ${round(rsi14, 1)}，位于 50 下方的弱势区，多头动能不足`);
      }
    } else if (rsi14 >= 65) {
      signals.push(`RSI14 = ${round(rsi14, 1)}，震荡格局中已进入区间超买，均值回归压力偏大`);
    } else if (rsi14 <= 30) {
      signals.push(`RSI14 = ${round(rsi14, 1)}，震荡格局中处于区间超卖，存在技术性反弹空间`);
    } else {
      signals.push(`RSI14 = ${round(rsi14, 1)}，处于震荡区间的中部，未形成方向性动能`);
    }
  }

  // MACD 子分数
  if (isNum(macd.dif) && isNum(macd.dea) && isNum(macd.hist)) {
    let ms = 50;
    ms += dirOf(macd.dif, 0) * 10;
    ms += dirOf(macd.dif, macd.dea) * 10;
    ms += dirOf(macd.hist, 0) * 6;
    if (isNum(macdPrevHist)) ms += dirOf(macd.hist, macdPrevHist) * 4;
    parts.push({ score: clamp(ms, 0, 100), weight: 0.25 });
    if (isNum(macdPrevHist)) {
      // 柱体在零轴下方的红柱只是「跌势放缓」，不能说成上涨动能增强。
      const belowZero = isNum(macd.dif) && macd.dif < 0 && isNum(macd.dea) && macd.dea < 0;
      if (macd.hist > 0 && macd.hist > macdPrevHist) {
        signals.push(belowZero
          ? 'MACD 红柱放大，但 DIF 与 DEA 均在零轴下方，属跌势中的反弹修复'
          : 'MACD 红柱持续放大，上涨动能仍在增强');
      } else if (macd.hist > 0 && macd.hist <= macdPrevHist) {
        signals.push(belowZero
          ? 'MACD 红柱收窄，零轴下方的反弹力度减弱'
          : 'MACD 红柱开始缩短，上涨动能出现衰减迹象');
      } else if (macd.hist < 0 && macd.hist < macdPrevHist) {
        signals.push('MACD 绿柱持续放大，下跌动能仍在增强');
      } else {
        signals.push('MACD 绿柱开始收窄，下跌动能出现减弱迹象');
      }
    }
  }

  // 多周期收益子分数
  const comp = compositeReturn(returns);
  if (comp !== null) {
    parts.push({ score: clamp(50 + comp * 4, 0, 100), weight: 0.35 });
    const bits = [];
    if (isNum(returns.d1)) bits.push(`近 1 日 ${fmtPct(returns.d1)}`);
    if (isNum(returns.d5)) bits.push(`近 5 日 ${fmtPct(returns.d5)}`);
    if (isNum(returns.d20)) bits.push(`近 20 日 ${fmtPct(returns.d20)}`);
    if (isNum(returns.d60)) bits.push(`近 60 日 ${fmtPct(returns.d60)}`);
    if (bits.length) {
      signals.push(
        `${bits.join('，')}，${comp > 0 ? '多周期收益整体为正，动量向上' : comp < 0 ? '多周期收益整体为负，动量向下' : '多周期收益基本持平'}`,
      );
    }
  }

  if (!parts.length) {
    return {
      score: 50,
      signals: ensureSignals([], [
        'K 线样本不足 15 根，RSI/MACD 无法计算',
        '动量因子按中性 50 分处理',
      ]),
      risks: ['样本不足 15 根，动量类指标完全缺失，判断可靠性很低'],
    };
  }

  let acc = 0;
  let wsum = 0;
  for (const p of parts) {
    acc += p.score * p.weight;
    wsum += p.weight;
  }

  return {
    score: clamp(acc / wsum, 0, 100),
    signals: ensureSignals(signals, ['可用动量指标有限，结论参考价值下降', '该因子按可得数据做了降级计算']),
    risks: [],
  };
}

/**
 * 量能因子（权重 0.18）。
 * 基础 50 分，三个维度：
 *   1. 当日量价配合       ±20 —— 量比（相对 5 日均量）分档 × 价格方向
 *         ≥2.5 放量：涨 +20 / 跌 -20；≥1.8：±16；≥1.3：±10；0.8~1.3：±2（常态）
 *         <0.8 缩量：涨 +3（惜售）/ 跌 +4（抛压衰竭，仍略偏空所以给小正值）
 *   2. 量能趋势          ±15 —— (5 日均量 / 20 日均量 - 1) × 40，乘以短期价格方向
 *         价涨量增 = 加分，价跌量增 = 扣分，价涨量缩 = 小加分（量价背离但趋势尚在）
 *   3. 近 10 日量价健康度 ±15 —— 放量上涨天数 - 放量下跌天数，每天差 1.5 分
 * 停牌直接返回 50 分中性，避免「无成交」被误读成「无量下跌」。
 */
function scoreVolume(ctx) {
  const { ind, bars, price, changePercent, suspended } = ctx;

  if (suspended) {
    return {
      score: 50,
      signals: [
        '当日停牌（成交量为 0），无法形成有效量价关系',
        '量能因子按中性 50 分处理，其余指标沿用停牌前数据',
      ],
      risks: ['停牌期间无流动性，复牌后可能出现补涨或补跌缺口'],
    };
  }

  const n = bars.length;
  if (n === 0) {
    return {
      score: 50,
      signals: ['没有 K 线数据，量能无法计算', '量能因子按中性 50 分处理'],
      risks: [],
    };
  }

  const last = bars[n - 1];
  const signals = [];
  let score = 50;

  const volMa5 = ind.volumeMa5;
  const volMa20 = ind.volumeMa20;
  const v5 = isNum(volMa5) && volMa5 > 0 ? last.volume / volMa5 : null;
  const v20 = isNum(volMa20) && volMa20 > 0 ? last.volume / volMa20 : null;
  const dayChange = isNum(changePercent) ? changePercent : ind.returns.d1;
  const up = isNum(dayChange) ? dayChange > 0 : null;

  // 1) 当日量价配合 ±20
  if (isNum(v5) && up !== null) {
    let delta;
    if (v5 >= 2.5) delta = up ? 20 : -20;
    else if (v5 >= 1.8) delta = up ? 16 : -16;
    else if (v5 >= 1.3) delta = up ? 10 : -10;
    else if (v5 >= 0.8) delta = up ? 2 : -2;
    else if (v5 >= 0.5) delta = up ? 3 : 4;
    else delta = up ? 1 : 2;
    score += delta;

    const vr = round(v5, 2);
    if (up && v5 >= 1.8) {
      signals.push(`成交量为近 5 日均量的 ${vr} 倍，放量上攻，资金流入积极`);
    } else if (!up && v5 >= 1.8) {
      signals.push(`成交量为近 5 日均量的 ${vr} 倍，放量下跌，抛压明显`);
    } else if (up && v5 < 0.8) {
      signals.push(`成交量为近 5 日均量的 ${vr} 倍，缩量上涨，追高意愿不强`);
    } else if (!up && v5 < 0.8) {
      signals.push(`成交量为近 5 日均量的 ${vr} 倍，缩量下跌，抛压有所衰竭`);
    } else {
      signals.push(`成交量为近 5 日均量的 ${vr} 倍，量能温和，${up ? '小幅放量上行' : '小幅放量下行'}`);
    }

    if (isNum(v20)) {
      signals.push(`当日成交量为 20 日均量的 ${round(v20, 2)} 倍，${v20 >= 1.2 ? '量能高于一个月平均水平' : v20 <= 0.8 ? '量能低于一个月平均水平' : '量能接近一个月平均水平'}`);
    }
  } else if (isNum(last.volume) && last.volume === 0) {
    signals.push('当日成交量为 0，量能数据缺失');
  }

  // 2) 量能趋势 ±15
  const shortRet = isNum(ind.returns.d5) ? ind.returns.d5 : isNum(ind.returns.d1) ? ind.returns.d1 : isNum(ind.returns.d20) ? ind.returns.d20 : null;
  if (isNum(volMa5) && isNum(volMa20) && volMa20 > 0 && isNum(shortRet)) {
    const energy = volMa5 / volMa20;
    const dir = isNum(shortRet) ? (isTie(shortRet, 0, 0.00005) ? 0 : shortRet > 0 ? 1 : -1) : 0;
    score += clamp((energy - 1) * 40, -15, 15) * dir;
    const e = round(energy, 2);
    if (energy >= 1.1) {
      signals.push(
        `5 日均量为 20 日均量的 ${e} 倍，量能持续放大，${dir > 0 ? '与价格上行同向，属健康放量' : dir < 0 ? '与价格下行同向，属放量杀跌' : '但价格方向不明'}`,
      );
    } else if (energy <= 0.9) {
      signals.push(
        `5 日均量为 20 日均量的 ${e} 倍，量能逐步萎缩，${dir > 0 ? '上涨缺少量能支撑' : dir < 0 ? '下跌动力在衰减' : '市场观望情绪浓厚'}`,
      );
    } else {
      signals.push(`5 日均量为 20 日均量的 ${e} 倍，量能保持平稳`);
    }
  }

  // 3) 近 10 日量价健康度 ±15
  if (isNum(volMa20) && volMa20 > 0 && n >= 3) {
    const win = bars.slice(-10);
    let upVolDays = 0;
    let downVolDays = 0;
    for (let i = 1; i < win.length; i += 1) {
      const b = win[i];
      const p = win[i - 1];
      if (!(b.volume > volMa20)) continue;
      if (b.close > p.close) upVolDays += 1;
      else if (b.close < p.close) downVolDays += 1;
    }
    score += clamp((upVolDays - downVolDays) * 1.5, -15, 15);
    signals.push(
      `近 10 日有 ${upVolDays} 天放量上涨、${downVolDays} 天放量下跌，${upVolDays > downVolDays ? '量价配合偏健康' : upVolDays < downVolDays ? '放量下跌天数占优，量价关系偏弱' : '多空量能基本均衡'}`,
    );
  }

  if (isNum(price) && isNum(ind.volumeMa5) && ind.volumeMa5 > 0 && isNum(v5) && v5 > 3) {
    signals.push('当日换手显著放大（量比超过 3 倍），需警惕情绪化交易与次日波动放大');
  }

  return {
    score: clamp(score, 0, 100),
    signals: ensureSignals(signals, ['量能数据不足，量价关系无法完整判断', '量能因子按中性 50 分处理']),
    risks: [],
  };
}

/**
 * 位置因子（权重 0.16）。
 * 三个子分数加权：
 *   60 日区间分位 0.5 │ 250 日区间分位 0.2 │ 布林 %B 0.3
 *
 * 位置的含义同样随市场状态切换：
 *   趋势市 —— 越靠上越偏多（突破即强势延续），但 >95% 与 %B > 1 会回收分数以计入追高风险。
 *   震荡市 —— 越靠上越偏空（区间上沿 = 回调压力），越靠下越偏多（区间下沿 = 反弹支撑）。
 * 同一个「价格接近 60 日高点」的读数，在趋势市里是突破信号，在震荡市里是卖出信号，
 * 不分状态会把震荡市的上沿读成强势。
 */
function scorePosition(ctx) {
  const { ind, price, trending } = ctx;
  const { boll, high60, low60, high250, low250 } = ind;
  const signals = [];
  const parts = [];

  // 趋势市：低位小扣分、高位加分但顶部回收
  const posCurveTrending = [
    [0, 40],
    [0.15, 45],
    [0.3, 48],
    [0.5, 52],
    [0.7, 62],
    [0.85, 72],
    [0.95, 80],
    [1, 76],
  ];
  // 震荡市：均值回归取向，上沿偏空、下沿偏多
  const posCurveRanging = [
    [0, 62],
    [0.15, 58],
    [0.3, 54],
    [0.5, 50],
    [0.7, 46],
    [0.85, 40],
    [1, 33],
  ];
  const bCurveTrending = [
    [-1, 30],
    [0, 35],
    [0.2, 44],
    [0.5, 52],
    [0.7, 66],
    [0.9, 78],
    [1, 72],
    [1.3, 58],
    [2, 40],
  ];
  const bCurveRanging = [
    [-1, 66],
    [0, 62],
    [0.2, 58],
    [0.5, 50],
    [0.7, 42],
    [0.9, 35],
    [1, 30],
    [1.3, 24],
    [2, 16],
  ];

  const posCurve = trending ? posCurveTrending : posCurveRanging;
  const bCurve = trending ? bCurveTrending : bCurveRanging;
  const regimeText = trending ? '趋势格局' : '震荡格局';

  if (isNum(high60) && isNum(low60) && high60 > low60 && isNum(price)) {
    const p60 = clamp((price - low60) / (high60 - low60), 0, 1);
    parts.push({ score: piecewise(posCurve, p60), weight: 0.5 });
    const where60 = p60 >= 0.85 ? '上沿，回调压力上升' : p60 <= 0.15 ? '下沿，下方空间收窄' : '中部';
    signals.push(
      `现价处于 60 日区间（${fmtPrice(low60)} - ${fmtPrice(high60)}）的 ${Math.round(p60 * 100)}% 分位，${regimeText}下属于${where60}`,
    );
    if (trending && p60 >= 0.92) {
      signals.push('价格已逼近 60 日高点，向上突破需要成交量配合，否则易形成假突破');
    }
  }

  if (isNum(high250) && isNum(low250) && high250 > low250 && isNum(price)) {
    const p250 = clamp((price - low250) / (high250 - low250), 0, 1);
    parts.push({ score: piecewise(posCurve, p250), weight: 0.2 });
    signals.push(
      `现价处于 250 日区间（${fmtPrice(low250)} - ${fmtPrice(high250)}）的 ${Math.round(p250 * 100)}% 分位`,
    );
  }

  if (isNum(boll.percentB) && isNum(boll.upper) && isNum(boll.lower)) {
    parts.push({ score: piecewise(bCurve, boll.percentB), weight: 0.3 });
    const pb = round(boll.percentB, 2);
    if (boll.percentB >= 0.95) {
      const tail = trending ? '已进入超买区，追高风险上升' : '已触及区间上沿，均值回归压力偏大';
      signals.push(`布林 %B = ${pb}，价格已贴近或突破上轨（${fmtPrice(boll.upper)}），${tail}`);
    } else if (boll.percentB <= 0.05) {
      const tail = trending ? '处于超跌位置，弱势特征明显' : '已触及区间下沿，存在反弹机会';
      signals.push(`布林 %B = ${pb}，价格贴近或跌破下轨（${fmtPrice(boll.lower)}），${tail}`);
    } else {
      const where = boll.percentB >= 0.5 ? '中上部' : '中下部';
      signals.push(`布林 %B = ${pb}，价格位于布林带${where}（中轨 ${fmtPrice(boll.mid)}）`);
    }
  }

  if (!parts.length) {
    return {
      score: 50,
      signals: ensureSignals([], ['缺少足够的历史区间数据，无法判断价格位置', '位置因子按中性 50 分处理']),
      risks: [],
    };
  }

  let acc = 0;
  let wsum = 0;
  for (const p of parts) {
    acc += p.score * p.weight;
    wsum += p.weight;
  }

  return {
    score: clamp(acc / wsum, 0, 100),
    signals: ensureSignals(signals, ['区间数据有限，位置判断参考价值下降', '该因子按可得数据做了降级计算']),
    risks: [],
  };
}

/**
 * 波动因子（权重 0.10）。
 * ATR 占比 0.6 + 布林带宽 0.4 加权。
 * 映射取向是「有活力的正常波动最有利」：ATR% 在 1.2%-2% 给最高分（70 分上下），
 * 过低（<0.5%，死水）与过高（>8%，高风险）都扣分；带宽同理。
 * 波动不是方向信号，它衡量的是「同样的趋势能否被可信地延续」。
 */
function scoreVolatility(ctx) {
  const { ind } = ctx;
  const signals = [];
  const parts = [];

  if (isNum(ind.atrPercent)) {
    const s = piecewise(
      [
        [0, 45],
        [0.5, 55],
        [1.2, 66],
        [2, 70],
        [3.5, 66],
        [5, 55],
        [8, 40],
        [15, 20],
        [25, 10],
      ],
      ind.atrPercent,
    );
    parts.push({ score: s, weight: 0.6 });
    const a = round(ind.atrPercent, 2);
    if (ind.atrPercent > 8) {
      signals.push(`ATR 占现价 ${a}%，日内波动剧烈，止损与仓位控制难度大`);
    } else if (ind.atrPercent < 0.6) {
      signals.push(`ATR 占现价 ${a}%，波动极度收敛，方向选择往往需要外部催化`);
    } else {
      signals.push(`ATR 占现价 ${a}%，波动处于${ind.atrPercent > 3.5 ? '偏高' : '正常'}区间，趋势可信度尚可`);
    }
  }

  if (isNum(ind.boll.bandwidth)) {
    const s = piecewise(
      [
        [0, 50],
        [1, 58],
        [2.5, 64],
        [4, 64],
        [6, 55],
        [10, 42],
        [18, 28],
        [30, 14],
      ],
      ind.boll.bandwidth,
    );
    parts.push({ score: s, weight: 0.4 });
    const bw = round(ind.boll.bandwidth, 2);
    if (ind.boll.bandwidth < 2) {
      signals.push(`布林带宽 ${bw}%，处于极度收敛状态，可能是变盘前兆`);
    } else if (ind.boll.bandwidth > 10) {
      signals.push(`布林带宽 ${bw}%，波动区间显著扩张，风险敞口偏大`);
    } else {
      signals.push(`布林带宽 ${bw}%，波动带宽处于常态区间`);
    }
  }

  if (!parts.length) {
    return {
      score: 50,
      signals: ensureSignals([], ['样本不足 14 根，ATR 与布林带无法计算', '波动因子按中性 50 分处理']),
      risks: ['样本不足，无法评估波动风险'],
    };
  }

  let acc = 0;
  let wsum = 0;
  for (const p of parts) {
    acc += p.score * p.weight;
    wsum += p.weight;
  }

  return {
    score: clamp(acc / wsum, 0, 100),
    signals: ensureSignals(signals, ['波动指标有限，结论参考价值下降', '该因子按可得数据做了降级计算']),
    risks: [],
  };
}

/**
 * 风险因子（权重 0.06）—— 注意它是「安全度」而不是「危险度」：
 * 分数越高代表风险越低，所以总分越高越看多这一点在所有因子上口径一致。
 * 基础 55 分，扣分项（都可解释）：
 *   连续上涨 ≥4 天：每多 1 天扣 5，封顶 20（获利盘累积）
 *   连续下跌 ≥5 天：每多 1 天扣 4，封顶 16（弱势延续）
 *   MA20 乖离 |bias| > 10%：每超 1% 扣 1.5，封顶 22（均值回归压力）；+0~8% 的健康上行乖离 +5
 *   当日涨跌幅 ≥9.5% 扣 12、≥7% 扣 6；≤-9.5% 扣 18、≤-7% 扣 8（涨跌停附近的不确定性）
 *   ATR% > 6%：每超 1% 扣 3，封顶 20
 *   量比 > 4 且当日涨超 5%：扣 8（情绪过热）
 */
function scoreRisk(ctx) {
  const { ind, quote, price, changePercent, suspended, nBars } = ctx;
  const signals = [];
  const risks = [];
  let score = 55;

  // 没有 K 线也没有价格时，任何「风险很低」的结论都是误导，直接给中性
  if (nBars === 0 || !isNum(price)) {
    return {
      score: 50,
      signals: ['缺少价格与 K 线数据，无法评估偏离、连涨连跌与涨跌停风险', '风险因子按中性 50 分处理'],
      risks: ['无行情数据，风险状况未知'],
    };
  }

  if (suspended) {
    return {
      score: 50,
      signals: ['停牌状态下无法评估价格风险', '风险因子按中性 50 分处理'],
      risks: ['停牌期间流动性缺失，复牌价格存在跳空风险'],
    };
  }

  if (ind.consecutiveUp >= 4) {
    const penalty = Math.min((ind.consecutiveUp - 3) * 5, 20);
    score -= penalty;
    risks.push(`已连续 ${ind.consecutiveUp} 个交易日上涨，短线获利盘累积，回调风险上升`);
    signals.push(`连续上涨 ${ind.consecutiveUp} 天，按每日 5 分累计扣 ${penalty} 分（上限 20 分）`);
  } else if (ind.consecutiveDown >= 5) {
    const penalty = Math.min((ind.consecutiveDown - 4) * 4, 16);
    score -= penalty;
    risks.push(`已连续 ${ind.consecutiveDown} 个交易日下跌，弱势格局尚未扭转`);
    signals.push(`连续下跌 ${ind.consecutiveDown} 天，按每日 4 分累计扣 ${penalty} 分（上限 16 分）`);
  }

  const bias = isNum(ind.ma.ma20) && ind.ma.ma20 > 0 && isNum(price) ? ((price - ind.ma.ma20) / ind.ma.ma20) * 100 : null;
  if (bias !== null) {
    const abs = Math.abs(bias);
    if (abs > 10) {
      const penalty = Math.min((abs - 10) * 1.5, 22);
      score -= penalty;
      risks.push(`现价偏离 MA20 达 ${fmtPct(bias)}，短线向均线回归的压力较大`);
      signals.push(`MA20 乖离率 ${fmtPct(bias)}（超过 ±10% 的门槛），扣 ${round(penalty, 1)} 分`);
    } else if (bias > 0 && bias <= 8) {
      score += 5;
      signals.push(`MA20 乖离率 ${fmtPct(bias)}，处于健康上行的合理区间（0~8%）`);
    } else if (bias < -8) {
      score -= 5;
      signals.push(`MA20 乖离率 ${fmtPct(bias)}，负乖离偏大，弱势特征明显`);
    } else if (bias < 0) {
      signals.push(`MA20 乖离率 ${fmtPct(bias)}，价格在均线下方小幅偏离，尚属正常回踩`);
    } else {
      signals.push(`MA20 乖离率 ${fmtPct(bias)}，价格贴近均线运行，无显著偏离风险`);
    }
  }

  if (isNum(changePercent)) {
    if (changePercent >= 9.5) {
      score -= 12;
      risks.push('当日涨幅接近涨停，次日高开回落与情绪反转风险较高');
      signals.push(`当日涨幅 ${fmtPct(changePercent)}，接近涨停，扣 12 分（次日不确定性）`);
    } else if (changePercent >= 7) {
      score -= 6;
      signals.push(`当日涨幅 ${fmtPct(changePercent)}，短线涨幅偏大，扣 6 分`);
    } else if (changePercent <= -9.5) {
      score -= 18;
      risks.push('当日跌幅接近跌停，短期流动性与情绪风险显著');
      signals.push(`当日跌幅 ${fmtPct(changePercent)}，接近跌停，扣 18 分`);
    } else if (changePercent <= -7) {
      score -= 8;
      signals.push(`当日跌幅 ${fmtPct(changePercent)}，短线跌幅偏大，扣 8 分`);
    }
  }

  if (isNum(ind.atrPercent) && ind.atrPercent > 6) {
    const penalty = Math.min((ind.atrPercent - 6) * 3, 20);
    score -= penalty;
    risks.push(`ATR 波动率达 ${round(ind.atrPercent, 2)}%，价格波动风险偏高`);
    signals.push(`ATR 占现价 ${round(ind.atrPercent, 2)}%，波动过大，扣 ${round(penalty, 1)} 分`);
  }

  const vr = isNum(quote && quote.volumeRatio) ? quote.volumeRatio : null;
  if (isNum(vr) && vr > 4 && isNum(changePercent) && changePercent > 5) {
    score -= 8;
    risks.push('量比超过 4 倍且当日大涨，情绪化交易特征明显，警惕冲高回落');
    signals.push(`量比 ${round(vr, 2)} 倍配合大涨，扣 8 分（情绪过热）`);
  }

  // 若所有检查项都通过，给一条正面但具体的小结（说明查过什么），而不是空话。
  // 这条文案进的是 signals（「风险因子为什么给这个分」），不进 risks（风险列表）。
  if (!risks.length) {
    signals.push(
      `已核查连涨连跌、MA20 乖离、涨跌停幅度与 ATR 波动四项，均未触发风险阈值（本项 ${round(clamp(score, 0, 100), 1)} 分）`,
    );
  }

  // 注意：这里**不**往 risks 里塞「未检测到风险」的占位文案。
  // 占位文案会污染 risks 的语义（调用方会把它当成一条真实风险展示，
  // 于是 summary 里出现「主要风险：未检测到风险」这种病句）。
  // 「有没有显著风险」由 risks 数组是否为空这一结构信息表达，不做字符串匹配。
  return {
    score: clamp(score, 0, 100),
    signals: ensureSignals(signals, ['风险评估所需数据有限', '风险因子按中性处理']),
    risks,
  };
}

const FACTOR_FUNCS = Object.freeze({
  trend: scoreTrend,
  momentum: scoreMomentum,
  volume: scoreVolume,
  position: scorePosition,
  volatility: scoreVolatility,
  risk: scoreRisk,
});

/* ════════════════════════════════════════════════════════════════
 * 6. 支撑 / 压力位
 * ════════════════════════════════════════════════════════════════ */

/** 按价格量级决定保留几位小数。 */
function roundPrice(v) {
  if (!isNum(v)) return null;
  return v >= 10 ? round(v, 2) : round(v, 3);
}

/** 把价位按相对容差聚类，返回簇心价格列表。 */
function clusterLevels(values, tol) {
  const sorted = values.filter(isNum).sort((a, b) => a - b);
  const clusters = [];
  for (const v of sorted) {
    const cur = clusters[clusters.length - 1];
    if (cur && v - cur[cur.length - 1] <= tol) cur.push(v);
    else clusters.push([v]);
  }
  return clusters.map((c) => mean(c)).filter(isNum);
}

/**
 * 支撑/压力位：把近期高低点、各条均线、布林轨道、整数关口当作候选价位，
 * 按「相对现价 0.8% 以内视为同一档」聚类，再去重排序。
 *   支撑：取现价下方的价位，降序（最靠近现价者在前），最多 3 个
 *   压力：取现价上方的价位，升序（最靠近现价者在前），最多 3 个
 * 候选不足时用固定百分比（±3%/±5%）补足，保证 UI 有 2-3 条可展示的参考位。
 */
function buildLevels(ctx) {
  const { ind, bars, price } = ctx;
  if (!isNum(price) || price <= 0) return { support: [], resistance: [] };

  const cands = [];
  const push = (v) => {
    const n = num(v);
    if (n !== null && n > 0) cands.push(n);
  };

  push(ind.ma.ma5);
  push(ind.ma.ma10);
  push(ind.ma.ma20);
  push(ind.ma.ma60);
  push(ind.boll.upper);
  push(ind.boll.mid);
  push(ind.boll.lower);
  push(ind.high60);
  push(ind.low60);
  push(ind.high250);
  push(ind.low250);

  const win20 = bars.slice(-20);
  if (win20.length) {
    let hi = null;
    let lo = null;
    for (const b of win20) {
      hi = hi === null ? b.high : Math.max(hi, b.high);
      lo = lo === null ? b.low : Math.min(lo, b.low);
    }
    push(hi);
    push(lo);
  }

  // 整数关口：大价股用 10 元一档，中间价用 1 元，低价股用 0.5 元
  const step = price >= 100 ? 10 : price >= 10 ? 1 : 0.5;
  push(Math.floor(price / step) * step);
  push(Math.ceil(price / step) * step);

  const tol = price * 0.008;
  // 距离过滤：只保留现价 ±25% 以内的候选。
  // 真实场景里会出现「复权口径切换、长期停牌复牌跳空、数据源错位」导致的历史价位
  // 与现价相差数倍，这类价位当作支撑/压力毫无意义（如现价 1500 而「支撑」825）。
  // 过滤后若候选不足，由下面的固定百分比补足，保证 UI 永远有可展示的参考位。
  const nearBand = price * 0.25;
  const below = cands.filter((c) => c < price * (1 - NEUTRAL_BAND) && c >= price - nearBand);
  const above = cands.filter((c) => c > price * (1 + NEUTRAL_BAND) && c <= price + nearBand);

  const supCenters = clusterLevels(below, tol);
  const resCenters = clusterLevels(above, tol);

  const uniqSorted = (arr, desc) => {
    const sorted = [...arr].sort((a, b) => (desc ? b - a : a - b));
    const out = [];
    for (const v of sorted) {
      const r = roundPrice(v);
      if (r === null) continue;
      if (out.some((x) => Math.abs(x - r) < 1e-9)) continue;
      out.push(r);
    }
    return out;
  };

  let support = uniqSorted(supCenters, true).slice(0, 3);
  let resistance = uniqSorted(resCenters, false).slice(0, 3);

  if (support.length < 2) {
    for (const k of [0.97, 0.95]) {
      const v = roundPrice(price * k);
      if (v !== null && !support.some((x) => Math.abs(x - v) < 1e-9)) support.push(v);
      if (support.length >= 2) break;
    }
    support = uniqSorted(support, true).slice(0, 3);
  }
  if (resistance.length < 2) {
    for (const k of [1.03, 1.05]) {
      const v = roundPrice(price * k);
      if (v !== null && !resistance.some((x) => Math.abs(x - v) < 1e-9)) resistance.push(v);
      if (resistance.length >= 2) break;
    }
    resistance = uniqSorted(resistance, false).slice(0, 3);
  }

  return { support, resistance };
}

/* ════════════════════════════════════════════════════════════════
 * 7. 结论与概率
 * ════════════════════════════════════════════════════════════════ */

/**
 * 因子共振加成 / 扣减（±6）。
 *
 * 为什么需要它：6 个因子独立加权求和时存在一个结构性缺陷 —— 最强的单边行情
 * 必然同时具备「极高 RSI + 严重偏离均线 + 巨大波动」，于是风险与波动因子大幅扣分，
 * 把趋势满分、动量高分的标的压回中间区间。结果是评分器永远不敢对最强走势
 * 给出最强结论，这违背了「趋势跟随」的基本逻辑。
 *
 * 判据刻意要求三个维度同时确认（趋势 + 动量 + 位置），单靠趋势因子虚高不会触发，
 * 所以不会把震荡市里偶然的均线翘头放大成强烈看多。多空两侧完全对称。
 */
function resonanceBonus(factors) {
  const get = (key) => {
    const f = factors.find((x) => x.key === key);
    return f ? f.score : 50;
  };
  const trend = get('trend');
  const momentum = get('momentum');
  const position = get('position');
  if (trend >= 85 && momentum >= 65 && position >= 60) return 6;
  if (trend <= 15 && momentum <= 35 && position <= 45) return -6;
  return 0;
}

function verdictOf(score) {
  if (score >= VERDICT_THRESHOLDS.strongBull) return 'strong-bull';
  if (score >= VERDICT_THRESHOLDS.bull) return 'bull';
  if (score >= VERDICT_THRESHOLDS.bear) return 'neutral';
  if (score >= VERDICT_THRESHOLDS.strongBear) return 'bear';
  return 'strong-bear';
}

/**
 * 震荡市的中性归中方案。
 *
 * 为什么需要：横盘时各因子会围绕 50 上下随机摆动，七个因子的小幅偏差叠加后
 * 很容易累计成 ±20 分的「伪信号」。趋势因子那套「价格>均线就加分」的逻辑在
 * 均线粘合时会系统性地偏向均线刚刚上翘的那一侧，于是同一段横盘在不同相位
 * 会给出 42 分（bear）到 73 分（bull）—— 这显然是错的：震荡市本身没有方向。
 *
 * 判据（三条同时成立才归中，避免误伤慢牛/慢熊）：
 *   1. 不是趋势格局（marketRegime 为 false）
 *   2. 60 日振幅 < 18%（不是宽幅震荡）
 *   3. |RSI - 50| < 25（不是单边超买/超卖的慢趋势）
 * 归中强度 0.5：把分数与 50 的差距减半，任何 70 分都会收敛到 60 分以内。
 */
function neutralizationPlan({ ind, trending, rsi14 }) {
  const inactive = { active: false, strength: 1, reasons: [] };
  if (trending) return inactive;

  const reasons = [];
  const h = ind.high60;
  const l = ind.low60;
  if (!isNum(h) || !isNum(l) || !(l > 0)) return inactive;
  const amplitude = (h - l) / l;
  if (amplitude >= 0.18) return inactive;
  if (isNum(rsi14) && Math.abs(rsi14 - 50) >= 25) return inactive;

  reasons.push(`MA20 近 5 日斜率 ${fmtPct(ind.ma20SlopePercent)}，中期均线走平`);
  reasons.push(`60 日振幅 ${fmtPct(amplitude * 100)}，属于窄幅区间`);
  if (isNum(rsi14)) reasons.push(`RSI14 = ${round(rsi14, 1)}，贴近中位`);

  return { active: true, strength: 0.5, reasons };
}

/**
 * 把 0-100 总分映射成 0-1 的 upProbability。
 * 这是启发式映射（线性 + 置信度压缩），不是任何统计/概率模型输出。
 * confidence 由数据完整度决定：满样本 1，数据缺失时向 0.5 收敛，
 * 避免「只拿到 5 根 K 线却报出 90% 上涨概率」这种误导。
 */
function heuristicProbability(score, confidence) {
  const conf = clamp(isNum(confidence) ? confidence : 0.5, 0, 1);
  const raw = 0.5 + ((score - 50) / 100) * 0.9 * conf;
  return clamp(round(raw, 3), 0.05, 0.95);
}

/** 数据置信度：按样本量、快照可用性、成交有效性综合折算。 */
function dataConfidence({ nBars, hasQuote, suspended, zeroVolumeAll }) {
  let c = 0;
  if (nBars >= 250) c = 1;
  else if (nBars >= 120) c = 0.92;
  else if (nBars >= 60) c = 0.82;
  else if (nBars >= 30) c = 0.68;
  else if (nBars >= 15) c = 0.5;
  else if (nBars >= 5) c = 0.32;
  else if (nBars > 0) c = 0.18;
  if (!hasQuote) c *= 0.9;
  if (suspended) c *= 0.75;
  if (zeroVolumeAll) c *= 0.85;
  return clamp(c, 0, 1);
}

/**
 * 判断行情数据是否陈旧。
 *
 * stale **只**描述「数据时间」（末条 K 线是否覆盖到快照时点），
 * 与「有没有拿到实时快照」无关 —— 后者由 hasQuote 和 warnings 表达。
 * 纯函数实现：只用输入内部的日期证据，不读系统时钟。
 *
 * 判据：
 *   1. 没有 K 线 → stale = true（无任何可用数据）
 *   2. 有 quote.timestamp 且末条 bar 日期 < 快照日期 → stale = true（K 线落后于快照）
 *   3. 无快照、或快照不带可解析时间戳 → 无法核验，返回 false 并在 warnings 说明
 * @returns {{ stale: boolean, note: string|null }}
 */
function computeStale({ nBars, quote, lastBar }) {
  if (nBars === 0) return { stale: true, note: '无 K 线数据，无法确认数据时效' };

  const lastDate = str(lastBar && lastBar.date);
  const ts = quote ? str(quote.timestamp) : '';
  // 快照时间戳形如 'YYYY-MM-DD HH:mm:ss'，取日期段比较
  const snapDate = /^(\d{4}-\d{2}-\d{2})/.test(ts) ? ts.slice(0, 10) : '';

  if (lastDate && snapDate) {
    if (lastDate < snapDate) {
      return {
        stale: true,
        note: `末条 K 线日期为 ${lastDate}，早于快照时间 ${snapDate}，K 线数据未更新到最新交易日`,
      };
    }
    return { stale: false, note: null };
  }

  return {
    stale: false,
    note: '无实时快照或快照缺少时间戳，无法核验 K 线数据时效',
  };
}

/* ════════════════════════════════════════════════════════════════
 * 8. evaluateStock —— 评分主入口
 * ════════════════════════════════════════════════════════════════ */

/**
 * 评分主入口。纯函数，绝不联网。
 * @param {{ quote?: object|null, bars?: object[], code?: string, name?: string, secid?: string }} input
 * @returns {object} Evaluation（字段见 CONTRACT.md）
 */
export function evaluateStock(input) {
  const src = input && typeof input === 'object' ? input : {};
  const quote = src.quote && typeof src.quote === 'object' ? src.quote : null;
  const rawBars = Array.isArray(src.bars) ? src.bars : [];
  // v3 多市场：市场与货币从快照透传（quote 可能是 null，则回退显式传入的 market）
  const market = (quote && typeof quote.market === 'string' && quote.market) || (typeof src.market === 'string' && src.market) || null;
  const currency = (quote && typeof quote.currency === 'string' && quote.currency) || (typeof src.currency === 'string' && src.currency) || null;

  /* ── 数据规范化与质量告警 ─────────────────────────────────── */
  const warnings = [];
  const bars = normalizeBars(rawBars, warnings);
  const nBars = bars.length;

  if (nBars === 0) {
    warnings.push('K 线数据为空，无法计算任何技术指标，全部因子按中性 50 分处理');
  } else if (nBars < 30) {
    warnings.push(`仅 ${nBars} 根 K 线（少于 30 根），长周期指标不可得，评分已降级`);
  } else if (nBars < 60) {
    warnings.push(`仅 ${nBars} 根 K 线（少于 60 根），60 日均线与 60 日高低点不可得`);
  } else if (nBars < 250) {
    warnings.push(`仅 ${nBars} 根 K 线（少于 250 根），250 日高低点退化为全样本区间`);
  }

  // 顺序检查：契约要求升序，乱序会让收益率符号完全失真
  if (nBars >= 2) {
    let outOfOrder = 0;
    for (let i = 1; i < nBars; i += 1) {
      const a = bars[i - 1].date;
      const b = bars[i].date;
      if (a && b && a > b) outOfOrder += 1;
    }
    if (outOfOrder > 0) {
      warnings.push(`K 线未按日期升序排列（检出 ${outOfOrder} 处逆序），收益率与均线可能失真`);
    }
  }

  if (!quote) warnings.push('未获取到实时快照，改用最后一根 K 线的收盘价评估');

  /* ── 价格与涨跌幅 ─────────────────────────────────────────── */
  const ind = computeIndicators(bars);
  const lastBar = nBars > 0 ? bars[nBars - 1] : null;

  let price = null;
  let priceSource = 'none';
  const quotePrice = quote ? num(quote.price) : null;
  if (quotePrice !== null && quotePrice > 0) {
    price = quotePrice;
    priceSource = 'quote';
  } else if (lastBar && isNum(lastBar.close)) {
    price = lastBar.close;
    priceSource = 'bar';
    if (quote && quotePrice === 0) warnings.push('实时价格为 0（可能停牌或数据异常），改用最后一根 K 线收盘价');
  }
  if (price === null) warnings.push('无任何有效价格数据，价格相关指标不可用');

  const suspended =
    (quote && quote.isSuspended === true) || (priceSource === 'quote' && quotePrice === 0);

  let changePercent = quote ? num(quote.changePercent) : null;
  if (changePercent === null && isNum(ind.returns.d1)) changePercent = ind.returns.d1;

  const zeroVolumeAll = nBars > 0 && bars.every((b) => b.volume === 0);
  const confidence = dataConfidence({ nBars, hasQuote: Boolean(quote), suspended, zeroVolumeAll });

  /* ── 因子计算 ─────────────────────────────────────────────── */
  const trending = marketRegime(ind);
  const ctx = { ind, bars, quote, price, changePercent, nBars, suspended, trending };
  const allRisks = [];

  const factors = FACTOR_ORDER.map((key) => {
    const fn = FACTOR_FUNCS[key];
    let result;
    try {
      result = fn(ctx);
    } catch (err) {
      // 因子内部异常绝不允许冒泡：降级为中性并记录原因
      warnings.push(`因子 ${FACTOR_LABELS[key]} 计算异常（${err && err.message ? err.message : '未知错误'}），已退回中性 50 分`);
      result = { score: 50, signals: ['该因子计算异常，退回中性 50 分', '其余因子不受影响'], risks: [] };
    }
    const weight = WEIGHTS[key];
    const facScore = clamp(roundScore(result.score), 0, 100);
    if (Array.isArray(result.risks)) {
      for (const r of result.risks) {
        if (typeof r === 'string' && !allRisks.includes(r)) allRisks.push(r);
      }
    }
    return {
      key,
      label: FACTOR_LABELS[key],
      score: facScore,
      weight,
      contribution: round(facScore * weight, 2),
      signals: ensureSignals(result.signals, ['该因子数据不足', '按中性 50 分处理']),
    };
  });

  /* ── 总分 / 评级 ──────────────────────────────────────────── */
  let total = 0;
  for (const f of factors) total += f.score * f.weight;

  // 因子共振加成：弥补「加权和永远向中间收缩」的结构性缺陷，见 resonanceBonus 注释
  const bonus = resonanceBonus(factors);
  let score = clamp(roundScore(total + bonus), 0, 100);

  // 震荡市中性归中：没有趋势的时候，本评分器没有资格给出强结论
  const neutralPlan = neutralizationPlan({ ind, trending, rsi14: ind.rsi14 });
  if (neutralPlan.active) {
    score = clamp(roundScore(50 + (score - 50) * neutralPlan.strength), 0, 100);
    warnings.push(
      `当前处于震荡格局（${neutralPlan.reasons.join('、')}），总分已向中性 50 分收敛${Math.round((1 - neutralPlan.strength) * 100)}%`,
    );
  }

  const verdict = verdictOf(score);
  const verdictLabel = VERDICT_LABELS[verdict];
  const upProbability = heuristicProbability(score, confidence);

  /* ── 关键位 ───────────────────────────────────────────────── */
  const levels = buildLevels(ctx);

  /* ── 风险与摘要 ───────────────────────────────────────────── */
  const risks = allRisks.slice(0, 6);
  if (warnings.length > 0) risks.push('数据完整度不足，本次评分可靠性低于正常水平');

  const code = str(src.code) || (quote ? str(quote.code) : '');
  const secid = str(src.secid) || (quote ? str(quote.secid) : '');
  const name = quote ? str(quote.name) : str(src.name);

  const asOf =
    (quote ? str(quote.timestamp) : '') || (lastBar ? str(lastBar.date) : '') || '';

  const summary = buildSummary({
    name,
    code,
    score,
    verdictLabel,
    factors,
    risks,
    hasData: nBars > 0 && price !== null,
    probability: upProbability,
  });

  const staleInfo = computeStale({ nBars, quote, lastBar });
  if (staleInfo.note) warnings.push(staleInfo.note);

  return {
    code,
    secid,
    name,
    asOf,
    // v3 多市场：'sh'|'sz'|'bj'|'hk'|'us'，A 股以外会带 currency
    market,
    currency,
    price: isNum(price) ? round(price, price >= 10 ? 2 : 3) : null,
    changePercent: isNum(changePercent) ? round(changePercent, 2) : null,
    score,
    verdict,
    verdictLabel,
    upProbability,
    factors,
    levels,
    risks: risks.slice(0, 8),
    summary,
    disclaimer: DISCLAIMER,
    dataQuality: {
      bars: nBars,
      hasQuote: Boolean(quote),
      stale: staleInfo.stale,
      warnings,
    },
  };
}

/** 生成 2-4 句中文结论，必须包含「启发式估计，非概率模型输出」的标注。 */
function buildSummary({ name, code, score, verdictLabel, factors, risks, hasData, probability }) {
  const subject = name || code || '该标的';
  const sentences = [];
  const risky = Array.isArray(risks) && risks.length > 0;

  sentences.push(`${subject}当前多因子总分 ${score} 分（满分 100），评级「${verdictLabel}」。`);

  if (hasData && factors.length) {
    const sorted = [...factors].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best.key === worst.key) {
      sentences.push(`六个维度得分接近（最强${best.label} ${best.score} 分，权重 ${fmtWeight(best.weight)}），暂无明显主导因素。`);
    } else {
      sentences.push(
        `最强项是${best.label}（${best.score} 分，权重 ${fmtWeight(best.weight)}），最弱项是${worst.label}（${worst.score} 分），两者分化 ${round(best.score - worst.score, 1)} 分。`,
      );
    }
    // 结构化判断：risks 为空即「没有显著风险提示」，不要说成「主要风险是没风险」
    if (risky) {
      const first = String(risks[0]).replace(/[。；，,.\s]+$/, '');
      sentences.push(`主要风险：${first}。`);
    } else {
      sentences.push('目前未触发过热、超跌或涨跌停等显著风险信号。');
    }
  } else {
    sentences.push('由于缺少可用的行情数据，本次未形成有效判断，结果仅代表中性占位。');
  }

  sentences.push(
    `上行倾向 ${round(probability * 100, 0)}% 只是多因子打分的启发式估计，非概率模型输出，也不构成投资建议。`,
  );

  // 句子可能自带句号，也可能不带（例如 risks 原文被裁剪过），统一补齐再拼接，
  // 避免出现「…风险上行倾向…」这类两句黏连。
  return sentences
    .map((s) => {
      const t = String(s).trim();
      if (!t) return '';
      return /[。！？!?]$/.test(t) ? t : `${t}。`;
    })
    .filter(Boolean)
    .join('');
}

/* ════════════════════════════════════════════════════════════════
 * 9. evaluateMany —— 批量评分
 * ════════════════════════════════════════════════════════════════ */

/**
 * 批量评分。
 * @param {Array<{ quote?: object|null, bars?: object[], code?: string }>} inputs
 * @returns {object[]} 与 inputs 同长的 Evaluation 列表
 */
export function evaluateMany(inputs) {
  const list = Array.isArray(inputs) ? inputs : [];
  return list.map((item, index) => {
    try {
      return evaluateStock(item);
    } catch (err) {
      // evaluateStock 本身设计为不抛异常，这里是最后一道保险
      const msg = err && err.message ? err.message : '未知错误';
      return {
        code: str(item && item.code) || '',
        secid: '',
        name: '',
        asOf: '',
        price: null,
        changePercent: null,
        score: 50,
        verdict: 'neutral',
        verdictLabel: VERDICT_LABELS.neutral,
        upProbability: 0.5,
        factors: FACTOR_ORDER.map((key) => ({
          key,
          label: FACTOR_LABELS[key],
          score: 50,
          weight: WEIGHTS[key],
          contribution: round(50 * WEIGHTS[key], 2),
          signals: ['批量评分时该标的计算异常，退回中性 50 分', `错误信息：${msg}`],
        })),
        levels: { support: [], resistance: [] },
        risks: [`第 ${index + 1} 个标的评分异常：${msg}`],
        summary: `第 ${index + 1} 个标的评分异常，返回中性占位结果。上行倾向 50% 为启发式估计，非概率模型输出。`,
        disclaimer: DISCLAIMER,
        dataQuality: { bars: 0, hasQuote: false, stale: true, warnings: [`评分异常：${msg}`] },
      };
    }
  });
}
