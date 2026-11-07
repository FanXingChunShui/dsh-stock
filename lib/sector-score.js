/**
 * dsh-stock-surf / lib/sector-score.js
 * 板块（Sector）5 因子评分引擎。
 *
 * 设计约束（严格对齐 CONTRACT.md「v2 追加：板块（Sector）功能」）：
 *   - 纯函数：不联网、不读文件、不读环境变量、不引用 npm 依赖、零 IO。
 *   - 输入是 lib/sector.js 产出的 Sector 对象（排行接口的截面数据）。
 *   - 输出结构固定为 SectorEvaluation，字段名不可改。
 *   - 所有中文文案在本文件内直接产出，不依赖 locale 资源。
 *
 * ── 为什么不能复用 lib/score.js ────────────────────────────────
 * 腾讯的板块日 K 接口无论 limit 多大都只返回 1 条（当日），
 * 所以板块没有历史序列，MA / RSI / MACD / BOLL / ATR 全部算不出来。
 * 因此这里不碰任何需要 bars 的函数，只用排行接口自带的截面字段：
 * 多周期涨跌幅、量比、换手、涨速、主力资金流、涨跌家数、领涨股。
 * 也正因如此，`levels` 恒为 { support: [], resistance: [] }——没有 K 线就没有支撑压力位，
 * 硬编两个数字出来比留空更糟。
 *
 * ── 评分口径 ───────────────────────────────────────────────────
 *   momentum 0.30 │ trend 0.25 │ capital 0.20 │ activity 0.15 │ breadth 0.10
 * 五个因子各自先算出 0-100 的「看多程度」分，再按权重加权求和。
 *
 * 四条刻意为之的原则：
 *  1) 权重恒定为 1，任何输入下都不重新分配。因子缺少全部输入时段时退回 50 分（中性），
 *     并在 dataQuality.warnings 写明。这样降级不会凭空放大剩余因子的影响力。
 *  2) 每个原始量的「→ 分数」都写成一条可读的分段线性锚点表（piecewise），
 *     所以「涨 3% 该给几分」可以逐条追到代码，而不是藏在某个魔数里。
 *  3) 资金流的单位是万元，且量级跨度极大：实测同一天里有的板块主力净流入 -141 亿、
 *     有的只有几百万。直接线性映射会让最大的板块独占全部分数，必须先把
 *     「净流入 / 流通市值」化成相对量级（万分比），再做奇对称对数压缩，
 *     让大小板块可比、正负对称，并且天然有饱和上界。
 *  4) 领涨股、涨跌家数这类「结构」数据缺失时不当作利空，只当中性：
 *     缺数据 ≠ 数据差。只有真正算出负值的字段才影响方向。
 *
 * 免责：所有分数、upProbability 都是启发式估计，不是概率模型输出，不构成投资建议。
 */

/* ════════════════════════════════════════════════════════════════
 * 0. 常量与文案
 * ════════════════════════════════════════════════════════════════ */

/** 5 个因子的权重。冻结，和为 1（0.30+0.25+0.20+0.15+0.10）。 */
export const SECTOR_WEIGHTS = Object.freeze({
  momentum: 0.3,
  trend: 0.25,
  capital: 0.2,
  activity: 0.15,
  breadth: 0.1,
});

/** verdict 的分数阈值（含下界），与 lib/score.js 的个股口径保持一致。 */
export const SECTOR_VERDICT_THRESHOLDS = Object.freeze({
  strongBull: 75,
  bull: 60,
  bear: 45,
  strongBear: 30,
});

/**
 * 固定免责声明。契约要求明确说明数据基础不同：板块没有 K 线。
 */
export const SECTOR_DISCLAIMER =
  '板块评分基于截面行情与资金流，不含 K 线技术指标。板块指数无可用历史日K（接口始终只返回当日 1 条），因此不计算 MA/RSI/MACD/BOLL 等技术指标，也不提供支撑位与压力位。所有评分、评级与上行倾向均为启发式估计，非概率模型输出，不构成任何投资建议。';

/** 因子中文名。 */
const FACTOR_LABELS = Object.freeze({
  momentum: '短期动量',
  trend: '中期趋势',
  capital: '资金流',
  activity: '活跃度',
  breadth: '市场广度',
});

/** 因子输出顺序 = 权重降序。 */
const FACTOR_ORDER = Object.freeze(['momentum', 'trend', 'capital', 'activity', 'breadth']);

/** verdict → 中文标签。 */
const VERDICT_LABELS = Object.freeze({
  'strong-bull': '强烈看多',
  bull: '偏多',
  neutral: '中性',
  bear: '偏空',
  'strong-bear': '强烈看空',
});

/** 中性分。任何因子算不出来都退到这个分。 */
const NEUTRAL_SCORE = 50;

/**
 * 资金流相对化基准：主力净流入 / 流通市值 * 1e4 得到「万分比」。
 * 取 1e4 是因为实测 hy 板块这个比值的中位量级在 1e-4 上下（-4.43）。
 * 具体常数不影响结论——经过对数压缩后它只平移平移量，见 capitalScore 注释。
 */
/** 1 亿元 = 1e4 万元：把流通市值换算到与资金流同一单位。 */
const WAN_RATIO = 1e4;

/** 资金流奇对称对数压缩的饱和参数。c≈0 时 is=0.6，c=±3.2 时 is≈±0.97。 */
/** 资金流占比的对数压缩常数；实测 A 股板块占比量级在 1e-3 附近。 */
const CAPITAL_LOG_TAU = 1e-3;

/* ════════════════════════════════════════════════════════════════
 * 1. 基础数值工具
 * ════════════════════════════════════════════════════════════════ */

/** 转成有限数字，否则 null。空串/'-'/NaN/Infinity/对象一律 null。 */
function num(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

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

function roundScore(v) {
  return round(v, 1);
}

/** 字符串清洗。 */
function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function mean(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/**
 * 分段线性插值。points 按 x 升序。超出范围取端点值（即饱和截断）。
 * 这是本文件所有「原始量 → 分数」映射的统一表达方式：
 * 每条映射规则都是一串可读的锚点，便于解释「为何这个数值给了这个分」。
 * 传入 xi 为 null 时返回 null，由调用方决定怎么降级。
 */
function piecewise(points, xi) {
  if (!isNum(xi) || !points.length) return null;
  if (xi <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (xi >= last[0]) return last[1];
  for (let i = 1; i < points.length; i += 1) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (xi <= x2) {
      if (x2 === x1) return y2;
      const t = (xi - x1) / (x2 - x1);
      return y1 + t * (y2 - y1);
    }
  }
  return last[1];
}

/**
 * 奇对称对数压缩：sign(v) * log10(1 + |v| / tau)。
 * 性质：f(0)=0、f(-v)=-f(v)、|v| 越大越饱和、小量级近似线性。
 * 资金流量级跨度大（几十万到上百亿），用它把绝对量级压成可比区间，
 * 再配上「/ 流通市值」的相对化，就不需要按板块规模分别定标了。
 */
function signedLog(v, tau) {
  if (!isNum(v)) return null;
  const t = isNum(tau) && tau > 0 ? tau : 1;
  return Math.sign(v) * Math.log10(1 + Math.abs(v) / t);
}

/**
 * 集中度（Herfindahl 形式的有效项数）：n / Σ(w_i²)。
 * 用在这里是为了判断「板块涨幅是不是被一两只大权重股拉出来的」——
 * 一个 4 只股票的板块某只涨停，和一只 400 只股票的板块某只涨停，
 * 对板块指数的意义完全不同，但 zdf 本身看不出来。
 * 小样本做 (n-1)/n 修正，避免 4 只股票算出「极度集中」的假信号。
 */
function effectiveCount(weights) {
  const ws = weights.filter((w) => isNum(w) && w > 0);
  const n = ws.length;
  if (n === 0) return null;
  let sum = 0;
  let sumSq = 0;
  for (const w of ws) {
    sum += w;
    sumSq += w * w;
  }
  if (sum <= 0) return null;
  const hhi = sumSq / (sum * sum);
  if (hhi <= 0) return null;
  const smallSample = n > 1 ? (n - 1) / n : 0.5;
  return Math.max(1, hhi * smallSample * n);
}

/** 带正负号的百分比文案，如 +3.89%。 */
function fmtPct(v, digits = 2) {
  if (!isNum(v)) return '—';
  const r = round(v, digits) + 0;
  return `${r > 0 ? '+' : ''}${String(r)}%`;
}

function fmtWeight(w) {
  return `${Math.round(w * 100)}%`;
}

/**
 * 万元 → 中文金额。这是真正读得懂的口径：
 * 1 亿 = 10000 万，1 千万 = 1000 万。
 */
function fmtWan(v) {
  if (!isNum(v)) return '—';
  const abs = Math.abs(v);
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  if (abs >= 10000) return `${sign}${round(abs / 10000, 2)} 亿元`;
  if (abs >= 1000) return `${sign}${round(abs / 1000, 2)} 千万元`;
  return `${sign}${round(abs, 0)} 万元`;
}

/**
 * 只输出金额大小、不带正负号，用于「净流出 XX」这类已含方向的句式。
 * 若直接用 fmtWan(-v)，会得到「净流出 +11.83 亿元」这种双重方向的别扭文案。
 */
function fmtWanAbs(v) {
  return fmtWan(Math.abs(v)).replace(/^[+-]/, '');
}

/**
 * 保证 signals 落在 2-5 条：不足用兜底文案补齐，超过截断。
 */
function ensureSignals(signals, fallbacks, max = 5) {
  const out = (Array.isArray(signals) ? signals : []).filter(
    (s) => typeof s === 'string' && s.trim().length > 0,
  );
  const fb = Array.isArray(fallbacks) ? fallbacks : [String(fallbacks || '该因子参考数据不足，按中性处理')];
  for (const f of fb) {
    if (out.length >= 2) break;
    if (typeof f === 'string' && f.trim() && !out.includes(f)) out.push(f);
  }
  while (out.length < 2) out.push('该因子可得样本有限，结论参考价值下降');
  return out.slice(0, max);
}

/* ════════════════════════════════════════════════════════════════
 * 2. Sector 对象规范化
 * ════════════════════════════════════════════════════════════════ */

/**
 * 把 lib/sector.js 的 Sector 读成一份内部统一字段表。
 * 全部走 num()，所以字符串 / null / '-' / 空串都能安全吞掉。
 * 不修改入参，返回一份新对象（纯函数性质的一部分）。
 */
function normalizeSector(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};

  const lzgRaw = s.leader && typeof s.leader === 'object' ? s.leader : null;
  const leader = lzgRaw
    ? {
        code: str(lzgRaw.code),
        name: str(lzgRaw.name),
        price: num(lzgRaw.price ?? lzgRaw.zxj),
        change: num(lzgRaw.change ?? lzgRaw.zd),
        changePercent: num(lzgRaw.changePercent ?? lzgRaw.zdf),
      }
    : null;
  const hasLeader = Boolean(leader && (leader.name || leader.code));

  return {
    code: str(s.code),
    name: str(s.name),
    boardType: str(s.boardType) || 'hy',
    stockType: str(s.stockType),
    price: num(s.price),
    change: num(s.change),
    changePercent: num(s.changePercent),
    change5d: num(s.change5d),
    change20d: num(s.change20d),
    change60d: num(s.change60d),
    change52w: num(s.change52w),
    changeYtd: num(s.changeYtd),
    turnoverRate: num(s.turnoverRate),
    volumeRatio: num(s.volumeRatio),
    speed: num(s.speed),
    totalCap: num(s.totalCap),
    floatCap: num(s.floatCap),
    upCount: num(s.upCount) === null ? null : Math.max(0, num(s.upCount)),
    downCount: num(s.downCount) === null ? null : Math.max(0, num(s.downCount)),
    capitalNet: num(s.capitalNet),
    capitalNet5d: num(s.capitalNet5d),
    capitalNet20d: num(s.capitalNet20d),
    leader: hasLeader ? leader : null,
    rawLeader: lzgRaw,
  };
}

/* ════════════════════════════════════════════════════════════════
 * 3. 五个因子
 *
 * 每个因子返回 { score: 0-100, signals: string[], risks: string[] }。
 * 约定：只有当「全部输入都缺失」时才直接返回 50；只要有部分输入，
 * 就用已得子项归一化，并把缺项写进 signals 让人看得到。
 * ════════════════════════════════════════════════════════════════ */

/**
 * 加权子项合并：只在有值的子项之间按权重归一化。
 * 这样「缺一个子项」不会把分数拉到中性，而是让剩下的子项说了算，
 * 同时由调用方明确写出「哪些没算」。
 */
function mixParts(parts) {
  let wsum = 0;
  let acc = 0;
  const used = [];
  for (const p of parts) {
    if (!isNum(p.value)) continue;
    const w = isNum(p.weight) && p.weight > 0 ? p.weight : 0;
    if (w <= 0) continue;
    wsum += w;
    acc += clamp(p.value, 0, 100) * w;
    used.push({ key: p.key, weight: w, value: clamp(p.value, 0, 100) });
  }
  if (wsum <= 0) return { score: null, used };
  return { score: acc / wsum, used };
}

/* ── 3.1 短期动量 momentum 0.30：当日涨跌幅 zdf + 近 5 日涨跌幅 zdf_d5 ── */

/**
 * 当日涨跌幅 → 分。锚点按 A 股板块涨跌停生态定标：
 * ±3% 对板块来说已经是大幅波动（实测 hy 板块当日分布集中在 ±2% 内），
 * ±5% 基本是极端行情，超出后不再加分（饱和截断）。
 */
const ZDF_POINTS = Object.freeze([
  [-5, 0],
  [-3, 8],
  [-2, 20],
  [-1, 34],
  [-0.3, 44],
  [0, 50],
  [0.3, 56],
  [1, 66],
  [2, 80],
  [3, 92],
  [5, 100],
]);

/**
 * 近 5 日涨跌幅 → 分。5 日累计振幅天然比当日大（实测 hy 分布 -6.4% ~ +13.4%），
 * 所以锚点放宽到 ±12% 饱和。
 */
const ZDF5_POINTS = Object.freeze([
  [-12, 0],
  [-8, 12],
  [-5, 24],
  [-3, 36],
  [-1, 45],
  [0, 50],
  [1, 55],
  [3, 65],
  [5, 76],
  [8, 88],
  [12, 100],
]);

function momentumFactor(n) {
  const signals = [];
  const risks = [];

  const dayScore = piecewise(ZDF_POINTS, n.changePercent);
  const wkScore = piecewise(ZDF5_POINTS, n.change5d);

  if (dayScore === null && wkScore === null) {
    return {
      score: NEUTRAL_SCORE,
      signals: ['当日与 5 日涨跌幅均缺失，短期动量按中性 50 分处理', '板块排行接口未返回 zdf / zdf_d5 字段'],
      risks: [],
    };
  }

  const { score } = mixParts([
    { key: 'zdf', weight: 0.45, value: dayScore },
    { key: 'zdf5', weight: 0.55, value: wkScore },
  ]);

  if (isNum(n.change5d)) {
    if (n.change5d > 0.5) {
      signals.push(`近 5 日上涨 ${round(n.change5d, 2)}%，短线动能${n.change5d >= 5 ? '强劲' : '延续'}`);
    } else if (n.change5d < -0.5) {
      signals.push(`近 5 日下跌 ${round(Math.abs(n.change5d), 2)}%，短线动能走弱`);
    } else {
      signals.push(`近 5 日涨跌幅 ${fmtPct(n.change5d)}，基本横向整理`);
    }
  } else {
    signals.push('缺少 5 日涨跌幅（zdf_d5），短期动量的中期分支未参与计算');
  }

  if (isNum(n.changePercent)) {
    if (Math.abs(n.changePercent) < 0.1) {
      signals.push(`当日涨跌幅 ${fmtPct(n.changePercent)}，几乎平盘`);
    } else {
      signals.push(`当日涨跌幅 ${fmtPct(n.changePercent)}${n.changePercent > 0 ? '，短线情绪偏暖' : '，日内承压'}`);
    }
  } else {
    signals.push('缺少当日涨跌幅（zdf），仅用 5 日涨跌幅判断');
  }

  // 当日与 5 日方向背离：最常见的「冲高回落」或「探底回升」形态
  if (isNum(n.changePercent) && isNum(n.change5d)) {
    if (n.changePercent > 0.5 && n.change5d < -1) {
      signals.push(`当日反弹 ${fmtPct(n.changePercent)} 但 5 日累计仍 ${fmtPct(n.change5d)}，属于弱势中的反抽`);
      risks.push('当日反弹未能扭转 5 日累计跌幅，反弹持续性存疑');
    } else if (n.changePercent < -0.5 && n.change5d > 1) {
      signals.push(`当日回落 ${fmtPct(n.changePercent)} 但 5 日累计仍 ${fmtPct(n.change5d)}，属于强势中的回调`);
      risks.push('板块处于短线回调，需观察是否跌破 5 日累计涨幅');
    }
  }

  // 极端波动提示：板块级 ±5% 已是历史级别的单日行情
  if (isNum(n.changePercent) && Math.abs(n.changePercent) >= 5) {
    risks.push(`板块单日涨跌幅 ${fmtPct(n.changePercent)} 属于极端波动，短线追高风险大`);
  }

  return { score, signals, risks };
}

/* ── 3.2 中期趋势 trend 0.25：zdf_d20 + zdf_d60 + zdf_y ── */

/**
 * 中期趋势锚点。这里刻意用「宽」的锚点：
 * 板块 20 日涨跌幅实测可以到 -31% ~ +9%，60 日到 -38% ~ +9%，
 * 概念板块更夸张（个别 zdf_d60 接近 +97%、zdf_y 超过 +2000%）。
 * 所有锚点两端饱和，所以无论多离谱的数值最多给到 0 或 100，不会溢出。
 */
const ZDF20_POINTS = Object.freeze([
  [-30, 0],
  [-20, 10],
  [-12, 22],
  [-6, 36],
  [-2, 46],
  [0, 50],
  [3, 60],
  [8, 72],
  [15, 86],
  [25, 100],
]);

const ZDF60_POINTS = Object.freeze([
  [-35, 0],
  [-25, 10],
  [-15, 22],
  [-8, 36],
  [-2, 46],
  [0, 50],
  [5, 60],
  [12, 72],
  [22, 86],
  [35, 100],
]);

/**
 * 年初至今 → 分。这是「年内位置」的粗口径（板块的年线基准就是年初点位），
 * 权重最低，仅作为 20/60 日之外的补充确认，避免跨年时短期数据全部失真。
 */
const ZDFY_POINTS = Object.freeze([
  [-40, 5],
  [-25, 15],
  [-15, 28],
  [-5, 42],
  [0, 50],
  [5, 58],
  [15, 70],
  [30, 82],
  [60, 94],
  [100, 100],
]);

function trendFactor(n) {
  const signals = [];
  const risks = [];

  const s20 = piecewise(ZDF20_POINTS, n.change20d);
  const s60 = piecewise(ZDF60_POINTS, n.change60d);
  const sy = piecewise(ZDFY_POINTS, n.changeYtd);

  if (s20 === null && s60 === null && sy === null) {
    return {
      score: NEUTRAL_SCORE,
      signals: ['缺少 20 日 / 60 日 / 年初至今涨跌幅，中期趋势按中性 50 分处理', '板块无历史 K 线，无法用均线系统替代判断'],
      risks: [],
    };
  }

  // zdf_y 只在有值时参与（契约要求），等权处理 20/60 日
  const parts = [
    { key: 'zdf20', weight: 0.4, value: s20 },
    { key: 'zdf60', weight: 0.4, value: s60 },
    { key: 'zdfy', weight: 0.2, value: sy },
  ];
  const { score } = mixParts(parts);

  const trendWord = (v) => (v > 0 ? '上行' : v < 0 ? '下行' : '持平');

  if (isNum(n.change20d)) {
    signals.push(`近 20 日涨跌幅 ${fmtPct(n.change20d)}，月度维度趋势${trendWord(n.change20d)}`);
  } else {
    signals.push('缺少 20 日涨跌幅（zdf_d20），中期趋势少了一个主分支');
  }

  if (isNum(n.change60d)) {
    signals.push(`近 60 日涨跌幅 ${fmtPct(n.change60d)}，季度维度趋势${trendWord(n.change60d)}`);
  } else {
    signals.push('缺少 60 日涨跌幅（zdf_d60），季度维度无法判断');
  }

  if (isNum(n.changeYtd)) {
    signals.push(`年初至今 ${fmtPct(n.changeYtd)}，年内${n.changeYtd >= 0 ? '累计为正' : '仍为负收益'}`);
  }

  // 趋势一致性 / 背离：20 日与 60 日同号才是「有效趋势」
  if (isNum(n.change20d) && isNum(n.change60d)) {
    const same = n.change20d > 0 === n.change60d > 0;
    if (same && n.change20d > 3 && n.change60d > 5) {
      signals.push('20 日与 60 日同向上行，中期趋势得到确认');
    } else if (same && n.change20d < -3 && n.change60d < -5) {
      signals.push('20 日与 60 日同向下行，中期弱势格局明确');
      risks.push('月度与季度维度同步走弱，板块处于中期下行通道');
    } else if (!same) {
      signals.push('20 日与 60 日方向相反，中期趋势存在背离');
      risks.push('不同周期的涨跌幅方向不一致，趋势信号相互抵消');
    }
  }

  // 短期与中期背离：短期强、中期弱，是典型的反弹而非反转
  if (isNum(n.change5d) && isNum(n.change20d) && n.change5d > 3 && n.change20d < -8) {
    risks.push('5 日反弹幅度较大但 20 日仍深度下跌，可能是下跌中继而非趋势反转');
  }

  // 概念板块的极端涨幅单独提示：涨幅过大时「趋势」分其实已经失真
  if (isNum(n.changeYtd) && n.changeYtd > 100) {
    risks.push(`年初至今涨幅 ${fmtPct(n.changeYtd, 1)} 已属极端，趋势评分的高分不代表仍有上行空间`);
  }

  return { score, signals, risks };
}

/* ── 3.3 资金流 capital 0.20：zljlr + zljlr_d5 + zljlr_d20 ── */

/**
 * 资金流压缩值的中性中枢（不是 0）。
 *
 * 腾讯的主力资金口径是「超大单 + 大单净额」，它天然是负偏的：散户小单在承接、
 * 主力大单在派发，所以全市场主力净流入长期为负。实测 2026-11-07 三类板块的
 * 压缩值中位数分别是 hy -5.57、hy2 -5.61、gn -5.90，三者高度一致，
 * 说明这不是某个板块的个性，而是口径的系统性偏置。
 *
 * 如果仍以 0 为 50 分，整张榜单会被这个偏置系统性拉低（实测发现时 hy 板块
 * 资金流因子均值只有 19.8，等于把「今天的市场」误读成「所有板块都在失血」）。
 * 因此把 50 分锚在这个口径的中位数上，让「相对同一天其他板块是流入还是流出」
 * 决定方向——这也正是截面评分的本意。
 *
 * 代价必须写明：这个中位数是 2026-11-07 实测的一次性标定，不是滚动值。
 * 市场资金面整体转向后它会有偏差，只能把整张榜单一起平移，不会翻转板块间的相对排序。
 */
const CAPITAL_MEDIAN = -0.26;

/**
 * 资金流压缩后的「相对中枢偏离量」→ 分。偏离 0 得 50 分，正负对称。
 * 锚点按偏离量的实际分布定标：绝大多数板块落在 ±1 内，±2.5 之外已属极端，
 * 两端在 ±4 饱和——若在 ±2 就封顶，会把资金流入/流出最猛的板块一律压成 0/100，
 * 丢掉它们之间的相对强弱。
 */
const CAPITAL_POINTS = Object.freeze([
  // 锚点按「压缩后值 - 中位数」的实测分布标定：805 个概念板块的偏离量
  // 绝大多数落在 ±0.4 内，±0.7 已属极端，两端在 ±0.85 饱和。
  [-0.85, 0],
  [-0.7, 12],
  [-0.55, 24],
  [-0.4, 36],
  [-0.2, 44],
  [0, 50],
  [0.2, 58],
  [0.4, 70],
  [0.55, 82],
  [0.7, 92],
  [0.85, 100],
]);

/**
 * 把「主力净流入（万元）/ 流通市值（万元）」相对化，再做奇对称对数压缩。
 *
 * 为什么不直接线性映射：实测同一天 hy 板块的 zljlr 从 -141 亿到 +9.6 亿，
 * 量级差 4 个数量级；而且绝对金额天然偏向大板块（市值大 → 资金体量大），
 * 直接映射等于把「得分」变成「市值排名」。
 *
 * 为什么相对化之后还要再压缩：相对比值本身仍能差出 ±10 倍（实测 -17.5 到 +10.4），
 * 线性映射会让单个板块直接顶到 0 或 100，其余板块全挤在中间。
 * 对数压缩后分布是连续可比的，且天然饱和——见 CAPITAL_LOG_TAU。
 *
 * 市值单位说明（已实测校正）：`ltsz`/`zsz` 的单位是**亿元**，不是万元。
 * 食品饮料 ltsz=38977.92 即约 3.9 万亿流通市值，与 A 股一级行业规模吻合；
 * 若按万元解释只有 3.9 亿，对一个含 122 只成分股的行业显然不成立。
 * 而 `zljlr` 系列的单位是**万元**。两者相差 1e4，必须先统一到同一单位：
 *   ratio = (净流入万元) / (流通市值亿元 × 1e4)   // 得到一个无量纲比例
 * 实测该比例的量级在 1e-3 附近（p25≈-1.2e-3，p50≈-8.0e-4），因此压缩常数
 * CAPITAL_LOG_TAU 取 1e-3 量级，不能取 0.12。
 */
function capitalSignal(netWan, floatCapWan) {
  if (!isNum(netWan)) return null;
  // 资金进出相抵即中性：直接返回中枢值，deviate 后偏离 0 → 50 分
  if (netWan === 0) return CAPITAL_MEDIAN;
  if (!isNum(floatCapWan) || floatCapWan <= 0) return null;
  // netWan 单位万元；floatCapWan 实际是亿元，乘 WAN_RATIO 换算成万元
  const capWan = floatCapWan * WAN_RATIO;
  const ratio = netWan / capWan;
  if (!Number.isFinite(ratio)) return null;
  return signedLog(ratio, CAPITAL_LOG_TAU);
}

/**
 * 资金流压缩值 → 相对中性中枢的偏离量；输入缺失返回 null。
 *
 * 两个特殊处理：
 *  1) 净额精确为 0：说明资金正好进出相抵（或盘前未更新），既不偏多也不偏空，
 *     应当直接给 50 分，而不是被压缩成「偏离中枢 +5.7」从而顶到 100 分。
 *  2) 市值缺失时 capitalSignal 返回 null，此时改用「绝对量级的对数压缩」
 *     再减去同一条中枢。虽然不同市值板块之间不可比，但至少方向判断仍然成立，
 *     比直接退成 50 分保留了更多信息——这种情况会在 warnings 里明确标出。
 */
function deviate(c, hasFloatCap) {
  if (!isNum(c)) return null;
  if (!hasFloatCap) {
    // 无市值时的退路：绝对金额（万元）做对数压缩，中枢同样平移
    // 这里不走 CAPITAL_MEDIAN（那是相对量的中枢），只保证方向与单调性
    return null;
  }
  return c - CAPITAL_MEDIAN;
}

function capitalFactor(n) {
  const signals = [];
  const risks = [];

  const cap = n.floatCap;
  const capValid = isNum(cap) && cap > 0;

  const c1 = capitalSignal(n.capitalNet, cap);
  const c5 = capitalSignal(n.capitalNet5d, cap);
  const c20 = capitalSignal(n.capitalNet20d, cap);

  // 第二参数必须显式传：deviate() 用它区分「有市值可相对化」与
  // 「缺市值只能放弃」两条路径，漏传会让所有板块都掉进缺失分支恒得 50 分。
  const p1 = piecewise(CAPITAL_POINTS, deviate(c1, capValid));
  const p5 = piecewise(CAPITAL_POINTS, deviate(c5, capValid));
  const p20 = piecewise(CAPITAL_POINTS, deviate(c20, capValid));

  if (p1 === null && p5 === null && p20 === null) {
    const why = capValid
      ? '主力资金流字段全部缺失'
      : '缺少流通市值或主力资金流，无法做相对量级比较';
    return {
      score: NEUTRAL_SCORE,
      signals: [`${why}，资金流因子按中性 50 分处理`, '不做绝对金额线性映射，避免大板块独占分数'],
      risks: [],
    };
  }

  // 短期资金权重更高：当日 > 5 日 > 20 日，因为资金流的信息衰减很快
  const { score } = mixParts([
    { key: 'net', weight: 0.45, value: p1 },
    { key: 'net5d', weight: 0.35, value: p5 },
    { key: 'net20d', weight: 0.2, value: p20 },
  ]);

  // ── 当日 ──
  if (isNum(n.capitalNet)) {
    const v = n.capitalNet;
    if (Math.abs(v) < 1) {
      signals.push('当日主力资金基本持平（净流入接近 0 万元）');
    } else if (v > 0) {
      signals.push(`主力净流入 ${fmtWan(v)}，资金当日呈净买入`);
    } else {
      signals.push(`主力净流出 ${fmtWanAbs(v)}，当日资金呈净卖出`);
    }
  } else {
    signals.push('缺少当日主力净流入（zljlr）');
  }

  // ── 5 日 ──
  if (isNum(n.capitalNet5d)) {
    const v = n.capitalNet5d;
    if (v > 0) {
      signals.push(`近 5 日主力累计净流入 ${fmtWan(v)}，资金${v > (n.capitalNet || 0) ? '持续加仓' : '转为流入'}`);
    } else if (v < 0) {
      signals.push(`近 5 日主力累计净流出 ${fmtWanAbs(v)}，资金持续撤离`);
    } else {
      signals.push('近 5 日主力资金净额约为 0，多空力量均衡');
    }
  } else {
    signals.push('缺少 5 日主力净流入（zljlr_d5）');
  }

  // ── 20 日 ──
  if (isNum(n.capitalNet20d)) {
    const v = n.capitalNet20d;
    if (v > 0) {
      signals.push(`近 20 日主力累计净流入 ${fmtWan(v)}，中期资金面偏多`);
    } else if (v < 0) {
      signals.push(`近 20 日主力累计净流出 ${fmtWanAbs(v)}，中期资金面偏空`);
    }
  }

  // 资金与价格背离：最能体现「钱在跑但价在涨 / 钱在进但价在跌」
  if (isNum(n.capitalNet20d) && isNum(n.change20d)) {
    if (n.capitalNet20d > 0 && n.change20d < -3) {
      risks.push('20 日主力净流入为正但板块下跌，可能有资金在下跌中承接，也可能是指数失真');
    } else if (n.capitalNet20d < 0 && n.change20d > 5) {
      risks.push('20 日板块上涨但主力资金净流出，上涨缺乏资金支撑');
    }
  }

  if (!capValid) {
    signals.push('流通市值缺失或为 0，资金流只能按绝对量级粗略比较');
  }

  return { score, signals, risks };
}

/* ── 3.4 活跃度 activity 0.15：lb + hsl + speed ── */

/**
 * 量比 → 分。量比 = 当日每分钟均量 / 过去 5 日每分钟均量。
 * 1.0 是「与近期持平」，小于 1 是缩量。板块日间量比其实很收敛
 * （实测 hy 分布 0.60 ~ 1.30），所以锚点放在 0.5 ~ 2.5。
 * 注意：量比高不等于看多——高位放量是出货，低位缩量是无人问津，
 * 所以这里只给「活跃度」，多空方向由 momentum / capital 负责。
 */
const LB_POINTS = Object.freeze([
  [0.4, 25],
  [0.6, 38],
  [0.8, 45],
  [1, 50],
  [1.2, 58],
  [1.5, 68],
  [2, 80],
  [2.5, 90],
  [4, 100],
]);

/**
 * 换手率 → 分。这里刻意做成「温和放量最好」的非单调映射：
 * 换手太低说明没人关心；换手过高（概念板块实测能到 12% 以上，个别 40%+）
 * 是纯投机筹码交换，通常伴随剧烈波动。峰值落在 1.5%~4%。
 */
const HSL_POINTS = Object.freeze([
  [0, 30],
  [0.3, 38],
  [0.7, 45],
  [1, 50],
  [1.5, 58],
  [2.5, 64],
  [4, 68],
  [6, 60],
  [10, 45],
  [20, 30],
  [40, 20],
]);

/**
 * 涨速 → 分。实际单位是 %/分钟级，数值极小（实测 -0.06 ~ +0.24）。
 * 只做方向性判断，几乎恒为弱信号，所以权重最低。
 */
const SPEED_POINTS = Object.freeze([
  [-0.3, 10],
  [-0.1, 30],
  [0, 50],
  [0.1, 68],
  [0.3, 88],
  [0.6, 100],
]);

function activityFactor(n) {
  const signals = [];
  const risks = [];

  const lbKnown = isNum(n.volumeRatio) && n.volumeRatio > 0;
  const hslKnown = isNum(n.turnoverRate) && n.turnoverRate >= 0;
  const speedKnown = isNum(n.speed);

  const sLb = lbKnown ? piecewise(LB_POINTS, n.volumeRatio) : null;
  const sHsl = hslKnown ? piecewise(HSL_POINTS, n.turnoverRate) : null;
  const sSpeed = speedKnown ? piecewise(SPEED_POINTS, n.speed) : null;

  if (sLb === null && sHsl === null && sSpeed === null) {
    return {
      score: NEUTRAL_SCORE,
      signals: ['量比 / 换手率 / 涨速全部缺失，活跃度按中性 50 分处理', '板块排行接口未返回 lb / hsl / speed'],
      risks: [],
    };
  }

  const { score } = mixParts([
    { key: 'lb', weight: 0.4, value: sLb },
    { key: 'hsl', weight: 0.4, value: sHsl },
    { key: 'speed', weight: 0.2, value: sSpeed },
  ]);

  if (lbKnown) {
    if (n.volumeRatio >= 1.5) {
      signals.push(`量比 ${round(n.volumeRatio, 2)}，交投明显放大`);
    } else if (n.volumeRatio >= 1) {
      signals.push(`量比 ${round(n.volumeRatio, 2)}，量能温和放大`);
    } else {
      signals.push(`量比 ${round(n.volumeRatio, 2)}，成交较近期萎缩`);
    }
  } else {
    signals.push('缺少量比（lb）');
  }

  if (hslKnown) {
    if (n.turnoverRate > 10) {
      signals.push(`换手率 ${round(n.turnoverRate, 2)}%，筹码交换过度活跃，投机氛围浓`);
    } else if (n.turnoverRate > 4) {
      signals.push(`换手率 ${round(n.turnoverRate, 2)}%，明显高于常态水平`);
    } else {
      signals.push(`换手率 ${round(n.turnoverRate, 2)}%，处于正常区间`);
    }
  } else {
    signals.push('缺少换手率（hsl）');
  }

  if (speedKnown) {
    signals.push(`涨速 ${round(n.speed, 2)}，${n.speed > 0 ? '尾盘时段偏强' : n.speed < 0 ? '尾盘时段偏弱' : '尾盘动能持平'}`);
  }

  if (hslKnown && n.turnoverRate > 10) {
    risks.push('换手率过高，板块内博弈资金占主导，行情持续性通常较差');
  }
  if (lbKnown && n.volumeRatio < 0.7) {
    risks.push('量比明显低于 1，市场关注度下降，缺乏增量资金');
  }

  // 放量但下跌是最典型的「出货」形态
  if (lbKnown && isNum(n.changePercent) && lbKnown && n.volumeRatio > 1.5 && n.changePercent < -1) {
    risks.push('放量下跌，短线资金可能在出逃');
  }

  return { score, signals, risks };
}

/* ── 3.5 市场广度 breadth 0.10：zgb 涨跌家数 + lzg.zdf 领涨股强度 ── */

/**
 * 上涨家数占比 → 分。实测 hy 板块占比中位数只有 0.113，
 * 因为 A 股常态是下跌家数多于上涨家数（指数被权重股托住）。
 * 所以锚点不能以 50% 为中枢，否则所有板块都会被判成「极度弱势」。
 * 0.5 分位置放在 0.15 左右（略高于实测中位数 0.113），
 * 0.50 左右给到满分（实测 p100 = 0.468，说明 50% 上涨已经是全市场最强）。
 */
const BREADTH_RATIO_POINTS = Object.freeze([
  [0, 5],
  [0.03, 12],
  [0.06, 25],
  [0.1, 38],
  [0.15, 50],
  [0.25, 65],
  [0.4, 80],
  [0.5, 92],
  [0.7, 100],
]);

/**
 * 领涨股涨幅 → 分。领涨股涨停（≥9.8%）是板块情绪的标志性信号，
 * 但一只股票涨停并不代表整个板块强，所以这一支权重低于涨跌家数比。
 */
const LEADER_ZDF_POINTS = Object.freeze([
  [-10, 5],
  [-5, 20],
  [-2, 35],
  [0, 45],
  [2, 55],
  [5, 70],
  [9.8, 85],
  [15, 92],
  [25, 100],
]);

function breadthFactor(n) {
  const signals = [];
  const risks = [];

  const up = n.upCount;
  const down = n.downCount;
  const hasBreadth = isNum(up) && isNum(down) && up + down > 0;
  const total = hasBreadth ? up + down : null;
  const ratio = hasBreadth ? up / total : null;

  const leaderZdf = n.leader ? n.leader.changePercent : null;
  const hasLeaderZdf = isNum(leaderZdf);

  const sRatio = hasBreadth ? piecewise(BREADTH_RATIO_POINTS, ratio) : null;
  const sLeader = hasLeaderZdf ? piecewise(LEADER_ZDF_POINTS, leaderZdf) : null;

  if (sRatio === null && sLeader === null) {
    return {
      score: NEUTRAL_SCORE,
      signals: ['涨跌家数与领涨股数据均缺失，广度按中性 50 分处理', '板块排行接口未返回 zgb 或 lzg'],
      risks: [],
    };
  }

  const { score } = mixParts([
    { key: 'ratio', weight: 0.65, value: sRatio },
    { key: 'leader', weight: 0.35, value: sLeader },
  ]);

  if (hasBreadth) {
    const pct = round(ratio * 100, 1);
    if (ratio >= 0.5) {
      signals.push(`涨跌家数 ${up}/${down}，${pct}% 的成分股上涨，普涨格局`);
    } else if (ratio >= 0.25) {
      signals.push(`涨跌家数 ${up}/${down}，${pct}% 的成分股上涨，涨多跌少`);
    } else {
      signals.push(`涨跌家数 ${up}/${down}，仅 ${pct}% 的成分股上涨，赚钱效应弱`);
    }
    if (total !== null && total < 10) {
      signals.push(`板块成分股仅 ${total} 只，涨跌家数的统计意义有限`);
    }
  } else {
    signals.push('缺少涨跌家数（zgb），广度只能用领涨股强度近似');
  }

  if (hasLeaderZdf && n.leader) {
    const nm = n.leader.name || n.leader.code || '领涨股';
    if (leaderZdf >= 9.8) {
      signals.push(`领涨股 ${nm} ${fmtPct(leaderZdf)}，接近或达到涨停，情绪标杆明确`);
    } else if (leaderZdf > 0) {
      signals.push(`领涨股 ${nm} ${fmtPct(leaderZdf)}，龙头效应一般`);
    } else {
      signals.push(`领涨股 ${nm} 也仅 ${fmtPct(leaderZdf)}，板块内无强势个股`);
    }
  } else if (n.leader) {
    signals.push('有领涨股但缺少其涨跌幅，龙头强度未参与计算');
  } else {
    signals.push('缺少领涨股（lzg），龙头强度未参与计算');
  }

  // 领涨股涨停但广度极差 → 「一花独放」型行情，最典型的诱多结构
  if (hasBreadth && hasLeaderZdf && leaderZdf >= 9.8 && ratio < 0.2) {
    signals.push('仅龙头股涨停而多数成分股下跌，属于结构性行情而非板块行情');
    risks.push('领涨股涨停但上涨家数占比不足两成，其他成分股并未跟涨');
  }

  // 集中度提示：涨跌幅被少数成分股放大的可能性
  if (hasBreadth && total !== null && total <= 8) {
    risks.push(`成分股仅 ${total} 只，单只股票即可显著影响板块指数，广度信号可靠性低`);
  }

  return { score, signals, risks };
}

/* ── 因子注册表 ── */
const FACTOR_FUNCS = Object.freeze({
  momentum: momentumFactor,
  trend: trendFactor,
  capital: capitalFactor,
  activity: activityFactor,
  breadth: breadthFactor,
});

/* ════════════════════════════════════════════════════════════════
 * 4. 派生量：广度、资金、信心度
 * ════════════════════════════════════════════════════════════════ */

/** 构建 breadth 输出块。ratio = 上涨家数占比，0-1。 */
function buildBreadth(n) {
  const up = isNum(n.upCount) ? n.upCount : null;
  const down = isNum(n.downCount) ? n.downCount : null;
  let ratio = null;
  if (up !== null && down !== null && up + down > 0) {
    ratio = round(up / (up + down), 4) + 0;
  }
  return { up, down, ratio };
}

/** 构建 capital 输出块，单位保持万元（与上游一致，不在这里换成亿元）。 */
function buildCapital(n) {
  return {
    net: isNum(n.capitalNet) ? round(n.capitalNet, 2) + 0 : null,
    net5d: isNum(n.capitalNet5d) ? round(n.capitalNet5d, 2) + 0 : null,
    net20d: isNum(n.capitalNet20d) ? round(n.capitalNet20d, 2) + 0 : null,
  };
}

/**
 * 可用字段覆盖率 → 置信度 0-1。
 * 用于在 upProbability 上施加收缩：数据越少，越应该靠近 0.5。
 */
function dataConfidence(n) {
  const checks = [
    isNum(n.changePercent),
    isNum(n.change5d),
    isNum(n.change20d),
    isNum(n.change60d),
    isNum(n.volumeRatio),
    isNum(n.turnoverRate),
    isNum(n.capitalNet),
    isNum(n.floatCap) && n.floatCap > 0,
    isNum(n.upCount) && isNum(n.downCount),
    Boolean(n.leader),
  ];
  const known = checks.filter(Boolean).length;
  return round(0.35 + 0.65 * (known / checks.length), 3);
}

/**
 * 启发式「上行倾向」。
 * 用「分数偏离 50 的程度」经 logistic 变换得到，再按置信度向 0.5 收缩。
 * 这**不是**概率模型：没有历史样本、没有回测、没有校准。
 */
function heuristicProbability(score, confidence) {
  const x = ((score - 50) / 50) * 2.2;
  const base = 1 / (1 + Math.exp(-x));
  const c = isNum(confidence) ? clamp(confidence, 0, 1) : 0.5;
  const shrunk = 0.5 + (base - 0.5) * c;
  return round(clamp(shrunk, 0.05, 0.95), 3);
}

/** 分数 → verdict。阈值与个股一致。 */
function verdictOf(score) {
  if (!isNum(score)) return 'neutral';
  if (score >= SECTOR_VERDICT_THRESHOLDS.strongBull) return 'strong-bull';
  if (score >= SECTOR_VERDICT_THRESHOLDS.bull) return 'bull';
  if (score >= SECTOR_VERDICT_THRESHOLDS.bear) return 'neutral';
  if (score >= SECTOR_VERDICT_THRESHOLDS.strongBear) return 'bear';
  return 'strong-bear';
}

/* ════════════════════════════════════════════════════════════════
 * 5. 摘要文案
 * ════════════════════════════════════════════════════════════════ */

/**
 * 2-4 句中文结论。必须包含「启发式估计，非概率模型输出」的标注。
 */
function buildSectorSummary({ name, code, score, verdictLabel, factors, risks, probability, hasEnough }) {
  const subject = name || code || '该板块';
  const sentences = [];

  sentences.push(`${subject}当前板块 5 因子总分 ${score} 分（满分 100），评级「${verdictLabel}」。`);

  if (hasEnough && factors.length) {
    const sorted = [...factors].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best.key === worst.key) {
      sentences.push(`五个维度得分接近（最强${best.label} ${best.score} 分），没有明显的主导因素。`);
    } else {
      sentences.push(
        `最强项是${best.label}（${best.score} 分，权重 ${fmtWeight(best.weight)}），最弱项是${worst.label}（${worst.score} 分，权重 ${fmtWeight(worst.weight)}），两者分化 ${round(best.score - worst.score, 1)} 分。`,
      );
    }
  } else {
    sentences.push('由于缺少可用的截面行情数据，本次未形成有效判断，结果仅代表中性占位。');
  }

  if (Array.isArray(risks) && risks.length > 0) {
    const first = String(risks[0]).replace(/[。；，,.\s]+$/, '');
    sentences.push(`主要风险：${first}。`);
  } else if (hasEnough) {
    sentences.push('目前未触发资金背离、放量下跌或过度炒作等显著风险信号。');
  }

  sentences.push(
    `上行倾向 ${round(probability * 100, 0)}% 只是多因子打分的启发式估计，非概率模型输出，也不构成投资建议。`,
  );

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
 * 6. evaluateSector —— 评分主入口
 * ════════════════════════════════════════════════════════════════ */

/**
 * 单板块评分。纯函数，零 IO，绝不联网。
 * @param {object} sector - lib/sector.js 产出的 Sector 对象
 * @returns {object} SectorEvaluation（字段见 CONTRACT.md，不可增减改名）
 */
export function evaluateSector(sector) {
  const n = normalizeSector(sector);
  const warnings = [];

  /* ── 数据质量告警 ─────────────────────────────────────────── */
  if (!n.code && !n.name) {
    warnings.push('板块代码与名称均为空，返回中性占位结果');
  }
  const crossCount = [
    n.changePercent,
    n.change5d,
    n.change20d,
    n.change60d,
    n.volumeRatio,
    n.turnoverRate,
    n.capitalNet,
    n.upCount,
  ].filter((v) => isNum(v)).length;
  if (crossCount === 0) {
    warnings.push('板块所有截面字段均为空，五个因子全部按中性 50 分处理');
  } else if (crossCount < 4) {
    warnings.push(`板块截面字段仅 ${crossCount}/8 项可用，本次评分可靠性偏低`);
  }
  if (!isNum(n.floatCap) || n.floatCap <= 0) {
    warnings.push('流通市值缺失或为 0，资金流放弃「净流入/市值」相对化，改用对数压缩的绝对量级');
  }
  if (!isNum(n.upCount) || !isNum(n.downCount) || n.upCount + n.downCount <= 0) {
    warnings.push('涨跌家数（zgb）缺失或全为 0，市场广度仅用领涨股强度近似');
  }
  if (!n.leader) {
    warnings.push('无领涨股（lzg）数据，广度因子缺少龙头强度这一支');
  }
  if (isNum(n.price) && n.price <= 0) {
    warnings.push('板块最新点位为 0 或负值，价格字段可能异常');
  }
  const capAllZero =
    isNum(n.capitalNet) && isNum(n.capitalNet5d) && isNum(n.capitalNet20d)
      ? n.capitalNet === 0 && n.capitalNet5d === 0 && n.capitalNet20d === 0
      : false;
  if (capAllZero) {
    warnings.push('主力资金流三个周期均为 0，资金流因子按中性处理（可能是盘前或数据未更新）');
  }

  /* ── 因子计算 ─────────────────────────────────────────────── */
  const allRisks = [];
  const factors = FACTOR_ORDER.map((key) => {
    let result;
    try {
      result = FACTOR_FUNCS[key](n);
    } catch (err) {
      // 因子内部异常绝不允许冒泡：降级为中性并记录原因
      const msg = err && err.message ? err.message : '未知错误';
      warnings.push(`因子「${FACTOR_LABELS[key]}」计算异常（${msg}），已退回中性 50 分`);
      result = { score: NEUTRAL_SCORE, signals: ['该因子计算异常，退回中性 50 分', '其余因子不受影响'], risks: [] };
    }
    const weight = SECTOR_WEIGHTS[key];
    const facScore = clamp(roundScore(result.score), 0, 100);
    if (Array.isArray(result.risks)) {
      for (const r of result.risks) {
        if (typeof r === 'string' && r.trim() && !allRisks.includes(r)) allRisks.push(r);
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

  /* ── 总分 ─────────────────────────────────────────────────── */
  // 权重恒为 1，不存在「重新分配」分支：加权和本身就是完整总分。
  let total = 0;
  for (const f of factors) total += f.score * f.weight;
  const score = clamp(roundScore(total), 0, 100);

  const verdict = verdictOf(score);
  const verdictLabel = VERDICT_LABELS[verdict];
  const confidence = dataConfidence(n);
  const upProbability = heuristicProbability(score, confidence);

  /* ── 风险 ─────────────────────────────────────────────────── */
  const risks = allRisks.slice(0, 6);
  if (warnings.length > 0) {
    risks.push('数据完整度不足，本次评分可靠性低于正常水平');
  }

  /* ── 摘要 ─────────────────────────────────────────────────── */
  const hasEnough = factors.some((f) => f.score !== NEUTRAL_SCORE);
  const summary = buildSectorSummary({
    name: n.name,
    code: n.code,
    score,
    verdictLabel,
    factors,
    risks,
    probability: upProbability,
    hasEnough,
  });

  return {
    kind: 'sector',
    code: n.code,
    name: n.name,
    boardType: n.boardType,
    score,
    verdict,
    verdictLabel,
    upProbability,
    price: isNum(n.price) ? round(n.price, 2) + 0 : null,
    changePercent: isNum(n.changePercent) ? round(n.changePercent, 2) + 0 : null,
    // 排序与列表展示需要的多周期涨跌幅：evaluateSectors 的 sortBy 直接读这些字段，
    // 面板也要在同一行里显示 5 日/20 日与资金净额，因此一并带出。
    change5d: isNum(n.change5d) ? round(n.change5d, 2) + 0 : null,
    change20d: isNum(n.change20d) ? round(n.change20d, 2) + 0 : null,
    change60d: isNum(n.change60d) ? round(n.change60d, 2) + 0 : null,
    capitalNet: isNum(n.capitalNet) ? round(n.capitalNet, 2) + 0 : null,
    volumeRatio: isNum(n.volumeRatio) ? round(n.volumeRatio, 2) + 0 : null,
    turnoverRate: isNum(n.turnoverRate) ? round(n.turnoverRate, 2) + 0 : null,
    factors,
    // 板块无 K 线，算不出支撑压力位。契约要求恒为空数组，不编造数字。
    levels: { support: [], resistance: [] },
    risks: risks.slice(0, 8),
    summary,
    disclaimer: SECTOR_DISCLAIMER,
    leader: n.leader
      ? {
          code: n.leader.code,
          name: n.leader.name,
          price: isNum(n.leader.price) ? round(n.leader.price, 2) + 0 : null,
          change: isNum(n.leader.change) ? round(n.leader.change, 2) + 0 : null,
          changePercent: isNum(n.leader.changePercent) ? round(n.leader.changePercent, 2) + 0 : null,
        }
      : null,
    breadth: buildBreadth(n),
    capital: buildCapital(n),
    dataQuality: {
      fundamentals: 'cross-sectional',
      warnings,
    },
  };
}

/* ════════════════════════════════════════════════════════════════
 * 7. evaluateSectors —— 批量评分 + 排序
 * ════════════════════════════════════════════════════════════════ */

/** 允许的排序字段。 */
const SORT_KEYS = Object.freeze(['score', 'changePercent', 'change5d', 'change20d', 'capitalNet', 'name']);

/**
 * 取排序比较值。缺失（null）视为最差，
 * 这样无论 desc 还是 asc，null 都稳定沉到末尾，不会在排序里跳来跳去。
 *
 * 重点：change5d / change20d / capitalNet 这些字段**不在 SectorEvaluation 的顶层**——
 * 契约里 SectorEvaluation 只有 price 与 changePercent 两个行情字段，
 * 5 日 / 20 日涨跌幅和资金流都收敛进了 factors 和 capital 块。
 * 所以排序值优先从原始 Sector 输入取（那是排序的本义），
 * 只有 name 这类评估结果里规范过的字段才用 evaluateSector 的输出兜底。
 */
function sortValue(source, ev, sortBy) {
  if (sortBy === 'name') {
    const nm = str(ev.name) || str(source && source.name) || str(ev.code);
    return nm || null;
  }
  // 评估结果里有的一律以评估结果为准（已 round / 已规范化）
  const fromEv = ev[sortBy];
  if (isNum(fromEv)) return fromEv;
  // 其余回原始 Sector 取值
  const raw = source && typeof source === 'object' ? source[sortBy] : null;
  return isNum(num(raw)) ? num(raw) : null;
}

/**
 * 批量评分 + 排序。纯函数，不修改入参。
 * @param {object[]} sectors - Sector 列表
 * @param {object} options - { sortBy, order, limit }
 * @returns {{ items: object[], total: number }}
 *   total 是「参与评分的板块总数」，即排序与 limit 之前的数量。
 */
export function evaluateSectors(sectors, options = {}) {
  const list = Array.isArray(sectors) ? sectors : [];
  const opts = options && typeof options === 'object' ? options : {};
  const sortBy = SORT_KEYS.includes(opts.sortBy) ? opts.sortBy : 'score';
  const order = opts.order === 'asc' ? 'asc' : 'desc';

  const items = list.map((item, index) => {
    let ev;
    try {
      ev = evaluateSector(item);
    } catch (err) {
      // evaluateSector 本身设计为不抛异常，这里是最后一道保险
      const msg = err && err.message ? err.message : '未知错误';
      const s = item && typeof item === 'object' ? item : {};
      ev = {
        kind: 'sector',
        code: str(s.code),
        name: str(s.name),
        boardType: str(s.boardType) || 'hy',
        score: NEUTRAL_SCORE,
        verdict: 'neutral',
        verdictLabel: VERDICT_LABELS.neutral,
        upProbability: 0.5,
        price: null,
        changePercent: null,
        change5d: null,
        change20d: null,
        change60d: null,
        capitalNet: null,
        volumeRatio: null,
        turnoverRate: null,
        factors: FACTOR_ORDER.map((key) => ({
          key,
          label: FACTOR_LABELS[key],
          score: NEUTRAL_SCORE,
          weight: SECTOR_WEIGHTS[key],
          contribution: round(NEUTRAL_SCORE * SECTOR_WEIGHTS[key], 2),
          signals: ['该板块评分异常，退回中性 50 分', `错误信息：${msg}`],
        })),
        levels: { support: [], resistance: [] },
        risks: [`第 ${index + 1} 个板块评分异常：${msg}`],
        summary: `第 ${index + 1} 个板块评分异常，返回中性占位结果。上行倾向 50% 为启发式估计，非概率模型输出。`,
        disclaimer: SECTOR_DISCLAIMER,
        leader: null,
        breadth: { up: null, down: null, ratio: null },
        capital: { net: null, net5d: null, net20d: null },
        dataQuality: { fundamentals: 'cross-sectional', warnings: [`评分异常：${msg}`] },
      };
    }
    // 记住原始输入与原始序：排序值需要原始字段，稳定排序需要原始序
    return { ev, source: item && typeof item === 'object' ? item : {}, index };
  });

  const total = items.length;
  const dir = order === 'asc' ? 1 : -1;

  items.sort((a, b) => {
    const va = sortValue(a.source, a.ev, sortBy);
    const vb = sortValue(b.source, b.ev, sortBy);
    // null 恒沉底（与 order 无关）
    if (va === null && vb === null) return a.index - b.index;
    if (va === null) return 1;
    if (vb === null) return -1;

    let cmp;
    if (sortBy === 'name') {
      cmp = String(va).localeCompare(String(vb), 'zh-Hans-CN');
    } else {
      cmp = va - vb;
    }
    if (cmp !== 0) return cmp * dir;
    // 同分时退回 code 保证确定性，再退回原始序
    const ca = str(a.ev.code);
    const cb = str(b.ev.code);
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.index - b.index;
  });

  let out = items.map((x) => x.ev);
  const limit = num(opts.limit);
  if (limit !== null && limit > 0) {
    out = out.slice(0, Math.floor(limit));
  }

  return { items: out, total };
}
