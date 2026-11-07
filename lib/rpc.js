/**
 * Host half of the dsh-stock-surf Web UI: one loopback RPC channel under
 * `/astock` that the panel uses for evaluation, quotes, search and the
 * saved watchlist.
 *
 * The channel carries no credentials and performs no privileged action: it
 * only reads public market data and evaluates it locally, so the page is
 * admitted by the ordinary connection fence.
 *
 * @module dsh-stock-surf/rpc
 */
import { fetchQuotes, searchSymbols, normalizeCode, fetchDailyBars, fetchMinuteBars, INDEX_SECIDS } from './quote.js';
import { evaluateStock, computeIndicators } from './score.js';
import { listStocksByMarket, getListMeta, searchInList } from './stock-list.js';
import {
  fetchCompanyProfile,
  fetchAnnouncements,
  findEastmoneyBoardCode,
  fetchBoardConstituents,
} from './stock-detail.js';
import * as quant from './quant.js';

/** The one channel this plugin serves. */
export const CHANNEL = '/astock';

/** Upper bound on codes accepted in one batch request. */
const MAX_BATCH = 30;

/** A failure the page may show verbatim. */
class AstockError extends Error {
  /**
   * @param {string} message - user-facing Chinese diagnostic.
   */
  constructor(message) {
    super(message);
    this.name = 'AstockError';
  }
}

/** Wrap one endpoint result in the channel's success envelope. */
function ok(value) {
  return { ok: true, value };
}

/** Wrap one failure in the channel's error envelope. */
function failed(message) {
  return { ok: false, error: { code: 'astock/request-failed', message, details: {} } };
}

/** Trim and de-duplicate a code list, preserving order. */
function uniqueCodes(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const normalized = normalizeCode(raw);
    if (normalized === null) continue;
    if (seen.has(normalized.secid)) continue;
    seen.add(normalized.secid);
    out.push(normalized.secid);
  }
  return out;
}

/**
 * Build the RPC handler.
 *
 * @param {object} options - assembled Host dependencies.
 * @param {object} options.config - resolved plugin config.
 * @param {(codes: string[]) => Promise<string[]>} options.readWatchlist - committed list.
 * @param {(codes: string[]) => Promise<string[]>} options.writeWatchlist - commit a new list.
 * @param {(code: string, days?: number, signal?: AbortSignal) => Promise<object>} options.evaluate
 *   the one shared evaluation pipeline, owned by the plugin entry.
 * @param {object} [options.sectors] - the sector feature, or `undefined` when
 *   that module is unavailable. Every sector endpoint answers a clear failure
 *   in that case instead of throwing at mount time.
 * @param {(boardType?: string, signal?: AbortSignal) => Promise<object[]>} [options.sectors.list]
 * @param {(sectors: object[], options?: object) => { items: object[], total: number }} [options.sectors.rank]
 * @returns {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<object>} the handler.
 */
export function createAstockRpc({ config, readWatchlist, writeWatchlist, evaluate, sectors }) {
  /** Re-read the upstream timeout so a config edit applies without a remount. */
  const readTimeout = () => {
    const value = Number(config?.timeoutMs);
    return Number.isFinite(value) && value > 0 ? value : 8000;
  };

  /** Re-read the bar count the same way. */
  const readDays = () => {
    const value = Number(config?.defaultDays);
    return Number.isFinite(value) && value > 0 ? value : 320;
  };

  /** Current headline indices. */
  const readIndices = () => {
    const configured = config?.indices;
    return Array.isArray(configured) && configured.length > 0 ? [...configured] : [...INDEX_SECIDS];
  };

  if (typeof evaluate !== 'function') {
    throw new TypeError('astock: createAstockRpc requires the shared evaluate() pipeline');
  }

  /** Coerce one board type to a supported value. */
  function normalizeBoardType(value) {
    return value === 'hy2' || value === 'gn' ? value : 'hy';
  }

  /** Coerce a page size; 0 means "no limit". */
  function clampLimit(value) {
    const limit = Number(value);
    if (!Number.isFinite(limit)) return 100;
    if (limit <= 0) return 0;
    return Math.min(1000, Math.floor(limit));
  }

  /** 各市场的默认热门标的种子（v3：列表 Tab 的默认内容）。 */
  /** 列表页评分缓存：secid -> { at, score, verdictLabel }，60 秒。 */
  const scoreCache = new Map();

  const MARKET_SEEDS = Object.freeze({
    cn: ['600519', '000001', '300750', '601318', '600036'],
    hk: ['hk00700', 'hk09988', 'hk03690', 'hk00941', 'hk01299'],
    us: ['usAAPL', 'usMSFT', 'usNVDA', 'usTSLA', 'usBABA'],
  });

  /** 拉取一只标的的日 K（列表页评分用，失败返回空数组）。 */
  function fetchBarsFor(quote, timeoutMs, signal) {
    return fetchDailyBars(quote.secid, { limit: 320, timeoutMs, signal }).catch(() => []);
  }

  /**
   * 按字段排序列表行。null 恒沉底（与 order 无关），保证空值不冒充极值。
   *
   * @param {object[]} rows
   * @param {string} sortBy
   * @param {'asc'|'desc'} order
   * @returns {object[]} 新数组，不改入参
   */
  function sortRows(rows, sortBy, order) {
    const dir = order === 'asc' ? 1 : -1;
    const field = ['code', 'name', 'price', 'changePercent', 'volume', 'amount', 'turnoverRate', 'totalCap'].includes(sortBy)
      ? sortBy
      : 'changePercent';
    const copy = rows.slice();
    copy.sort((a, b) => {
      if (field === 'name' || field === 'code') {
        const av = String(a[field] ?? '');
        const bv = String(b[field] ?? '');
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return av.localeCompare(bv, 'zh-Hans-CN') * dir;
      }
      const av = a[field];
      const bv = b[field];
      const an = typeof av === 'number' && Number.isFinite(av);
      const bn = typeof bv === 'number' && Number.isFinite(bv);
      if (!an && !bn) return 0;
      if (!an) return 1;
      if (!bn) return -1;
      return (av - bv) * dir;
    });
    return copy;
  }

  /**
   * 给一页列表行补评分（并发受限）。
   *
   * 列表页的「评分」列必须是真的多因子评分，否则用户看到一列 `—` 毫无意义。
   * 评分失败的行保留原样（score=null），不阻塞整页。
   *
   * @param {object[]} rows
   * @param {number} timeoutMs
   * @param {AbortSignal} [signal]
   * @returns {Promise<object[]>}
   */
  async function scorePage(rows, timeoutMs, signal) {
    const CONCURRENCY = 10;
    const SCORE_TTL_MS = 60000;
    const now = Date.now();
    const out = new Array(rows.length);
    const pending = [];
    for (let i = 0; i < rows.length; i += 1) {
      const cached = scoreCache.get(rows[i].secid);
      if (cached !== undefined && now - cached.at < SCORE_TTL_MS) {
        out[i] = { ...rows[i], score: cached.score, verdictLabel: cached.verdictLabel };
      } else {
        pending.push(i);
      }
    }
    for (let start = 0; start < pending.length; start += CONCURRENCY) {
      const idxs = pending.slice(start, start + CONCURRENCY);
      const settled = await Promise.all(idxs.map(async (i) => {
        const row = rows[i];
        try {
          if (row.isSuspended === true) return { ...row, score: null, verdictLabel: null };
          const bars = await fetchDailyBars(row.secid, { limit: 320, timeoutMs, signal });
          if (!Array.isArray(bars) || bars.length === 0) return { ...row, score: null, verdictLabel: null };
          const ev = evaluateStock({ quote: row, bars });
          scoreCache.set(row.secid, { at: Date.now(), score: ev.score, verdictLabel: ev.verdictLabel });
          return { ...row, score: ev.score, verdictLabel: ev.verdictLabel };
        } catch {
          return { ...row, score: null, verdictLabel: null };
        }
      }));
      for (let k = 0; k < idxs.length; k += 1) out[idxs[k]] = settled[k];
    }
    // 清理过期项，避免缓存无界增长
    if (scoreCache.size > 2000) {
      for (const [key, value] of scoreCache) {
        if (Date.now() - value.at > SCORE_TTL_MS) scoreCache.delete(key);
      }
    }
    return out;
  }

  /** 近 5 日涨跌幅（列表页展示）。 */
  function bars5d(bars) {
    if (!Array.isArray(bars) || bars.length < 6) return null;
    const last = bars.at(-1);
    const base = bars.at(-6);
    if (!last || !base || !(base.close > 0)) return null;
    return Math.round(((last.close - base.close) / base.close) * 10000) / 100;
  }

  /**
   * 时间范围 → 取数方案。
   *
   * 短周期必须走分钟线：日 K 只有 1 根/天，「1 天」范围下日线图毫无信息量。
   * 映射依据是新浪分钟线实测覆盖（每档取 200 根）：
   *   scale=5  → 约 5 个交易日
   *   scale=15 → 约 13 个交易日
   *   scale=30 → 约 1 个月
   *   scale=60 → 约 2.5 个月
   *
   * 港股美股没有分钟线源，一律回落到日线。
   *
   * @param {string} range - '1d'|'7d'|'30d'|'60d'|'120d'|'250d'
   * @param {string} market
   * @returns {{ kind: 'minute'|'day', scale?: number, limit: number, range: string, label: string }}
   */
  function resolveKlineRange(range, market) {
    const cn = market === 'sh' || market === 'sz' || market === 'bj';
    const key = typeof range === 'string' ? range.trim().toLowerCase() : '120d';

    // 分钟级：只有 A 股可用
    if (cn) {
      if (key === '1d') return { kind: 'minute', scale: 5, limit: 48, range: '1d', label: '1 天' };
      if (key === '7d') return { kind: 'minute', scale: 30, limit: 70, range: '7d', label: '7 天' };
      if (key === '30d') return { kind: 'minute', scale: 60, limit: 120, range: '30d', label: '30 天' };
    }

    // 日线
    const dayMap = {
      '1d': { limit: 20, label: '1 天' },
      '7d': { limit: 20, label: '7 天' },
      '30d': { limit: 40, label: '30 天' },
      '60d': { limit: 60, label: '60 天' },
      '120d': { limit: 120, label: '120 天' },
      '250d': { limit: 250, label: '250 天' },
    };
    const picked = dayMap[key] ?? dayMap['120d'];
    return {
      kind: 'day',
      limit: Math.max(20, Math.min(500, picked.limit)),
      range: dayMap[key] ? key : '120d',
      label: picked.label,
    };
  }


  /**
   * 简单移动平均，前置不足期为 null（图表上留空而不是画 0）。
   *
   * @param {number[]} values
   * @param {number} period
   * @returns {Array<number|null>}
   */
  function movingAverage(values, period) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      out.push(i >= period - 1 ? Math.round((sum / period) * 1000) / 1000 : null);
    }
    return out;
  }

  /**
   * 把 K 线与技术指标翻译成中文解读。
   *
   * 设计原则：只陈述「数据说了什么」，不做涨跌预测；每条都带具体数值，
   * 让用户能自己复核，而不是给一个无法验证的结论。
   *
   * @param {{ evaluation: object, indicators: object, bars: object[] }} input
   * @returns {{ headline: string, paragraphs: string[], signals: string[], cautions: string[] }}
   */
  function buildReading({ evaluation, indicators, bars }) {
    const ind = indicators ?? {};
    const paragraphs = [];
    const signals = [];
    const cautions = [];
    const last = bars[bars.length - 1];
    const first = bars[0];

    // 1) 区间表现
    const spanReturn = first && last && first.close > 0
      ? ((last.close - first.close) / first.close) * 100
      : null;
    if (spanReturn !== null) {
      paragraphs.push(
        `最近 ${bars.length} 个交易日，收盘价从 ${first.close.toFixed(2)} 变到 ${last.close.toFixed(2)}，`
        + `区间${spanReturn >= 0 ? '上涨' : '下跌'} ${Math.abs(spanReturn).toFixed(2)}%。`,
      );
    }

    // 2) 均线结构
    const ma = ind.ma ?? {};
    const { ma5, ma10, ma20, ma60 } = ma;
    if (ma5 !== null && ma5 !== undefined && ma20 !== null && ma20 !== undefined) {
      const bull = ma5 > ma10 && ma10 > ma20 && (ma60 == null || ma20 > ma60);
      const bear = ma5 < ma10 && ma10 < ma20 && (ma60 == null || ma20 < ma60);
      if (bull) signals.push('均线呈多头排列（MA5 > MA10 > MA20），短中期趋势一致向上');
      else if (bear) signals.push('均线呈空头排列（MA5 < MA10 < MA20），短中期趋势一致向下');
      else signals.push('均线相互缠绕，趋势方向尚未确立');
    }
    if (last && ma20 !== null && ma20 !== undefined) {
      const gap = ((last.close - ma20) / ma20) * 100;
      paragraphs.push(
        `现价 ${last.close.toFixed(2)} ${gap >= 0 ? '高于' : '低于'} MA20（${ma20.toFixed(2)}）`
        + `${Math.abs(gap).toFixed(2)}%，${Math.abs(gap) > 10 ? '偏离较大，存在向均线回归的压力' : '偏离处于常态区间'}。`,
      );
    }

    // 3) RSI
    if (ind.rsi14 !== null && ind.rsi14 !== undefined) {
      const rsi = ind.rsi14;
      const zone = rsi >= 70 ? '超买区' : rsi <= 30 ? '超卖区' : rsi >= 50 ? '强势区' : '弱势区';
      signals.push(`RSI14 = ${rsi.toFixed(1)}，位于${zone}`);
      if (rsi >= 75) cautions.push(`RSI ${rsi.toFixed(1)} 已进入超买区，短线回调风险上升`);
      if (rsi <= 25) cautions.push(`RSI ${rsi.toFixed(1)} 已进入超卖区，跌势可能加速`);
    }

    // 4) MACD
    const macd = ind.macd ?? {};
    if (macd.dif !== null && macd.dif !== undefined && macd.dea !== null && macd.dea !== undefined) {
      const above = macd.dif > macd.dea;
      const zeroUp = macd.dif >= 0;
      signals.push(
        `MACD 的 DIF ${above ? '在 DEA 之上' : '跌破 DEA'}，`
        + `且位于零轴${zeroUp ? '上方（强势格局）' : '下方（弱势格局）'}`,
      );
      const prev = ind.macdPrevHist;
      const hist = macd.hist;
      if (prev !== null && prev !== undefined && hist !== null && hist !== undefined) {
        if (hist > 0 && hist < prev) cautions.push('MACD 红柱缩短，上涨动能衰减');
        if (hist < 0 && hist < prev) cautions.push('MACD 绿柱放大，下跌动能增强');
      }
    }

    // 5) 波动与位置
    if (ind.atrPercent !== null && ind.atrPercent !== undefined) {
      const atr = ind.atrPercent;
      signals.push(`ATR 占现价 ${atr.toFixed(2)}%，波动${atr > 5 ? '偏高' : atr < 1.5 ? '偏低' : '正常'}`);
    }
    if (ind.high60 != null && ind.low60 != null && last && ind.high60 > ind.low60) {
      const pos = ((last.close - ind.low60) / (ind.high60 - ind.low60)) * 100;
      paragraphs.push(
        `当前价位于 60 日区间（${ind.low60.toFixed(2)} – ${ind.high60.toFixed(2)}）的 ${pos.toFixed(0)}% 分位。`,
      );
      if (pos >= 90) cautions.push('价格接近 60 日高点，追高需谨慎');
      if (pos <= 10) cautions.push('价格接近 60 日低点，注意支撑是否有效');
    }

    // 6) 量能
    if (ind.volumeMa5 != null && ind.volumeMa20 != null && ind.volumeMa20 > 0) {
      const vr = ind.volumeMa5 / ind.volumeMa20;
      signals.push(
        `5 日均量为 20 日均量的 ${vr.toFixed(2)} 倍，`
        + `${vr > 1.3 ? '量能放大' : vr < 0.8 ? '量能萎缩' : '量能平稳'}`,
      );
    }

    // 7) 连续涨跌
    if (ind.consecutiveUp >= 4) cautions.push(`已连续上涨 ${ind.consecutiveUp} 天，短线获利盘累积`);
    if (ind.consecutiveDown >= 5) cautions.push(`已连续下跌 ${ind.consecutiveDown} 天，弱势尚未扭转`);

    const headline = `${evaluation.name ?? evaluation.code}：`
      + `${evaluation.verdictLabel}（综合 ${evaluation.score} 分）`
      + (spanReturn !== null ? `，区间${spanReturn >= 0 ? '涨' : '跌'} ${Math.abs(spanReturn).toFixed(2)}%` : '');

    return { headline, paragraphs, signals, cautions };
  }

  /** Resolve the sector feature or fail with one readable message. */
  function requireSectors() {
    const feature = sectors;
    if (feature === undefined || feature === null
      || typeof feature.list !== 'function' || typeof feature.rank !== 'function') {
      throw new AstockError('astock: 板块模块未加载，无法处理板块请求');
    }
    return feature;
  }

  const endpoints = {
    /** Full evaluation for one code. */
    evaluate: (payload, signal) => evaluate(payload?.code, payload?.days ?? readDays(), signal),

    /** Evaluate several codes; per-code failures are collected, not thrown. */
    batch: async (payload, signal) => {
      const codes = uniqueCodes(payload?.codes).slice(0, MAX_BATCH);
      if (codes.length === 0) throw new AstockError('astock: 请提供至少一个有效的股票代码');
      const items = [];
      const errors = [];
      for (const code of codes) {
        if (signal?.aborted) throw new AstockError('astock: 请求已取消');
        try {
          items.push(await evaluate(code, payload?.days ?? readDays(), signal));
        } catch (error) {
          errors.push({ code, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return { items, errors };
    },

    /** Raw realtime snapshots, for header strips and the watchlist rows. */
    quote: async (payload, signal) => {
      const codes = uniqueCodes(payload?.codes).slice(0, MAX_BATCH);
      if (codes.length === 0) return { quotes: [] };
      const quotes = await fetchQuotes(codes, { timeoutMs: readTimeout(), signal });
      return { quotes };
    },

    /** Symbol lookup by code or Chinese name. */
    search: async (payload, signal) => {
      const keyword = typeof payload?.keyword === 'string' ? payload.keyword.trim() : '';
      if (keyword.length === 0) return { results: [] };
      const results = await searchSymbols(keyword, { timeoutMs: readTimeout(), signal });
      return { results };
    },

    /** The saved watchlist. */
    watchlist: async () => ({ codes: await readWatchlist() }),

    /** Replace the saved watchlist. */
    'watchlist/set': async (payload) => {
      const codes = uniqueCodes(payload?.codes).slice(0, MAX_BATCH);
      return { codes: await writeWatchlist(codes) };
    },

    /** The three headline indices. */
    indices: async (_payload, signal) => {
      const quotes = await fetchQuotes(readIndices(), { timeoutMs: readTimeout(), signal });
      return { items: quotes.filter((quote) => quote !== null) };
    },

    /**
     * Ranked sector list with scores.
     *
     * One sector board is 31 (hy), 124 (hy2) or 500 (gn) rows; the board is
     * fetched once, scored locally, then sorted and sliced, so the page can ask
     * for a bounded page without repeating the upstream round-trips.
     */
    sectors: async (payload, signal) => {
      const feature = requireSectors();
      const boardType = normalizeBoardType(payload?.boardType);
      const raw = await feature.list(boardType, signal, { timeoutMs: readTimeout() });
      const ranked = await feature.rank(raw, {
        sortBy: typeof payload?.sortBy === 'string' ? payload.sortBy : 'score',
        order: payload?.order === 'asc' ? 'asc' : 'desc',
      });
      const limit = clampLimit(payload?.limit);
      const offset = Math.max(0, Math.floor(Number(payload?.offset) || 0));
      return {
        boardType,
        total: ranked.total,
        offset,
        items: limit === 0 ? ranked.items.slice(offset) : ranked.items.slice(offset, offset + limit),
      };
    },

    /** Board types this build can serve, with their row counts when known. */
    'sectors/boards': async () => ({
      boards: [
        { boardType: 'hy', label: '一级行业' },
        { boardType: 'hy2', label: '二级行业' },
        { boardType: 'gn', label: '概念板块' },
      ],
    }),

    /** One sector, scored, by code or name. */
    'sectors/one': async (payload, signal) => {
      const feature = requireSectors();
      const code = typeof payload?.code === 'string' ? payload.code.trim() : '';
      if (code.length === 0) throw new AstockError('astock: 请提供板块代码或名称');
      const boardType = normalizeBoardType(payload?.boardType);
      const raw = await feature.list(boardType, signal, { timeoutMs: readTimeout() });
      const ranked = await feature.rank(raw, { sortBy: 'score', order: 'desc' });
      const wanted = code.toLowerCase();
      const hit = ranked.items.find((item) => String(item.code ?? '').toLowerCase() === wanted
        || String(item.code ?? '').toLowerCase() === `pt${wanted}`
        || String(item.name ?? '') === code);
      if (hit === undefined) throw new AstockError(`astock: 没有找到板块「${code}」（当前范围：${boardType}）`);
      return hit;
    },

    /**
     * 全市场股票列表（v4）。
     *
     * A 股走新浪 getHQNodeData 全量（实测 5578 只，6 路并发约 1.6 秒，缓存 60 秒）；
     * 港股该源只给 60 只；美股无免费全量，只给种子。
     * 排序、搜索、分页都在 Host 侧完成，客户端只拿当前页，避免把 5578 行塞给浏览器。
     */
    stocks: async (payload, signal) => {
      const market = ['cn', 'hk', 'us'].includes(payload?.market) ? payload.market : 'cn';
      const timeout = readTimeout();
      const { rows, meta } = await listStocksByMarket(market, { timeoutMs: timeout, signal });

      const keyword = typeof payload?.keyword === 'string' ? payload.keyword.trim() : '';
      const filtered = keyword ? searchInList(rows, keyword, rows.length) : rows;

      const sortBy = typeof payload?.sortBy === 'string' ? payload.sortBy : 'changePercent';
      const order = payload?.order === 'asc' ? 'asc' : 'desc';
      const sorted = sortRows(filtered, sortBy, order);

      const total = sorted.length;
      const limit = clampLimit(payload?.limit) || 100;
      const offset = Math.max(0, Math.floor(Number(payload?.offset) || 0));
      const page = sorted.slice(offset, offset + limit);

      // 只给当前页算评分：实测 20 只 10 路并发约 370ms，整页 100 只约 2s，
      // 可接受；给 5578 只全算则要几分钟，没有意义。
      const scored = payload?.withScore === false
        ? page
        : await scorePage(page, timeout, signal);

      return { market, meta, total, offset, limit, items: scored };
    },

    /** 各市场规模与完整性说明（界面提示用）。 */
    'stocks/meta': async (_payload, signal) => {
      const metas = await getListMeta({ timeoutMs: readTimeout(), signal });
      return { metas };
    },

    /**
     * 日 K 线数据（供图表渲染）。
     *
     * 返回精简后的 OHLCV 数组 + 均线序列，前端直接画蜡烛图即可，
     * 不需要在浏览器里再算一遍 MA。
     */
    kline: async (payload, signal) => {
      const raw = typeof payload?.code === 'string' ? payload.code.trim() : '';
      const normalized = normalizeCode(raw);
      if (normalized === null) throw new AstockError(`astock: 无法识别的股票代码「${raw}」`);

      const plan = resolveKlineRange(payload?.range, normalized.market);
      const timeout = readTimeout();

      let bars;
      let granularity;
      if (plan.kind === 'minute') {
        bars = await fetchMinuteBars(normalized.secid, {
          scale: plan.scale,
          limit: plan.limit,
          timeoutMs: timeout,
          signal,
        });
        granularity = `${plan.scale}min`;
      } else {
        bars = await fetchDailyBars(normalized.secid, {
          limit: plan.limit,
          timeoutMs: timeout,
          signal,
        });
        granularity = 'day';
      }

      if (!Array.isArray(bars) || bars.length === 0) {
        throw new AstockError(`astock: 取不到 ${normalized.secid} 的 K 线数据（${plan.label}）`);
      }

      // 分钟线可能超过请求条数（新浪按 datalen 返回，但保险起见截断）
      if (bars.length > plan.limit) bars = bars.slice(bars.length - plan.limit);

      // 均线：短周期用 5/10/20，长周期补 60
      const periods = plan.kind === 'minute' ? [5, 10, 20] : [5, 10, 20, 60];
      const closes = bars.map((b) => b.close);
      const ma = {};
      for (const period of periods) ma[period] = movingAverage(closes, period);

      return {
        secid: normalized.secid,
        market: normalized.market,
        currency: normalized.currency ?? null,
        range: plan.range,
        granularity,
        label: plan.label,
        count: bars.length,
        // 兼容旧字段名
        days: bars.length,
        bars: bars.map((b) => ({
          // 分钟线用完整时间，日线只有日期
          time: b.time ?? b.date,
          date: b.date,
          open: b.open,
          close: b.close,
          high: b.high,
          low: b.low,
          volume: b.volume,
        })),
        ma,
      };
    },

    /**
     * 一键解读：把 K 线形态与技术指标翻译成中文结论。
     *
     * 与「一键分析」的区别：analyze 偏向综合面（技术面 + 公司 + 公告），
     * interpret 聚焦在「最近这段走势说明了什么」，输出更适合直接读的段落。
     */
    interpret: async (payload, signal) => {
      const raw = typeof payload?.code === 'string' ? payload.code.trim() : '';
      const normalized = normalizeCode(raw);
      if (normalized === null) throw new AstockError(`astock: 无法识别的股票代码「${raw}」`);

      const timeout = readTimeout();
      const [quoteList, bars] = await Promise.all([
        fetchQuotes([normalized.secid], { timeoutMs: timeout, signal }).catch(() => []),
        fetchDailyBars(normalized.secid, { limit: payload?.days ?? readDays(), timeoutMs: timeout, signal })
          .catch(() => []),
      ]);
      const quote = Array.isArray(quoteList) ? quoteList[0] : null;
      if (bars.length === 0) {
        throw new AstockError(`astock: 取不到 ${normalized.secid} 的 K 线，无法解读`);
      }

      const evaluation = evaluateStock({ quote, bars });
      const indicators = computeIndicators(bars);
      return {
        secid: normalized.secid,
        market: normalized.market,
        name: evaluation.name,
        evaluation,
        indicators,
        reading: buildReading({ evaluation, indicators, bars }),
        generatedAt: new Date().toISOString(),
      };
    },

    /**
     * 个股详情增强：公司业务介绍 + 最新公告。
     *
     * 两者互相独立，任一失败都不影响另一个（港美股没有 F10，只返回公告）。
     * 同时返回 profile/announcements 的可用性标记，让界面决定是否显示区块。
     */
    detail: async (payload, signal) => {
      const raw = typeof payload?.code === 'string' ? payload.code.trim() : '';
      const normalized = normalizeCode(raw);
      if (normalized === null) throw new AstockError(`astock: 无法识别的股票代码「${raw}」`);
      const timeout = readTimeout();
      const [profile, announcements] = await Promise.all([
        fetchCompanyProfile(normalized.secid, { timeoutMs: timeout, signal }).catch(() => null),
        fetchAnnouncements(normalized.secid, { limit: 8, timeoutMs: timeout, signal }).catch(() => []),
      ]);
      return {
        secid: normalized.secid,
        market: normalized.market,
        profile,
        announcements,
        // 港美股没有 F10 数据，界面据此隐藏「公司业务」区块
        hasProfile: profile !== null,
      };
    },

    /**
     * 一键分析：把技术面评分 + 公司资料 + 最新公告合成一份完整报告。
     *
     * 这是界面「一键分析」按钮背后的唯一端点：一次请求拿齐所有区块，
     * 避免客户端串行发 3 个请求（detail / evaluate / quote）造成长时间空白。
     * 任一子项失败都不阻塞其它子项，失败原因写进 warnings。
     */
    analyze: async (payload, signal) => {
      const raw = typeof payload?.code === 'string' ? payload.code.trim() : '';
      const normalized = normalizeCode(raw);
      if (normalized === null) throw new AstockError(`astock: 无法识别的股票代码「${raw}」`);

      const timeout = readTimeout();
      const warnings = [];

      const [evaluation, profile, announcements] = await Promise.all([
        evaluate(normalized.secid, payload?.days ?? readDays(), signal)
          .catch((error) => {
            warnings.push(`技术面评分失败：${error instanceof Error ? error.message : String(error)}`);
            return null;
          }),
        fetchCompanyProfile(normalized.secid, { timeoutMs: timeout, signal })
          .catch((error) => {
            warnings.push(`公司资料失败：${error instanceof Error ? error.message : String(error)}`);
            return null;
          }),
        fetchAnnouncements(normalized.secid, { limit: 8, timeoutMs: timeout, signal })
          .catch((error) => {
            warnings.push(`公告失败：${error instanceof Error ? error.message : String(error)}`);
            return [];
          }),
      ]);

      if (evaluation === null && profile === null && announcements.length === 0) {
        throw new AstockError(`astock: 取不到 ${normalized.secid} 的任何数据`);
      }

      return {
        secid: normalized.secid,
        market: normalized.market,
        evaluation,
        profile,
        announcements,
        hasProfile: profile !== null,
        warnings,
        generatedAt: new Date().toISOString(),
      };
    },

    /**
     * 板块成分股列表。
     *
     * 腾讯板块代码（pt01801120）与东财板块码（896）不通用，因此先用板块名
     * 反查东财码，再拉成分股；拉到的成分股补实时快照与评分。
     */
    'sectors/constituents': async (payload, signal) => {
      const boardName = typeof payload?.name === 'string' ? payload.name.trim() : '';
      const explicitCode = typeof payload?.boardCode === 'string' ? payload.boardCode.trim() : '';
      if (!boardName && !explicitCode) throw new AstockError('astock: 请提供板块名称或东财板块码');

      const timeout = readTimeout();
      const boardCode = /^[0-9]{1,6}$/.test(explicitCode)
        ? explicitCode
        : await findEastmoneyBoardCode(boardName, { timeoutMs: timeout, signal });
      if (boardCode === null || boardCode === undefined) {
        throw new AstockError(`astock: 找不到板块「${boardName}」的成分股数据`);
      }

      const members = await fetchBoardConstituents(boardCode, { timeoutMs: timeout, signal });
      if (members.length === 0) {
        throw new AstockError(`astock: 板块「${boardName || boardCode}」没有成分股数据`);
      }

      // 批量补快照（一次请求拿全部），再给前 N 只算评分
      const secids = members.map((m) => m.secid).filter((v) => typeof v === 'string');
      const quotes = secids.length > 0
        ? await fetchQuotes(secids, { timeoutMs: timeout, signal }).catch(() => [])
        : [];
      const quoteMap = new Map();
      for (const q of quotes) {
        if (q !== null && q !== undefined) quoteMap.set(q.secid, q);
      }

      const rows = members.map((m) => {
        const q = m.secid ? quoteMap.get(m.secid) : undefined;
        return {
          secid: m.secid,
          code: m.code,
          name: m.name,
          market: m.secid ? m.secid.slice(0, 2) : null,
          price: q ? q.price : null,
          changePercent: q ? q.changePercent : null,
          score: null,
          verdictLabel: null,
        };
      });

      // 只给当前页算评分（与列表页一致：100 只约 2-3 秒）
      const withScore = payload?.withScore === false ? rows : await scorePage(rows, timeout, signal);

      return {
        boardCode,
        boardName: boardName || null,
        total: withScore.length,
        items: withScore,
      };
    },

    /**
     * 多市场热门标的（保留旧端点，用于列表页顶部「热门」快速入口）。
     */
    markets: async (payload, signal) => {
      const market = ['hk', 'us', 'cn'].includes(payload?.market) ? payload.market : 'cn';
      const codes = MARKET_SEEDS[market] ?? [];
      const timeout = readTimeout();
      const quotes = await fetchQuotes(codes, { timeoutMs: timeout, signal });
      const items = [];
      for (let i = 0; i < codes.length; i += 1) {
        const quote = quotes[i];
        if (!quote) {
          items.push({ code: codes[i], name: null, price: null, changePercent: null, score: null, verdictLabel: null, market });
          continue;
        }
        let score = null;
        let verdictLabel = null;
        try {
          const bars = await fetchBarsFor(quote, timeout, signal);
          const ev = evaluateStock({ quote, bars });
          score = ev.score;
          verdictLabel = ev.verdictLabel;
        } catch {
          // 评分失败不阻塞列表：只显示行情
        }
        items.push({
          code: quote.code,
          secid: quote.secid,
          market: quote.market,
          name: quote.name,
          currency: quote.currency ?? null,
          price: quote.price,
          changePercent: quote.changePercent,
          score,
          verdictLabel,
          inWatchlist: false,
        });
      }
      return { market, items };
    },

    /* ── 量化（v5）──────────────────────────────────────────────── */

    /**
     * 单股策略回测。
     *
     * payload: { code, strategy?, days?, warmup?, thresholdBuy?, thresholdSell?, feeRate? }
     */
    'quant/backtest': async (payload, signal) => quant.quantBacktest({ ...(payload ?? {}), signal }),

    /**
     * 全市场选股扫描。
     *
     * payload: { market?, limit?, shortlist?, filters?, days? }
     * 首次调用要拉全市场列表（约 3-5 秒），之后命中缓存（收盘后 30 分钟）。
     */
    'quant/scan': async (payload, signal) => quant.quantScan({ ...(payload ?? {}), signal }),

    /**
     * 自选股组合回测。
     *
     * payload: { codes?, strategy?, days? }；不传 codes 时用自选股列表。
     */
    'quant/portfolio': async (payload, signal) => {
      const raw = payload ?? {};
      let codes = Array.isArray(raw.codes) ? raw.codes : null;
      if (codes === null) {
        // 没显式传就用自选股，这是用户最常走的路径
        codes = await readWatchlist();
        if (!Array.isArray(codes) || codes.length === 0) {
          return {
            ok: false,
            items: [],
            equity: [],
            stats: null,
            warnings: ['自选股列表为空，请先添加股票再回测组合'],
            disclaimer: quant.QUANT_DISCLAIMER,
          };
        }
      }
      return quant.quantPortfolio({ ...raw, codes, signal });
    },

    /** 可用策略清单。 */
    'quant/strategies': async () => quant.quantStrategies(),

    /** 默认选股筛选条件（前端用来渲染表单初值）。 */
    'quant/filters': async () => ({ filters: quant.DEFAULT_SCAN_FILTERS }),
  };

  return async (endpoint, payload, signal) => {
    const name = typeof endpoint === 'string' ? endpoint : '';
    if (!Object.hasOwn(endpoints, name)) return failed('astock: 未知的接口');
    try {
      const value = await endpoints[name](payload ?? {}, signal);
      return ok(value);
    } catch (error) {
      if (signal?.aborted) return failed('astock: 请求已取消');
      const message = error instanceof Error ? error.message : String(error);
      return failed(message.startsWith('astock:') ? message : `astock: ${message}`);
    }
  };
}
