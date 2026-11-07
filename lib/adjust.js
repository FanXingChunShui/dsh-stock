/**
 * dsh-stock-surf / lib/adjust.js
 * 自建前复权（forward adjustment）—— 量化模块的地基。
 *
 * ── 为什么必须自建 ───────────────────────────────────────────────
 * 本插件 A 股日 K 的主源是新浪，返回的是**不复权**数据。除权除息日当天
 * 交易所会把股价按分红送转比例下调，K 线上留下一个「假跳空」：这不是真实
 * 亏损，却会被均线、RSI、收益率计算当成暴跌。
 *
 * 现成的前复权接口实测全部不可用：
 *   腾讯 fqkline      → HTTP 501 + waf.tencent.com 跳转页
 *   东财 push2his     → 网络不可达（IPv6）
 *   网易 chddata      → HTTP 502
 * 所以只能拿「不复权 K 线 + 分红送配事件」自己算。
 *
 * ── 算法 ────────────────────────────────────────────────────────
 * 对每个除权除息日 exDate（按日期升序处理）：
 *
 *   每股派息  div  = 派息(每10股) / 10
 *   每股送转  add  = (送股(每10股) + 转增(每10股)) / 10
 *   除权参考价 theo = (前收 - div) / (1 + add)
 *   复权因子   f    = theo / 前收
 *
 * 然后把 exDate **之前**的所有价格乘以 f。
 *
 * 做法上从最早的事件往后依次处理，每次只缩放「该事件之前」的区间，
 * 因此越早的价格被乘的因子越多——这正是前复权的定义（历史价格统一
 * 折算到当前的价格体系）。
 *
 * ── 强约束：末根 K 线复权前后必须完全相等 ─────────────────────────
 * 前复权以「最新价」为锚点，所以最新一根 K 线不参与任何缩放。这条性质
 * 同时是最好的正确性校验：任何实现错误几乎都会破坏它。见 verifyAnchor()。
 *
 * ── 成交量为什么不调整 ──────────────────────────────────────────
 * 成交量在除权日**本来就会**因为价格变化而变化（价格减半、股数翻倍，
 * 换手金额相近），按价格因子去缩放成交量等于把真实的量能变化抹掉，
 * 反而让量比、量能因子失真。前复权的行业惯例是只调整价格。
 * 所以这里 volume 原样保留。
 *
 * 纯函数、零 IO、零网络、零 npm 依赖。
 *
 * @module dsh-stock-surf/adjust
 */

/* ════════════════════════════════════════════════════════════════
 * 工具
 * ════════════════════════════════════════════════════════════════ */

/** 转有限数字，非法返回 null。 */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 是否为 YYYY-MM-DD。 */
function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const PRICE_KEYS = ['open', 'high', 'low', 'close'];

/* ════════════════════════════════════════════════════════════════
 * 复权因子
 * ════════════════════════════════════════════════════════════════ */

/**
 * 规范化一条分红送配事件，丢弃无效记录。
 *
 * @param {object} raw
 * @returns {{exDate:string, song:number, zhuan:number, pai:number, annDate:string|null}|null}
 */
function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  // 兼容 lib/bonus.js 的字段命名（exDate/annDate）与可能的简写（ex/ann）
  const exDate = isDate(raw.exDate) ? raw.exDate : isDate(raw.ex) ? raw.ex : null;
  if (!exDate) return null;

  const song = num(raw.song) ?? 0;
  const zhuan = num(raw.zhuan) ?? 0;
  const pai = num(raw.pai) ?? 0;

  // 全为 0 的事件不产生任何价格影响，留着只会白算一次
  if (song <= 0 && zhuan <= 0 && pai <= 0) return null;

  const annDate = isDate(raw.annDate) ? raw.annDate : isDate(raw.ann) ? raw.ann : null;
  return { exDate, song, zhuan, pai, annDate };
}

/**
 * 计算每个除权日对应的复权因子。
 *
 * 返回的因子描述「该除权日之前的价格要乘以多少」。同一天多条事件会合并
 * 成一个因子（现实中很少见，但送转+派息分两行公告是可能的）。
 *
 * @param {Array<object>} bars 升序 K 线
 * @param {Array<object>} events 分红送配事件
 * @returns {Array<{date:string, factor:number, theo:number|null, prevClose:number|null, event:object}>}
 */
export function buildFactors(bars, events) {
  const list = Array.isArray(bars) ? bars : [];
  const raw = Array.isArray(events) ? events : [];
  if (list.length === 0 || raw.length === 0) return [];

  const cleaned = [];
  for (const item of raw) {
    const normalized = normalizeEvent(item);
    if (normalized) cleaned.push(normalized);
  }
  if (cleaned.length === 0) return [];

  // 同一天多条事件先合并：送股/转增/派息各自相加
  const merged = new Map();
  for (const ev of cleaned) {
    const prev = merged.get(ev.exDate);
    if (prev) {
      prev.song += ev.song;
      prev.zhuan += ev.zhuan;
      prev.pai += ev.pai;
    } else {
      merged.set(ev.exDate, { ...ev });
    }
  }

  const dates = [...merged.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const out = [];
  for (const exDate of dates) {
    const ev = merged.get(exDate);

    // 找「除权日之前最后一个交易日」的收盘价，作为计算参考价的前收。
    //
    // 这里用线性扫描而不是二分：二分要求数组严格有序，而 K 线**可能不是**
    // 有序的（缓存拼接、接口偶发乱序、停牌补数据都可能打乱）。一旦乱序，
    // 二分会给出一个看似有效、实则错误的下标，复权因子直接算错且静默无报错。
    // 线性扫描对乱序输入也给稳定结果（取第一个不满足条件的边界），而 K 线
    // 通常只有几百到一千多根、事件几十个，这点开销可以忽略。
    let idx = -1;
    for (let i = 0; i < list.length; i += 1) {
      const day = list[i] && list[i].date;
      if (typeof day !== 'string') continue;
      if (day < exDate) idx = i;
      else break;
    }

    // 除权日之前没有任何 K 线（事件早于区间起点）：无需复权，跳过
    if (idx < 0) continue;

    // 除权日之后必须还有至少一根 K 线，否则说明事件晚于本区间末尾
    // （K 线被截断、停牌、或数据未更新到除权日）。
    //
    // 这种情况必须跳过：前复权以「最新价」为锚点，如果事件在区间之外，
    // 它对本区间的价格没有任何影响。若不跳过，idx 会落在末根上，
    // 缩放循环里 `bar.date >= exDate` 永不成立，末根会被一起乘因子，
    // 直接破坏「末根价格不变」这条强约束。
    if (idx >= list.length - 1) continue;

    const prevClose = num(list[idx].close);
    if (prevClose === null || prevClose <= 0) continue;

    const div = ev.pai / 10;
    const add = (ev.song + ev.zhuan) / 10;
    const theo = (prevClose - div) / (1 + add);

    // 送转异常或分红超过股价时 theo 可能 <= 0，此时因子无意义，跳过并保留原值
    if (!(theo > 0)) continue;

    const factor = theo / prevClose;
    if (!Number.isFinite(factor) || factor <= 0) continue;

    out.push({ date: exDate, factor, theo, prevClose, event: ev });
  }

  return out;
}

/* ════════════════════════════════════════════════════════════════
 * 前复权
 * ════════════════════════════════════════════════════════════════ */

/**
 * 深拷贝一根 K 线，价格统一转成有限数字。
 * 原始数据里价格可能是字符串（新浪接口返回的就是字符串）。
 */
function cloneBar(bar) {
  const out = {
    date: typeof bar.date === 'string' ? bar.date : '',
    open: num(bar.open),
    high: num(bar.high),
    low: num(bar.low),
    close: num(bar.close),
    // 成交量原样保留，理由见文件头
    volume: num(bar.volume) ?? 0,
  };
  // 透传其它字段（amount 等），避免下游丢信息
  for (const key of Object.keys(bar)) {
    if (key in out) continue;
    out[key] = bar[key];
  }
  return out;
}

/**
 * 前复权主入口。纯函数：不修改入参。
 *
 * @param {Array<object>} bars 不复权 K 线，按日期升序
 * @param {Array<object>} events 分红送配事件（来自 lib/bonus.js）
 * @param {{ precision?: number }} [options] 价格保留小数位，默认 4
 * @returns {{
 *   bars: Array<object>,      // 复权后的 K 线（新数组、新对象）
 *   factors: Array<object>,   // 生效的复权因子
 *   adjusted: boolean,        // 是否真的发生了复权
 *   events: number,           // 影响本区间的除权事件数
 *   warning: string|null      // 降级说明
 * }}
 */
export function adjustBars(bars, events, options = {}) {
  const list = Array.isArray(bars) ? bars : [];
  const precision = Number.isFinite(options.precision) ? Math.max(0, Math.min(8, Math.floor(options.precision))) : 4;

  // 深拷贝，保证纯函数性与「无事件时原样返回」
  const out = list.map(cloneBar);

  if (out.length === 0) {
    return { bars: out, factors: [], adjusted: false, events: 0, warning: null };
  }

  const rawEvents = Array.isArray(events) ? events : [];
  if (rawEvents.length === 0) {
    return { bars: out, factors: [], adjusted: false, events: 0, warning: null };
  }

  const factors = buildFactors(out, rawEvents);
  if (factors.length === 0) {
    // 有事件但都不影响本区间（要么早于起点，要么数据异常被跳过）
    return { bars: out, factors: [], adjusted: false, events: 0, warning: null };
  }

  // 累计因子：从最早的事件开始，把该事件之前的区间再乘一次。
  //
  // 关键点：**先算出每根 K 线的累计因子，最后只舍入一次**。
  // 如果每乘一次因子就 round 一次，早期 K 线会被舍入多次，误差累积
  // （实测 10 送 10 + 派息场景下，两次舍入会让结果偏离 0.0022，远超断言容差）。
  // 连乘后再统一舍入，误差只来自最后一次。
  const cumFactor = new Array(out.length).fill(1);
  const touched = new Array(out.length).fill(false);
  for (const item of factors) {
    const exDate = item.date;
    for (let i = 0; i < out.length; i += 1) {
      const date = out[i].date;
      if (typeof date !== 'string' || date >= exDate) break;
      cumFactor[i] *= item.factor;
      touched[i] = true;
    }
  }

  for (let i = 0; i < out.length; i += 1) {
    if (!touched[i]) continue;
    const factor = cumFactor[i];
    for (const key of PRICE_KEYS) {
      const value = out[i][key];
      if (value === null) continue;
      out[i][key] = round(value * factor, precision);
    }
  }

  const anchor = verifyAnchor(list, out);
  if (!anchor.ok) {
    // 锚点校验失败说明复权过程本身出了问题（方向反了、边界错了、分红数据
    // 有误）。这时候**必须真的退回不复权数据**，而不是只打个 warning 却把
    // 错误的价格喂给下游——「提示说用了不复权、实际给了错数据」是最糟的组合，
    // score.js 会照单全收，一路传到评分和回测里。
    return {
      bars: list.map(cloneBar),
      factors: [],
      adjusted: false,
      events: 0,
      warning: `${anchor.message}（已退回不复权数据）`,
    };
  }

  return {
    bars: out,
    factors,
    adjusted: true,
    events: factors.length,
    warning: null,
  };
}

/** 保留小数位；同时避免浮点尾差（0.1*3=0.30000000000000004）。 */
function round(value, digits) {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * 校验「末根 K 线复权前后完全相等」。
 *
 * 前复权以最新价为锚点，最新一根不应被任何因子缩放。这是最强的正确性
 * 自检——任何方向搞反、区间边界写错，都会立刻破坏它。
 *
 * 实际会有舍入误差（价格保留 4 位小数），所以给一个极小的容差。
 *
 * @param {Array<object>} raw 原始 K 线
 * @param {Array<object>} adjusted 复权后 K 线
 * @returns {{ok: boolean, message: string|null}}
 */
export function verifyAnchor(raw, adjusted) {
  if (!Array.isArray(raw) || !Array.isArray(adjusted)) return { ok: true, message: null };
  const last = raw.length - 1;
  if (last < 0 || adjusted.length !== raw.length) return { ok: true, message: null };

  const before = num(raw[last] && raw[last].close);
  const after = num(adjusted[last] && adjusted[last].close);
  if (before === null || after === null) return { ok: true, message: null };

  const diff = Math.abs(before - after);
  const tolerance = Math.max(1e-6, Math.abs(before) * 1e-9);
  if (diff <= tolerance) return { ok: true, message: null };

  return {
    ok: false,
    message: `前复权锚点校验失败：末根收盘价 ${before} → ${after}（相差 ${diff}），复权结果不可信，已按不复权数据处理`,
  };
}

export default { adjustBars, buildFactors, verifyAnchor };
