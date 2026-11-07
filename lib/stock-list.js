/**
 * dsh-astock 全市场股票列表数据层。
 *
 * 纯 Host Node（Node 18，ESM，零 npm 依赖），只用全局 fetch。
 *
 * 数据源（均已实测，见 CONTRACT.md「v4 追加：全市场列表」）：
 *
 *   1. A 股全量  新浪 Market_Center.getHQNodeData  node=hs_a
 *      每页上限 100 条，实测 56 页共 5578 只，6 路并发约 1.6 秒。
 *      返回 JSON 数组，字段全部是字符串或数字混排，需稳健转数字。
 *   2. 港股      新浪 Market_Center.getHKStockData  node=qbgg_hk
 *      实测只有 60 条（免费源只覆盖该 node 下的标的主板集合），
 *      这是数据源上限，不是分页问题（num=1000 仍只返回 60）。
 *   3. 美股      **没有免费全量列表**，本模块只提供种子 + 搜索补充。
 *
 * 冻结主 API：listStocks / listStocksByMarket / searchInList / getListMeta。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const SINA_HQ =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
const SINA_HK =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHKStockData';

const DEFAULT_TIMEOUT_MS = 12000;

/** A 股列表缓存：全量拉一次 1.6 秒，缓存 60 秒足够列表页翻页/排序复用。 */
const LIST_CACHE_TTL_MS = 60000;

/** 新浪单页硬上限 100（实测 num=200/500 都只回 100）。 */
const PAGE_SIZE = 100;

/** A 股总页数上限保护：5578/100 ≈ 56 页，留足余量防服务端异常时死循环。 */
const MAX_PAGES = 80;

/** 并发页数：实测 6 路并发 56 页约 1.6 秒，再高容易被限流。 */
const CONCURRENCY = 6;

/** 美股没有全量列表，只能给种子；真正的补充靠搜索。 */
const US_SEEDS = Object.freeze([
  'usAAPL', 'usMSFT', 'usNVDA', 'usGOOGL', 'usAMZN', 'usMETA', 'usTSLA', 'usAVGO',
  'usBRK.B', 'usJPM', 'usV', 'usUNH', 'usXOM', 'usLLY', 'usJNJ', 'usWMT',
  'usMA', 'usPG', 'usHD', 'usCOST', 'usORCL', 'usAMD', 'usNFLX', 'usCRM',
  'usADBE', 'usINTC', 'usQCOM', 'usTXN', 'usBABA', 'usPDD', 'usJD', 'usNIO',
]);

/** 缓存：market -> { at, rows, meta } */
const cache = new Map();

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 稳健转数字：空串、'-'、null、非法值一律 null，绝不 NaN。 */
export function toNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s === '-' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 带超时的 JSON 请求。 */
async function httpGetJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; dsh-astock/0.1; +https://github.com/OWNER/dsh-astock) AppleWebKit/537.36 (KHTML, like Gecko)',
        Accept: 'application/json, text/javascript, */*',
        Referer: 'https://finance.sina.com.cn/',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`astock: 列表接口返回 HTTP ${response.status}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('astock: 列表接口返回的不是合法 JSON');
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`astock: 列表请求超时或被取消（${timeoutMs}ms）`);
    }
    if (error && typeof error.message === 'string' && error.message.startsWith('astock:')) throw error;
    throw new Error(`astock: 列表请求失败：${error && error.message ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 市场标签。 */
const MARKET_LABELS = Object.freeze({
  sh: '沪A', sz: '深A', bj: '北交所', hk: '港股', us: '美股',
});

/** 从新浪 symbol（sh600000 / bj920000 / 00001）推断市场。 */
function marketOfSymbol(symbol) {
  const s = String(symbol || '').toLowerCase();
  if (s.startsWith('sh')) return 'sh';
  if (s.startsWith('sz')) return 'sz';
  if (s.startsWith('bj')) return 'bj';
  return null;
}

/**
 * 解析 A 股一行（新浪 getHQNodeData）。
 *
 * 字段（实测 20 个）：
 *   symbol sh600000 / code 600000 / name / trade 现价 / pricechange 涨跌额
 *   changepercent 涨跌幅% / buy / sell / settlement 昨收 / open / high / low
 *   volume 成交量(股) / amount 成交额(元) / ticktime / per 市盈率 / pb 市净率
 *   mktcap 总市值(万元) / nmc 流通市值(万元) / turnoverratio 换手率%
 *
 * @param {object} row
 * @returns {object|null} 统一的列表行
 */
export function parseCnRow(row) {
  if (!row || typeof row !== 'object') return null;
  const symbol = typeof row.symbol === 'string' ? row.symbol.trim().toLowerCase() : '';
  const market = marketOfSymbol(symbol);
  const code = typeof row.code === 'string' ? row.code.trim() : (symbol ? symbol.slice(2) : '');
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!code || !name) return null;
  const price = toNumber(row.trade);
  const volume = toNumber(row.volume);
  return {
    secid: symbol || `${market ?? ''}${code}`,
    code,
    market: market ?? 'sh',
    marketLabel: MARKET_LABELS[market ?? 'sh'] ?? '沪A',
    currency: 'CNY',
    name,
    price,
    prevClose: toNumber(row.settlement),
    open: toNumber(row.open),
    high: toNumber(row.high),
    low: toNumber(row.low),
    change: toNumber(row.pricechange),
    changePercent: toNumber(row.changepercent),
    volume,
    amount: toNumber(row.amount),
    // 新浪市值单位是万元，统一换算成亿元与其它模块保持一致
    totalCap: (() => { const v = toNumber(row.mktcap); return v === null ? null : v / 10000; })(),
    floatCap: (() => { const v = toNumber(row.nmc); return v === null ? null : v / 10000; })(),
    turnoverRate: toNumber(row.turnoverratio),
    peTtm: toNumber(row.per),
    pb: toNumber(row.pb),
    isSuspended: price === null || price === 0 || volume === 0,
  };
}

/**
 * 解析港股一行（新浪 getHKStockData）。
 *
 * 字段（实测 24 个）：symbol 00001 / name / engname / lasttrade 现价 /
 *   prevclose / open / high / low / volume / amount / changepercent /
 *   pricechange / market_value / pe_ratio / stocks_sum 等
 *
 * @param {object} row
 * @returns {object|null}
 */
export function parseHkRow(row) {
  if (!row || typeof row !== 'object') return null;
  const raw = typeof row.symbol === 'string' ? row.symbol.trim() : '';
  if (!raw) return null;
  // 港股代码统一补成 5 位，与 quote.js 的 hk00700 规则一致
  const code = raw.replace(/^hk/i, '').padStart(5, '0');
  const name = typeof row.name === 'string' && row.name.trim().length > 0
    ? row.name.trim()
    : (typeof row.engname === 'string' ? row.engname.trim() : '');
  if (!name) return null;
  const price = toNumber(row.lasttrade);
  const volume = toNumber(row.volume);
  return {
    secid: `hk${code}`,
    code,
    market: 'hk',
    marketLabel: MARKET_LABELS.hk,
    currency: 'HKD',
    name,
    price,
    prevClose: toNumber(row.prevclose),
    open: toNumber(row.open),
    high: toNumber(row.high),
    low: toNumber(row.low),
    change: toNumber(row.pricechange),
    changePercent: toNumber(row.changepercent),
    volume,
    amount: toNumber(row.amount),
    totalCap: toNumber(row.market_value),
    floatCap: null,
    turnoverRate: null,
    peTtm: toNumber(row.pe_ratio),
    pb: null,
    isSuspended: price === null || price === 0,
  };
}

/**
 * 合并多页并去重（按 secid）。
 *
 * @param {Array<object[]>} pages - 每页的原始行数组
 * @param {(row: object) => object|null} mapper - 单行映射
 * @returns {object[]} 去重后的列表
 */
export function mergeListPages(pages, mapper) {
  const seen = new Set();
  const out = [];
  for (const page of pages) {
    if (!Array.isArray(page)) continue;
    for (const row of page) {
      const item = mapper(row);
      if (item === null || item === undefined) continue;
      if (seen.has(item.secid)) continue;
      seen.add(item.secid);
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 拉取
// ---------------------------------------------------------------------------

/** 并发受限地拉取一组页。 */
async function fetchPages(makeUrl, pageCount, options) {
  const pages = [];
  for (let start = 1; start <= pageCount; start += CONCURRENCY) {
    const batch = [];
    for (let page = start; page < start + CONCURRENCY && page <= pageCount; page += 1) {
      batch.push(
        httpGetJson(makeUrl(page), options).catch(() => null),
      );
    }
    const got = await Promise.all(batch);
    let empty = 0;
    for (const page of got) {
      if (Array.isArray(page) && page.length > 0) pages.push(page);
      else empty += 1;
    }
    // 一整批全空说明已经翻到底（或服务端拒绝），停止继续请求
    if (empty === batch.length) break;
  }
  return pages;
}

/**
 * 拉取 A 股全量列表。
 *
 * @param {{ timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} [options]
 * @returns {Promise<{ rows: object[], meta: object }>}
 */
async function fetchCnList(options = {}) {
  const makeUrl = (page) => `${SINA_HQ}?page=${page}&num=${PAGE_SIZE}&sort=symbol&asc=1&node=hs_a`;
  const pages = await fetchPages(makeUrl, MAX_PAGES, options);
  const rows = mergeListPages(pages, parseCnRow);
  return {
    rows,
    meta: {
      market: 'cn',
      label: 'A股',
      currency: 'CNY',
      total: rows.length,
      pages: pages.length,
      complete: true,
      note: null,
    },
  };
}

/**
 * 拉取港股列表。
 *
 * 免费源实测只返回 60 条（num 提到 1000 仍只有 60），这是源上限，
 * 因此在 meta 里如实标注 complete=false，界面据此提示用户。
 *
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ rows: object[], meta: object }>}
 */
async function fetchHkList(options = {}) {
  const url = `${SINA_HK}?page=1&num=${PAGE_SIZE}&sort=symbol&asc=1&node=qbgg_hk`;
  const first = await httpGetJson(url, options);
  const rows = mergeListPages([first], parseHkRow);
  return {
    rows,
    meta: {
      market: 'hk',
      label: '港股',
      currency: 'HKD',
      total: rows.length,
      pages: 1,
      complete: false,
      note: '免费数据源只提供该节点下的 60 只标的，非港股全量。',
    },
  };
}

/**
 * 拉取美股列表（种子）。
 *
 * 没有免费全量列表，这里只返回种子代码，价格由调用方批量查快照补齐。
 *
 * @returns {Promise<{ rows: object[], meta: object }>}
 */
async function fetchUsList() {
  const rows = US_SEEDS.map((secid) => {
    const code = secid.slice(2);
    return {
      secid,
      code,
      market: 'us',
      marketLabel: MARKET_LABELS.us,
      currency: 'USD',
      name: code,
      price: null,
      prevClose: null,
      open: null,
      high: null,
      low: null,
      change: null,
      changePercent: null,
      volume: null,
      amount: null,
      totalCap: null,
      floatCap: null,
      turnoverRate: null,
      peTtm: null,
      pb: null,
      isSuspended: false,
    };
  });
  return {
    rows,
    meta: {
      market: 'us',
      label: '美股',
      currency: 'USD',
      total: rows.length,
      pages: 0,
      complete: false,
      note: '免费数据源不提供美股全量列表，这里只列出常用标的；可用搜索查找其它美股。',
    },
  };
}

/**
 * 拉取某一市场的全部列表（带缓存）。
 *
 * @param {'cn'|'hk'|'us'} market
 * @param {{ timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} [options]
 * @returns {Promise<{ market: string, rows: object[], meta: object }>}
 */
export async function listStocksByMarket(market, options = {}) {
  const key = market === 'hk' || market === 'us' ? market : 'cn';
  const opts = options && typeof options === 'object' ? options : {};

  if (opts.noCache !== true) {
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < LIST_CACHE_TTL_MS) {
      return { market: key, rows: hit.rows, meta: hit.meta };
    }
  }

  let result;
  if (key === 'hk') result = await fetchHkList(opts);
  else if (key === 'us') result = await fetchUsList(opts);
  else result = await fetchCnList(opts);

  cache.set(key, { at: Date.now(), rows: result.rows, meta: result.meta });
  return { market: key, rows: result.rows, meta: result.meta };
}

/**
 * 列表接口的元信息（各市场规模与完整性），用于界面提示。
 *
 * @returns {Promise<Array<object>>}
 */
export async function getListMeta(options = {}) {
  const out = [];
  for (const market of ['cn', 'hk', 'us']) {
    try {
      const { meta } = await listStocksByMarket(market, options);
      out.push(meta);
    } catch (error) {
      out.push({
        market,
        label: market === 'cn' ? 'A股' : market === 'hk' ? '港股' : '美股',
        total: 0,
        complete: false,
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

/**
 * 在已拉取的列表里做关键词过滤（代码或名称，大小写不敏感）。
 *
 * @param {object[]} rows
 * @param {string} keyword
 * @param {number} [limit]
 * @returns {object[]}
 */
export function searchInList(rows, keyword, limit = 50) {
  const list = Array.isArray(rows) ? rows : [];
  const kw = typeof keyword === 'string' ? keyword.trim().toLowerCase() : '';
  if (!kw) return list.slice(0, Math.max(0, limit));
  const out = [];
  for (const row of list) {
    const code = String(row.code ?? '').toLowerCase();
    const name = String(row.name ?? '').toLowerCase();
    const secid = String(row.secid ?? '').toLowerCase();
    if (code.includes(kw) || name.includes(kw) || secid.includes(kw)) {
      out.push(row);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** 清空列表缓存（测试与手动刷新用）。 */
export function clearListCache() {
  cache.clear();
}

export const LIST_PAGE_SIZE = PAGE_SIZE;
export const LIST_CACHE_TTL = LIST_CACHE_TTL_MS;
