/**
 * dsh-stock-surf / lib/quant.js
 * 量化服务层 —— 把复权、回测、选股串成对外可用的能力。
 *
 * ── 职责边界 ────────────────────────────────────────────────────
 * 本文件是**有 IO 的一层**（取 K 线、取分红、取全市场列表），把纯函数模块
 * （lib/adjust.js、lib/backtest.js、lib/score.js）组装成完整业务：
 *
 *   quantBacktest   单股回测      取数 → 复权 → 回测
 *   quantScan       全市场选股    列表 → 截面预筛 → 只对候选取K线评分
 *   quantPortfolio  组合回测      多标的回测 → 等权合成净值
 *
 * 纯计算全部留在下游模块里，所以本文件可以放心地有网络调用，而回测逻辑
 * 依然可以被单测覆盖。
 *
 * ── 为什么单股回测必须先复权 ────────────────────────────────────
 * A 股日 K 主源（新浪）返回不复权数据，除权日会留下假跳空。实测浦发银行
 * 除权日跳空 -4.31%，不复权的话这一根 K 线会被 RSI/MACD 当成暴跌，回测
 * 在这里进出场都会失真。复权后该跳空降到 0.00%。
 *
 * ── 为什么选股要两阶段 ──────────────────────────────────────────
 * 5578 只逐只取 K 线，并发 8 也要 65 秒，不可接受。而全市场列表（新浪
 * Market_Center）本身已带回涨跌幅、换手率、市值、PE，可以直接做截面粗筛，
 * 只对 2%-3% 的候选真正取 K 线。实测 2000 只粗筛 + 150 只取 K 线约 1.1 秒。
 *
 * @module dsh-stock-surf/quant
 */

import { loadStockData, normalizeCode } from './quote.js';
import { listStocksByMarket } from './stock-list.js';
import { fetchBonusEvents } from './bonus.js';
import { adjustBars } from './adjust.js';
import { runBacktest, resolveStrategy, STRATEGIES, DISCLAIMER as BACKTEST_DISCLAIMER } from './backtest.js';
import { evaluateStock } from './score.js';

/* ════════════════════════════════════════════════════════════════
 * 常量
 * ════════════════════════════════════════════════════════════════ */

const ERR = 'astock: ';

/** 量化模块自己的免责声明，比技术评分更强——回测历史表现绝不预示未来。 */
export const QUANT_DISCLAIMER =
  '量化回测基于历史行情数据，用固定规则重放过去并统计收益与风险指标。历史表现不代表未来收益，' +
  '回测结果会受数据质量、复权口径、成交假设（如按次日开盘价成交、忽略冲击成本）等因素影响，' +
  '参数与样本区间稍作调整就可能显著改变结论。本功能仅用于研究策略的历史特征，不构成任何投资建议。';

/**
 * 单股回测默认取多少根日 K。
 *
 * 1200 根 ≈ 5 年，减去 warmup(120) 还有 1000+ 个决策点。新浪对 A 股
 * 单次最多给 1500 根左右，1200 是留了余量的安全值。
 */
const DEFAULT_BACKTEST_BARS = 1200;

/** 回测区间上限：再长就超出新浪可提供的深度。 */
const MAX_BACKTEST_BARS = 1500;

/**
 * 并发取 K 线的路数。
 *
 * 实测取 150 只日 K：并发 8 → 1554ms，16 → 886ms，24 → 593ms。
 * 选 16 而不是 24 是刻意留余量：24 虽然更快，但离新浪的限流阈值太近，
 * 一旦被限流整批失败，用户体验比慢 0.3 秒差得多。
 */
const FETCH_CONCURRENCY = 16;

/** 选股默认候选池上限（真正取 K 线的只数）。 */
const DEFAULT_SCAN_SHORTLIST = 150;

/** 选股默认返回条数。 */
const DEFAULT_SCAN_LIMIT = 30;

/**
 * 默认截面预筛条件。
 *
 * 这些条件会**淘汰掉一部分股票**，所以必须原样回传给前端展示——
 * 用户需要知道「筛掉了什么」，否则会误以为结果就是全市场最优。
 *
 * 为什么是这几个值：
 *   changeMin/Max  排除暴跌与涨停追高。评分器偏好温和上涨，
 *                  涨停股次日多半高开低走，回测里是负面样本。
 *   turnoverMin    低于 1% 说明缺乏流动性，买卖冲击成本会吞掉收益。
 *   turnoverMax    高于 15% 通常是爆炒或次新股，波动不可控。
 *   floatCapMin    流通市值低于 30 亿的标的易被操纵，指标失真。
 */
const DEFAULT_FILTERS = Object.freeze({
  changeMin: -3,
  changeMax: 5,
  turnoverMin: 1,
  turnoverMax: 15,
  floatCapMin: 30,
  excludeSuspended: true,
});

/* ════════════════════════════════════════════════════════════════
 * 工具
 * ════════════════════════════════════════════════════════════════ */

/** 有限数字，非法返回 null。 */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 把参数夹到 [min, max]，非法时取 fallback。 */
function clamp(value, min, max, fallback) {
  const n = num(value);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 以固定并发跑一组异步任务，保持结果顺序。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 判断一个 secid 是不是指数。
 *
 * 为什么需要这个判断：分红接口只认 6 位数字，不区分市场。`sh000001`（上证
 * 指数）会被当成 `000001` 去查，实测返回的是**平安银行**的 30 条分红记录。
 * 若拿它给指数做复权，指数点位会被凭空缩放，回测结果完全错误。
 *
 * A 股指数编码规律：沪市 000xxx/880xxx/999xxx，深市 399xxx，中证 000xxx。
 * 个股与指数的交集很小，这里只拦最典型的一批（000/399/880 开头）。
 */
function isIndexSecid(secid) {
  if (typeof secid !== 'string') return false;
  const m = secid.match(/^(sh|sz|bj)(\d{6})$/);
  if (!m) return false;
  const [, market, digits] = m;
  if (market === 'sh') return digits.startsWith('000') || digits.startsWith('880') || digits.startsWith('999');
  if (market === 'sz') return digits.startsWith('399');
  return false;
}

/* ════════════════════════════════════════════════════════════════
 * 单股回测
 * ════════════════════════════════════════════════════════════════ */

/**
 * 取一只股票的「前复权日 K」。
 *
 * @param {string} secid 规范化后的 secid
 * @param {object} options
 * @returns {Promise<{bars: object[], adjusted: boolean, factors: number, warnings: string[]}>}
 */
async function loadAdjustedBars(secid, options = {}) {
  const { days, timeoutMs, signal, noCache } = options;
  const warnings = [];

  const { bars, warnings: loadWarnings } = await loadStockData(secid, {
    days,
    timeoutMs,
    signal,
    noCache,
  });
  if (Array.isArray(loadWarnings)) warnings.push(...loadWarnings);

  if (bars.length === 0) {
    return { bars: [], adjusted: false, factors: 0, warnings };
  }

  // 指数不做复权：分红接口不区分市场，会把同号码个股的分红套到指数上
  if (isIndexSecid(secid)) {
    warnings.push('该代码是指数，指数没有分红送配，已跳过前复权处理');
    return { bars, adjusted: false, factors: 0, warnings };
  }

  // 港股/美股：分红接口不覆盖，fetchBonusEvents 会返回 reason='unsupported'，
  // 此时按不复权处理并在 warnings 里说明（腾讯源本身已是前复权，无需再调）
  const events = await fetchBonusEvents(secid, { timeoutMs, signal, noCache });
  if (events.ok === false && events.reason === 'unsupported') {
    warnings.push('港股/美股未做本地前复权（分红接口不覆盖该市场）；若数据源本身为不复权，除权日附近指标可能失真');
    return { bars, adjusted: false, factors: 0, warnings };
  }
  if (events.ok === false) {
    // 分红取数失败：宁可退回不复权并明说，也不要假装复权成功
    warnings.push(`分红数据获取失败（${events.reason ?? '未知原因'}），已跳过前复权，除权日附近指标可能失真`);
    return { bars, adjusted: false, factors: 0, warnings };
  }

  const result = adjustBars(bars, events, {});
  if (result.warning) warnings.push(result.warning);
  if (result.adjusted) {
    warnings.push(`已按 ${result.events} 次除权除息事件做前复权，消除除权日价格跳空`);
  }

  return { bars: result.bars, adjusted: result.adjusted, factors: result.events, warnings };
}

/**
 * 单股策略回测。
 *
 * @param {{ code: string, strategy?: string, days?: number, warmup?: number,
 *           thresholdBuy?: number, thresholdSell?: number, feeRate?: number,
 *           initialCash?: number, timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} payload
 * @returns {Promise<object>}
 */
export async function quantBacktest(payload = {}) {
  const raw = payload && typeof payload === 'object' ? payload : {};

  const normalized = normalizeCode(raw.code);
  if (normalized === null) throw new Error(`${ERR}无法识别的股票代码「${String(raw.code ?? '')}」`);

  const days = Math.floor(clamp(raw.days, 130, MAX_BACKTEST_BARS, DEFAULT_BACKTEST_BARS));
  const strategyName = typeof raw.strategy === 'string' ? raw.strategy : 'score-threshold';

  const loaded = await loadAdjustedBars(normalized.secid, {
    days,
    timeoutMs: num(raw.timeoutMs) ?? undefined,
    signal: raw.signal,
    noCache: raw.noCache === true,
  });

  const warnings = [...loaded.warnings];
  if (loaded.bars.length === 0) {
    return {
      ok: false,
      code: normalized.code,
      secid: normalized.secid,
      name: null,
      strategy: strategyName,
      adjusted: false,
      disclaimer: QUANT_DISCLAIMER,
      warnings: [...warnings, '未取到任何 K 线数据，无法回测'],
    };
  }

  // 顺便取一份当前评分，让回测结果能对上「现在这只股票什么状态」
  let current = null;
  try {
    const quote = (await loadStockData(normalized.secid, { days: 1, timeoutMs: num(raw.timeoutMs) ?? undefined, signal: raw.signal })).quote;
    current = evaluateStock({ quote, bars: loaded.bars.slice(-320) });
  } catch {
    warnings.push('当前评分获取失败，回测结果不含实时评分');
  }

  const backtest = runBacktest({
    bars: loaded.bars,
    strategy: strategyName,
    options: {
      ...(num(raw.warmup) !== null ? { warmup: Math.floor(clamp(raw.warmup, 30, 400, 120)) } : {}),
      ...(num(raw.thresholdBuy) !== null ? { thresholdBuy: clamp(raw.thresholdBuy, 50, 95, 60) } : {}),
      ...(num(raw.thresholdSell) !== null ? { thresholdSell: clamp(raw.thresholdSell, 5, 50, 40) } : {}),
      ...(num(raw.feeRate) !== null ? { feeRate: clamp(raw.feeRate, 0, 0.01, 0.0003) } : {}),
      ...(num(raw.initialCash) !== null ? { initialCash: clamp(raw.initialCash, 1000, 1e9, 100000) } : {}),
    },
  });

  if (Array.isArray(backtest.warnings)) warnings.push(...backtest.warnings);

  return {
    ...backtest,
    code: normalized.code,
    secid: normalized.secid,
    name: current?.name ?? null,
    market: normalized.market,
    currency: normalized.currency,
    adjusted: loaded.adjusted,
    adjustmentEvents: loaded.factors,
    current: current
      ? {
          price: current.price,
          changePercent: current.changePercent,
          score: current.score,
          verdict: current.verdict,
          verdictLabel: current.verdictLabel,
          asOf: current.asOf,
        }
      : null,
    disclaimer: QUANT_DISCLAIMER,
    warnings,
  };
}

/* ════════════════════════════════════════════════════════════════
 * 全市场选股
 * ════════════════════════════════════════════════════════════════ */

/**
 * 截面粗筛：只用列表里已有的字段，零额外请求。
 *
 * @param {object[]} rows 全市场列表
 * @param {object} filters 已规范化的筛选条件
 * @returns {{ passed: object[], rejected: number }}
 */
function prescreen(rows, filters) {
  const passed = [];
  let rejected = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      rejected += 1;
      continue;
    }
    if (filters.excludeSuspended && row.isSuspended) {
      rejected += 1;
      continue;
    }
    const price = num(row.price);
    if (price === null || price <= 0) {
      rejected += 1;
      continue;
    }
    const change = num(row.changePercent);
    if (change === null || change < filters.changeMin || change > filters.changeMax) {
      rejected += 1;
      continue;
    }
    const turnover = num(row.turnoverRate);
    if (turnover === null || turnover < filters.turnoverMin || turnover > filters.turnoverMax) {
      rejected += 1;
      continue;
    }
    const floatCap = num(row.floatCap);
    if (floatCap === null || floatCap < filters.floatCapMin) {
      rejected += 1;
      continue;
    }
    passed.push(row);
  }
  return { passed, rejected };
}

/**
 * 截面预排序分。
 *
 * 这一步**不是**最终评分，只是决定「谁值得花一次网络请求去取 K 线」。
 * 它偏好：涨幅温和（接近 +1.5%）、换手活跃、流动性好。
 *
 * 为什么要预排序：粗筛后通常还有 1000+ 只，全部取 K 线仍然是几十秒。
 * 预排序把候选压到 150 只以内，让整次扫描控制在秒级。
 *
 * ⚠️ 这是本模块最大的「隐式主观性」来源：预排序会漏掉某些类型的股票
 * （例如低换手的大盘蓝筹）。所以结果里必须标注说明，见 scanMeta。
 *
 * @param {object} row
 * @returns {number} 0-1
 */
function prescore(row) {
  const change = num(row.changePercent) ?? 0;
  const turnover = num(row.turnoverRate) ?? 0;
  const floatCap = num(row.floatCap) ?? 30;

  // 涨幅越接近 +1.5% 越好：太弱说明没资金关注，太强说明已追高
  const s1 = Math.max(0, 1 - Math.abs(change - 1.5) / 5);
  // 换手越高越活跃，8% 封顶（再高就是爆炒）
  const s2 = Math.min(Math.max(turnover, 0), 8) / 8;
  // 流动性：对数压缩，避免巨型股碾压
  const s3 = Math.min(Math.log10(Math.max(floatCap, 1) + 1) / 2, 1);

  return s1 * 0.5 + s2 * 0.3 + s3 * 0.2;
}

/**
 * 全市场选股扫描。
 *
 * 流程：全市场列表（缓存）→ 截面粗筛 → 预排序取前 N → 并发取 K 线评分 → 排序返回。
 *
 * @param {{ market?: 'cn'|'hk'|'us', limit?: number, shortlist?: number,
 *           filters?: object, days?: number, timeoutMs?: number,
 *           signal?: AbortSignal, noCache?: boolean }} payload
 * @returns {Promise<object>}
 */
export async function quantScan(payload = {}) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const startedAt = Date.now();

  const market = raw.market === 'hk' || raw.market === 'us' ? raw.market : 'cn';
  const limit = Math.floor(clamp(raw.limit, 1, 200, DEFAULT_SCAN_LIMIT));
  const shortlist = Math.floor(clamp(raw.shortlist, 10, 400, DEFAULT_SCAN_SHORTLIST));
  const days = Math.floor(clamp(raw.days, 60, 600, 320));

  const warnings = [];

  if (market !== 'cn') {
    warnings.push(`${market === 'hk' ? '港股' : '美股'}没有免费全量列表，选股扫描只覆盖 A 股`);
    return {
      ok: false,
      market,
      items: [],
      total: 0,
      warnings,
      disclaimer: QUANT_DISCLAIMER,
    };
  }

  const inputFilters = raw.filters && typeof raw.filters === 'object' ? raw.filters : {};
  const filters = {
    changeMin: clamp(inputFilters.changeMin, -20, 20, DEFAULT_FILTERS.changeMin),
    changeMax: clamp(inputFilters.changeMax, -20, 20, DEFAULT_FILTERS.changeMax),
    turnoverMin: clamp(inputFilters.turnoverMin, 0, 100, DEFAULT_FILTERS.turnoverMin),
    turnoverMax: clamp(inputFilters.turnoverMax, 0, 100, DEFAULT_FILTERS.turnoverMax),
    floatCapMin: clamp(inputFilters.floatCapMin, 0, 100000, DEFAULT_FILTERS.floatCapMin),
    excludeSuspended: inputFilters.excludeSuspended !== false,
  };

  const listStarted = Date.now();
  const { rows, meta } = await listStocksByMarket('cn', {
    timeoutMs: num(raw.timeoutMs) ?? undefined,
    signal: raw.signal,
    noCache: raw.noCache === true,
  });
  const listMs = Date.now() - listStarted;
  if (meta && meta.complete === false) {
    warnings.push(`全市场列表不完整（${meta.note ?? '源限制'}），扫描结果可能遗漏标的`);
  }

  const { passed, rejected } = prescreen(rows, filters);
  if (passed.length === 0) {
    return {
      ok: false,
      market,
      items: [],
      total: 0,
      filters,
      scanMeta: { universe: rows.length, prescreened: 0, rejected, shortlist: 0, listMs, totalMs: Date.now() - startedAt },
      warnings: [...warnings, '按当前筛选条件下没有股票通过截面粗筛，请放宽条件'],
      disclaimer: QUANT_DISCLAIMER,
    };
  }

  // 预排序取前 N
  const ranked = passed
    .map((row) => ({ row, pre: prescore(row) }))
    .sort((a, b) => b.pre - a.pre)
    .slice(0, shortlist);

  // 并发取 K 线并评分
  const scored = await mapLimit(ranked, FETCH_CONCURRENCY, async (item) => {
    const row = item.row;
    try {
      const { bars } = await loadStockData(row.secid, {
        days,
        timeoutMs: num(raw.timeoutMs) ?? undefined,
        signal: raw.signal,
        noCache: raw.noCache === true,
      });
      if (bars.length === 0) {
        return { ok: false, reason: '无 K 线数据', row };
      }
      const evaluation = evaluateStock({ quote: null, bars });
      return {
        ok: true,
        pre: item.pre,
        row,
        evaluation,
      };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : String(error), row };
    }
  });

  const failed = scored.filter((item) => !item.ok);
  const items = scored
    .filter((item) => item.ok)
    .map((item) => {
      const row = item.row;
      const evaluation = item.evaluation;
      return {
        secid: row.secid,
        code: row.code,
        name: row.name,
        market: row.market,
        price: num(row.price),
        changePercent: num(row.changePercent),
        turnoverRate: num(row.turnoverRate),
        floatCap: num(row.floatCap),
        peTtm: num(row.peTtm),
        score: evaluation.score,
        verdict: evaluation.verdict,
        verdictLabel: evaluation.verdictLabel,
        upProbability: evaluation.upProbability,
        prescore: Number(item.pre.toFixed(3)),
        summary: evaluation.summary,
        risks: evaluation.risks,
        factors: evaluation.factors.map((f) => ({
          key: f.key,
          label: f.label,
          score: f.score,
          weight: f.weight,
        })),
      };
    })
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))
    .slice(0, limit);

  if (failed.length > 0) {
    warnings.push(`${failed.length} 只候选股取数或评分失败，已从结果中剔除（如网络波动）`);
  }

  return {
    ok: items.length > 0,
    market: 'cn',
    items,
    total: items.length,
    filters,
    scanMeta: {
      universe: rows.length,
      prescreened: passed.length,
      rejected,
      shortlist: ranked.length,
      scored: scored.filter((s) => s.ok).length,
      failed: failed.length,
      listMs,
      totalMs: Date.now() - startedAt,
      // 把「隐式筛选」摊开给用户看：这两个数字说明结果不是全市场最优
      note: '先按截面条件粗筛，再按量价活跃度预排序取前若干只做完整技术评分；不是全市场逐只评分',
    },
    warnings,
    disclaimer: QUANT_DISCLAIMER,
  };
}

/* ════════════════════════════════════════════════════════════════
 * 组合回测
 * ════════════════════════════════════════════════════════════════ */

/**
 * 多标的等权组合回测。
 *
 * 合成方式：各标的从共同起始日开始等权配置，日收益率取等权平均，
 * 得到组合净值曲线。这样不同标的的上市时间差异不会污染组合收益。
 *
 * @param {{ codes: string[], strategy?: string, days?: number, timeoutMs?: number,
 *           signal?: AbortSignal, noCache?: boolean }} payload
 * @returns {Promise<object>}
 */
export async function quantPortfolio(payload = {}) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const input = Array.isArray(raw.codes) ? raw.codes : [];
  const warnings = [];

  // 去重 + 规范化，最多 20 只（再多取数时间不可控）
  const seen = new Set();
  const targets = [];
  for (const code of input) {
    const normalized = normalizeCode(code);
    if (!normalized) continue;
    if (seen.has(normalized.secid)) continue;
    seen.add(normalized.secid);
    targets.push(normalized);
    if (targets.length >= 20) break;
  }

  if (targets.length === 0) {
    return {
      ok: false,
      items: [],
      equity: [],
      stats: null,
      warnings: ['没有可回测的标的，请先在自选股里添加股票'],
      disclaimer: QUANT_DISCLAIMER,
    };
  }
  if (input.length > 20) warnings.push(`组合最多回测 20 只标的，已取前 20 只`);

  const days = Math.floor(clamp(raw.days, 130, MAX_BACKTEST_BARS, DEFAULT_BACKTEST_BARS));
  const strategyName = typeof raw.strategy === 'string' ? raw.strategy : 'score-threshold';

  const results = await mapLimit(targets, 4, async (target) => {
    try {
      const result = await quantBacktest({
        code: target.secid,
        strategy: strategyName,
        days,
        timeoutMs: raw.timeoutMs,
        signal: raw.signal,
        noCache: raw.noCache,
      });
      return { target, result };
    } catch (error) {
      return {
        target,
        result: { ok: false, warnings: [error && error.message ? error.message : String(error)] },
      };
    }
  });

  const usable = results.filter((item) => item.result.ok && Array.isArray(item.result.equity) && item.result.equity.length > 1);
  if (usable.length === 0) {
    return {
      ok: false,
      items: [],
      equity: [],
      stats: null,
      warnings: [...warnings, '所有标的都无法完成回测（数据不足或取数失败）'],
      disclaimer: QUANT_DISCLAIMER,
    };
  }
  if (usable.length < targets.length) {
    warnings.push(`${targets.length - usable.length} 只标的回测失败或数据不足，已从组合中剔除`);
  }

  // 取各标的净值的共同日期区间（越晚的开始日、越早的结束日）
  const startDates = usable.map((item) => item.result.equity[0].date).filter(Boolean).sort();
  const endDates = usable.map((item) => item.result.equity[item.result.equity.length - 1].date).filter(Boolean).sort();
  const startDate = startDates[startDates.length - 1];
  const endDate = endDates[0];
  if (!startDate || !endDate || startDate >= endDate) {
    return {
      ok: false,
      items: [],
      equity: [],
      stats: null,
      warnings: [...warnings, '各标的回测区间没有重叠，无法合成组合'],
      disclaimer: QUANT_DISCLAIMER,
    };
  }

  // 按日期建索引，只保留共同区间
  const series = usable.map((item) => {
    const map = new Map();
    for (const point of item.result.equity) map.set(point.date, num(point.equity));
    return { name: item.result.name ?? item.target.code, code: item.target.code, secid: item.target.secid, map };
  });

  // 取共同区间内出现过的全部日期（以第一只为准，再过滤到区间内）
  const dates = usable[0].result.equity
    .map((point) => point.date)
    .filter((date) => date >= startDate && date <= endDate);

  const equity = [];
  let prevValue = 1;
  for (const date of dates) {
    // 等权：每只标的当日的净值相对其自身首日的比值，再取平均
    const ratios = [];
    for (const item of series) {
      const value = item.map.get(date);
      if (value === null || value === undefined) continue;
      const base = item.map.get(startDate);
      if (base === null || base === undefined || base === 0) continue;
      ratios.push(value / base);
    }
    if (ratios.length === 0) continue;
    const value = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
    equity.push({ date, equity: Number((value * 100).toFixed(4)), benchmark: null });
    prevValue = value;
  }

  if (equity.length < 2) {
    return {
      ok: false,
      items: [],
      equity: [],
      stats: null,
      warnings: [...warnings, '共同区间内的净值点不足，无法合成组合'],
      disclaimer: QUANT_DISCLAIMER,
    };
  }

  // 组合统计：直接基于合成后的净值序列算，与单标的同口径
  const first = equity[0].equity;
  const last = equity[equity.length - 1].equity;
  const totalReturn = (last / first - 1) * 100;

  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const point of equity) {
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) {
      const dd = ((peak - point.equity) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const daysBetween = (Date.parse(endDate) - Date.parse(startDate)) / 86400000;
  const annualReturn = daysBetween > 0 && last > 0 && first > 0
    ? (Math.pow(last / first, 365 / daysBetween) - 1) * 100
    : null;

  const dailyReturns = [];
  for (let i = 1; i < equity.length; i += 1) {
    const prev = equity[i - 1].equity;
    const next = equity[i].equity;
    if (prev > 0) dailyReturns.push((next - prev) / prev);
  }
  let sharpe = null;
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
    const sd = Math.sqrt(variance);
    if (sd > 0) sharpe = (mean / sd) * Math.sqrt(252);
  }

  const items = usable.map((item) => ({
    code: item.target.code,
    secid: item.target.secid,
    name: item.result.name ?? null,
    totalReturn: item.result.stats?.totalReturn ?? null,
    tradeCount: item.result.stats?.tradeCount ?? null,
    winRate: item.result.stats?.winRate ?? null,
    maxDrawdown: item.result.stats?.maxDrawdown ?? null,
  }));

  return {
    ok: true,
    items,
    equity,
    startDate,
    endDate,
    strategy: strategyName,
    stats: {
      totalReturn: Number(totalReturn.toFixed(2)),
      annualReturn: annualReturn === null ? null : Number(annualReturn.toFixed(2)),
      maxDrawdown: Number(maxDrawdown.toFixed(2)),
      sharpe: sharpe === null ? null : Number(sharpe.toFixed(2)),
      members: usable.length,
      days: dates.length,
    },
    warnings,
    disclaimer: QUANT_DISCLAIMER,
  };
}

/* ════════════════════════════════════════════════════════════════
 * 策略清单
 * ════════════════════════════════════════════════════════════════ */

/** 可用策略列表（给 UI 下拉框用）。 */
export function quantStrategies() {
  const out = [];
  for (const [key, value] of Object.entries(STRATEGIES)) {
    const resolved = resolveStrategy(key);
    out.push({
      key,
      label: resolved && resolved.label ? resolved.label : key,
      description: resolved && resolved.description ? resolved.description : '',
      params: resolved && resolved.params ? resolved.params : {},
    });
  }
  return {
    items: out,
    default: 'score-threshold',
    disclaimer: BACKTEST_DISCLAIMER ?? QUANT_DISCLAIMER,
  };
}

export const DEFAULT_SCAN_FILTERS = DEFAULT_FILTERS;

export default { quantBacktest, quantScan, quantPortfolio, quantStrategies, QUANT_DISCLAIMER };
