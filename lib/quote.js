/**
 * dsh-stock-surf 行情数据层。
 *
 * 纯 Host Node（Node 18，ESM，零 npm 依赖），只用全局 fetch 与 TextDecoder('gbk')。
 * 数据源（按市场分工，均已实测）：
 *
 *   A 股
 *     实时快照  qt.gtimg.cn          腾讯（88 字段，含 PE/PB/量比/市值/涨跌停）
 *     日 K      quotes.sina.cn        新浪（**主源**，akshare 同源）
 *                web.ifzq.gtimg.cn    腾讯（备用，前复权）
 *     分钟线    quotes.sina.cn        新浪
 *
 *   港股
 *     快照与日K  qt.gtimg.cn / web.ifzq.gtimg.cn/hkfqkline   腾讯（唯一可用源）
 *
 *   美股
 *     实时快照  qt.gtimg.cn          腾讯
 *     日 K      web.ifzq.gtimg.cn    腾讯（主源，前复权）
 *               新浪全历史            备用（未复权）
 *
 *   搜索      smartbox.gtimg.cn      腾讯
 *
 * ⚠️ A 股 K 线为什么以新浪为主源：
 *    腾讯的 A 股日 K 接口会被 WAF 拦截（HTTP 501 + waf.tencent.com 跳转页），
 *    实测持续多日未恢复。每次都先撞 501 再回退等于白多一次往返，
 *    因此改为新浪优先。
 *
 * ⚠️ 复权差异（影响技术指标准确性）：
 *    新浪返回**不复权**数据，除权日附近有跳空；腾讯为**前复权**。
 *    所以先用新浪保可用，失败时用腾讯兜底保准确——两者取舍见 fetchDailyBars 注释。
 *
 * 契约见 CONTRACT.md「lib/quote.js 必须导出的 API（冻结）」。
 * 冻结主 API：normalizeCode / fetchQuotes / fetchDailyBars / searchSymbols / loadStockData。
 * 额外导出（契约允许，供测试用）：parseQuoteLine / parseQuoteResponse /
 *   parseKlineResponse / parseSuggestResponse / clearCache。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const SNAPSHOT_URL = 'https://qt.gtimg.cn/q=';
const KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
/** 港股前复权日 K。 */
const KLINE_URL_HK = 'https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get';
/** 美股前复权日 K。 */
const KLINE_URL_US = 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get';

/**
 * A 股日 K 备用源（新浪）。
 *
 * 腾讯 `web.ifzq.gtimg.cn` 的 A 股 K 线接口会被 WAF 拦截，返回
 * `HTTP 501` + 一个 `waf.tencent.com/501page.html` 跳转页（实测 2026-11-07）。
 * 这种情况下必须回退到新浪，否则整个 A 股评分链路会失效。
 * 新浪一次最多给 320 根左右，足够 MA60/RSI/MACD 计算。
 */
const KLINE_URL_SINA =
  'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData';

/**
 * 美股日 K 备用源（新浪）。
 *
 * 实测（2026-11-07）：`getDailyK` 免费、无需 key、无分页限制，返回**全历史**：
 *   AAPL 10070 条（1984-09-07 起）、MSFT 9688 条、NVDA 5802 条。
 * 字段 `d,o,h,l,c,v,a`，其中 `a` 是成交额——腾讯美股 K 线没有成交额。
 *
 * 注意：这是**未复权**数据，除权日会有跳空。因此腾讯（前复权）优先，
 * 仅在腾讯失败或返回空时兜底，并在 bars 上不声称是复权数据。
 */
const KLINE_URL_SINA_US =
  'https://stock.finance.sina.com.cn/usstock/api/json_v2.php/US_MinKService.getDailyK';
const SUGGEST_URL = 'https://smartbox.gtimg.cn/s3/';

const DEFAULT_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 30000;

/** 腾讯单次请求可带多个代码，但太长会超 URL 长度限制，分批。 */
const SNAPSHOT_BATCH = 50;

const DEFAULT_KLINE_LIMIT = 320;

const ERR = 'astock: ';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 解析数字，空串 / 非数字 / 占位符返回 null。 */
function num(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '' || s === '-' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 数组安全取值，越界返回 undefined。 */
function at(arr, i) {
  return i < arr.length ? arr[i] : undefined;
}

function numAt(arr, i) {
  return num(at(arr, i));
}

/** 合并外部 signal 与超时 signal。返回 { signal, cleanup }。 */
function withTimeout(signal, timeoutMs) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();

  const onExternalAbort = () => controller.abort();
  let externalBound = false;
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true });
      externalBound = true;
    }
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (externalBound) signal.removeEventListener('abort', onExternalAbort);
    },
    get timedOut() {
      return timedOut;
    },
  };
}

/**
 * 统一 GET + 解码。
 * @param {string} url
 * @param {{ encoding?: 'utf-8'|'gbk', timeoutMs?: number, signal?: AbortSignal }} opts
 */
async function httpGetText(url, opts = {}) {
  const { encoding = 'utf-8', timeoutMs, signal } = opts;
  const guard = withTimeout(signal, timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, {
        signal: guard.signal,
        headers: {
          // 部分节点对无 UA 请求返回空响应，带上更稳。
          'User-Agent':
            'Mozilla/5.0 (compatible; dsh-stock-surf/0.1; +https://github.com/FanXingChunShui/dsh-stock) AppleWebKit/537.36 (KHTML, like Gecko)',
          Accept: '*/*',
        },
      });
    } catch (err) {
      if (guard.timedOut) throw new Error(`${ERR}请求超时（${timeoutMs || DEFAULT_TIMEOUT_MS}ms）：${url}`);
      if (signal && signal.aborted) throw new Error(`${ERR}请求已被外部取消`);
      throw new Error(`${ERR}网络请求失败：${err && err.message ? err.message : String(err)}`);
    }

    if (!res.ok) throw new Error(`${ERR}接口返回 HTTP ${res.status}（${url}）`);

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error(`${ERR}接口返回空响应（${url}）`);
    return new TextDecoder(encoding).decode(buf);
  } finally {
    guard.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 缓存（30 秒 TTL 内存 Map）
// ---------------------------------------------------------------------------

/** key -> { at: number, value: any } */
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  // 顺手清理过期项，避免长期运行无限增长。
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.at > CACHE_TTL_MS) cache.delete(k);
    }
  }
  return value;
}

/** 清空缓存（测试与手动刷新用）。 */
export function clearCache() {
  cache.clear();
}

// ---------------------------------------------------------------------------
// normalizeCode
// ---------------------------------------------------------------------------

/**
 * 规范化股票代码。
 * @param {string} input '600519' / 'sh600519' / 'SH600519' / '000001' / 'sz000001'
 * @returns {{ market: 'sh'|'sz'|'bj', code: string, secid: string } | null}
 */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // ── 港股：hk00700 / HK00700 / 00700.hk / hk:00700 ──
  const hk = trimmed.match(/^(?:hk[:.]?|)([0-9]{1,5})(?:\.hk|hk)?$/i);
  // 上面太宽松，用显式分支处理

  // 显式港美股前缀
  const hkM = trimmed.match(/^hk[.:]?([0-9]{1,5})$/i) || trimmed.match(/^([0-9]{1,5})\.hk$/i);
  if (hkM) {
    // 港股代码 5 位，不足补前导零
    const digits = hkM[1].padStart(5, '0');
    return { market: 'hk', code: digits, secid: `hk${digits}`, marketLabel: '港股', currency: 'HKD' };
  }

  // 美股：usAAPL / us:aapl / aapl.us / AAPL.N / AAPL.OQ（带 us 前缀或 .us 后缀）
  const usM = trimmed.match(/^us[.:]?([a-z.]{1,10})$/i) || trimmed.match(/^([a-z]{1,6})\.us$/i);
  if (usM) {
    // 去掉 .OQ/.N 等交易所后缀：快照接口必须用裸代码
    const bare = usM[1].split('.')[0].toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(bare)) return null;
    return { market: 'us', code: bare, secid: `us${bare}`, marketLabel: '美股', currency: 'USD' };
  }

  // 港股指数（hkHSI 等）与美股指数（usDJI 等）
  const idxM = trimmed.match(/^(hk|us)([A-Z]{2,6})$/i);
  if (idxM) {
    const sym = idxM[2].toUpperCase();
    return { market: idxM[1].toLowerCase(), code: sym, secid: `${idxM[1].toLowerCase()}${sym}`, marketLabel: idxM[1] === 'hk' ? '港股' : '美股', currency: idxM[1] === 'hk' ? 'HKD' : 'USD' };
  }

  // ── A 股（保持原行为）──
  let s = trimmed.toLowerCase();
  s = s.replace(/^([a-z]{2})[.\-_]?(\d+)$/, '$1$2');
  s = s.replace(/^(\d+)[.\-_]?([a-z]{2})$/, '$2$1');

  let market = null;
  let digits = null;

  const m = s.match(/^(sh|sz|bj)(\d{6})$/);
  if (m) {
    market = m[1];
    digits = m[2];
  } else if (/^\d{6}$/.test(s)) {
    digits = null;
    // 6 位数字：先尝试按 A 股前缀推断
    digits = s;
  } else {
    return null;
  }

  if (!market) {
    const head = digits[0];
    if (head === '6' || head === '5' || head === '9') market = 'sh';
    else if (head === '0' || head === '3' || '12'.includes(head)) market = 'sz';
    else if (head === '4' || head === '8') market = 'bj';
    else return null;
  }
  const labels = { sh: '沪A', sz: '深A', bj: '北交所' };
  return { market, code: digits, secid: `${market}${digits}`, marketLabel: labels[market] ?? market, currency: 'CNY' };
}

// ---------------------------------------------------------------------------
// 实时快照解析
// ---------------------------------------------------------------------------

/** 快照字段下标（实测确认，见 CONTRACT.md「数据源事实」）。 */
const F = {
  name: 1,
  code: 2,
  price: 3,
  prevClose: 4,
  open: 5,
  volume: 6, // 手
  timestamp: 30, // YYYYMMDDHHMMSS
  change: 31,
  changePercent: 32,
  high: 33,
  low: 34,
  turnoverRate: 38,
  peTtm: 39,
  amplitude: 43,
  floatCap: 44, // 亿元
  totalCap: 45, // 亿元
  pb: 46,
  limitUp: 47,
  limitDown: 48,
  volumeRatio: 49,
  amountWan: 37, // 成交额（万元）
  // 类型标志：实测在下标 61（契约写 58，实测 58 是成交额冗余位）。两个位置都探。
  typeFlags: [61, 58],
};

/** '20261106161458' -> '2026-11-06 16:14:58'（本地时区格式化）。 */
function formatTimestamp(raw) {
  const s = String(raw || '').trim();
  if (!/^\d{14}$/.test(s)) return null;
  const y = s.slice(0, 4);
  const mo = s.slice(4, 6);
  const d = s.slice(6, 8);
  const h = s.slice(8, 10);
  const mi = s.slice(10, 12);
  const se = s.slice(12, 14);
  return `${y}-${mo}-${d} ${h}:${mi}:${se}`;
}

/** 从类型标志位判断是否指数。 */
function detectIndex(fields) {
  for (const idx of F.typeFlags) {
    const v = at(fields, idx);
    if (typeof v === 'string' && v.trim() === 'ZS') return true;
  }
  return false;
}

/**
 * 解析港股/美股快照行（market flag `100`/`200`）。
 *
 * 字段布局与 A 股不同：时间戳（下标 30）是 `2026/11/06 16:08:54` 或
 * `2026-11-06 16:00:01`，下标 35 在美股是货币，没有涨跌停价、买卖五档。
 * 见 CONTRACT.md「多市场实时快照」。
 *
 * @param {string} secidFromKey 'hk00700' | 'usaapl'
 * @param {string[]} f `~` 分割后的字段
 * @param {'hk'|'us'} market
 * @returns {object|null}
 */
function parseOverseasQuoteLine(secidFromKey, f, market) {
  const name = String(at(f, 1) || '').trim();
  const codeRaw = String(at(f, 2) || secidFromKey.slice(2)).trim();
  const price = numAt(f, 3);
  if (!name && !codeRaw) return null;
  // secid 大小写保留原样：港美指数形如 hkHSI/usDJI，小写化后与请求键对不上。
  // 匹配在 fetchQuotes 侧做大小写不敏感兜底。
  const isIndex = market === 'hk' ? /^HSI|HSTECH|HSCEI$/i.test(codeRaw) : /^(DJI|IXIC|SPX|NDX)$/i.test(codeRaw);
  const currency = market === 'hk' ? 'HKD' : 'USD';
  return {
    code: codeRaw,
    secid: secidFromKey,
    market,
    name,
    price,
    prevClose: numAt(f, 4),
    open: numAt(f, 5),
    high: numAt(f, 33),
    low: numAt(f, 34),
    change: numAt(f, 31),
    changePercent: numAt(f, 32),
    volume: numAt(f, 6),
    // 美股下标 37 是成交额（元）；港股此位是 0
    amount: numAt(f, 37),
    turnoverRate: numAt(f, 38),
    peTtm: numAt(f, 39),
    pb: null,
    volumeRatio: numAt(f, 49),
    amplitude: numAt(f, 43),
    floatCap: numAt(f, 44),
    totalCap: numAt(f, 45),
    limitUp: null,
    limitDown: null,
    timestamp: formatOverseasTimestamp(at(f, 30)),
    isIndex,
    isSuspended: !isIndex && (price === null || price === 0),
    currency,
  };
}

/** 解析港美股时间戳：支持 `2026/11/06 16:08:54` 与 `2026-11-06 16:00:01` 两种格式。 */
function formatOverseasTimestamp(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  const m = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ ](\d{1,2}:\d{2}:\d{2})$/);
  if (!m) return text;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')} ${m[4]}`;
}

/**
 * 解析单条 `v_sh600519="..."` 行。
 * @param {string} line
 * @returns {object|null} Quote 或 null（无法解析 / 空数据）
 */
export function parseQuoteLine(line) {
  if (typeof line !== 'string') return null;
  // v3：A 股 `v_sh600519` / 港股 `v_hk00700` / 港指 `v_hkHSI` / 美股 `v_usAAPL` / 美指 `v_usDJI`
  const m = line.match(/v_([a-z]{2}[0-9a-z]{2,6})="([^"]*)"/i);
  if (!m) return null;

  const secidFromKey = m[1].toLowerCase();
  const payload = m[2];
  if (!payload.trim()) return null;

  const f = payload.split('~');
  // 至少有价格与名称才认为有效
  if (f.length < 5) return null;

  // 港美股字段布局不同，走独立分支（见 CONTRACT.md「多市场实时快照」）
  const flag = String(f[0] ?? '').trim();
  if (flag === '100' || flag === '200') {
    // 传原始大小写的键：港美指数形如 hkHSI，小写会丢信息
    const rawKey = m[1];
    return parseOverseasQuoteLine(rawKey, f, flag === '100' ? 'hk' : 'us');
  }

  const market = secidFromKey.slice(0, 2);
  const code = String(at(f, F.code) || secidFromKey.slice(2)).trim();
  const name = String(at(f, F.name) || '').trim();
  if (!name && !code) return null;

  const price = numAt(f, F.price);
  const volume = numAt(f, F.volume);
  const isIndex = detectIndex(f);
  const amountWan = numAt(f, F.amountWan);

  return {
    code,
    secid: secidFromKey,
    market,
    name,
    price,
    prevClose: numAt(f, F.prevClose),
    open: numAt(f, F.open),
    high: numAt(f, F.high),
    low: numAt(f, F.low),
    change: numAt(f, F.change),
    changePercent: numAt(f, F.changePercent),
    volume,
    amount: amountWan === null ? null : amountWan * 10000,
    turnoverRate: numAt(f, F.turnoverRate),
    peTtm: numAt(f, F.peTtm),
    pb: numAt(f, F.pb),
    volumeRatio: numAt(f, F.volumeRatio),
    amplitude: numAt(f, F.amplitude),
    floatCap: numAt(f, F.floatCap),
    totalCap: numAt(f, F.totalCap),
    limitUp: numAt(f, F.limitUp),
    limitDown: numAt(f, F.limitDown),
    timestamp: formatTimestamp(at(f, F.timestamp)),
    isIndex,
    // 停牌：非指数，且价格缺失或为 0，或成交量为 0
    isSuspended: !isIndex && ((price === null || price === 0) || (volume !== null && volume === 0)),
  };
}

/**
 * 解析整个快照响应体。
 * @param {string} text 已按 GBK 解码的文本
 * @returns {Map<string, object>} secid -> Quote
 */
export function parseQuoteResponse(text) {
  const out = new Map();
  if (typeof text !== 'string' || !text) return out;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const q = parseQuoteLine(trimmed);
    if (q) out.set(q.secid, q);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 日 K 线解析
// ---------------------------------------------------------------------------

/**
 * 解析日 K 线响应。
 * @param {string} text 原始响应文本（UTF-8）
 * @param {string} secid 'sh600519'
 * @returns {Array<{date:string,open:number,close:number,high:number,low:number,volume:number}>}
 */
export function parseKlineResponse(text, secid) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${ERR}K线响应不是合法 JSON（${secid}）`);
  }
  if (!json || typeof json !== 'object') throw new Error(`${ERR}K线响应结构异常（${secid}）`);
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(`${ERR}K线接口返回 code=${json.code} ${json.msg || ''}`.trim());
  }

  const data = json.data;
  if (!data || typeof data !== 'object') throw new Error(`${ERR}K线响应缺少 data（${secid}）`);

  const node = data[secid] || data[secid.toLowerCase()] || data[secid.toUpperCase()];
  if (!node) throw new Error(`${ERR}K线响应缺少 ${secid} 节点`);

  // 键名随 fqt 变化：优先 qfqday，回退 day
  const raw = node.qfqday || node.day || node.hfqday || [];
  if (!Array.isArray(raw)) return [];

  const bars = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 6) continue;
    const date = String(item[0] || '').trim();
    const open = num(item[1]);
    const close = num(item[2]);
    const high = num(item[3]);
    const low = num(item[4]);
    const volume = num(item[5]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (open === null || close === null || high === null || low === null) continue;
    bars.push({ date, open, close, high, low, volume: volume === null ? 0 : volume });
  }

  // 按日期升序（接口本来就是升序，防御性排序）
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return bars;
}

// ---------------------------------------------------------------------------
// 搜索解析
// ---------------------------------------------------------------------------

/** 把 `\uXXXX` 转义还原为中文。 */
function unescapeUnicode(s) {
  if (typeof s !== 'string' || s.indexOf('\\u') === -1) return s;
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * 解析搜索响应。
 * @param {string} text 已按 GBK 解码的文本
 * @returns {Array<{market:string,code:string,secid:string,name:string,pinyin:string}>}
 */
export function parseSuggestResponse(text) {
  if (typeof text !== 'string' || !text) return [];
  const m = text.match(/v_hint="([^"]*)"/);
  const body = m ? m[1] : '';
  if (!body || body === 'N' || body.trim() === '') return [];

  const out = [];
  const seen = new Set();
  for (const chunk of body.split('^')) {
    const item = chunk.trim();
    if (!item) continue;
    const parts = item.split('~');
    if (parts.length < 3) continue;
    const market = String(parts[0] || '').trim().toLowerCase();
    const code = String(parts[1] || '').trim();
    const name = unescapeUnicode(String(parts[2] || '').trim());
    const pinyin = unescapeUnicode(String(parts[3] || '').trim());
    if (!/^(sh|sz|bj)$/.test(market)) continue;
    if (!/^\d{6}$/.test(code)) continue;
    const secid = `${market}${code}`;
    if (seen.has(secid)) continue;
    seen.add(secid);
    out.push({ market, code, secid, name, pinyin });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主 API
// ---------------------------------------------------------------------------

/**
 * 批量实时快照。
 * @param {string[]} codes
 * @param {{ timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} options
 * @returns {Promise<Array<object|null>>} 与 codes 同序
 */
export async function fetchQuotes(codes, options = {}) {
  if (!Array.isArray(codes)) throw new Error(`${ERR}fetchQuotes 需要代码数组`);
  if (codes.length === 0) return [];

  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, noCache = false } = options;

  // 规范化，记录每个原始下标对应到哪个 secid（非法项直接 null）
  const normalized = codes.map((c) => normalizeCode(c));
  const needed = [];
  const seen = new Set();
  for (const n of normalized) {
    if (n && !seen.has(n.secid)) {
      seen.add(n.secid);
      needed.push(n.secid);
    }
  }

  /** @type {Map<string, object>} */
  const resolved = new Map();

  // 先吃缓存
  const missing = [];
  for (const secid of needed) {
    const hit = noCache ? undefined : cacheGet(`quote:${secid}`);
    if (hit !== undefined) resolved.set(secid, hit);
    else missing.push(secid);
  }

  // 分批请求缺失项
  for (let i = 0; i < missing.length; i += SNAPSHOT_BATCH) {
    const batch = missing.slice(i, i + SNAPSHOT_BATCH);
    const url = `${SNAPSHOT_URL}${batch.join(',')}`;
    const text = await httpGetText(url, { encoding: 'gbk', timeoutMs, signal });
    const parsed = parseQuoteResponse(text);
    for (const secid of batch) {
      const q = parsed.get(secid) || null;
      // 只缓存成功项，失败项下次重试
      if (q) cacheSet(`quote:${secid}`, q);
      resolved.set(secid, q);
    }
  }

  // 大小写不敏感兜底：港美指数（hkHSI）解析回传的键保留原样，而请求侧
  // normalizeCode 产生的键可能大小写不同，直接 get 会丢结果。
  const lowerIndex = new Map();
  for (const [code, quote] of resolved) lowerIndex.set(code.toLowerCase(), quote);
  return normalized.map((n) => {
    if (!n) return null;
    return resolved.get(n.secid) ?? lowerIndex.get(n.secid.toLowerCase()) ?? null;
  });
}

/**
 * 日 K 线（前复权，按日期升序）。
 * @param {string} code
 * @param {{ limit?: number, adjust?: 'qfq'|'none', timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} options
 * @returns {Promise<Array<object>>}
 */
export async function fetchDailyBars(code, options = {}) {
  const norm = normalizeCode(code);
  if (!norm) throw new Error(`${ERR}非法股票代码：${code}`);

  const {
    limit = DEFAULT_KLINE_LIMIT,
    adjust = 'qfq',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    noCache = false,
  } = options;

  const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_KLINE_LIMIT;
  const fqt = adjust === 'none' ? '' : adjust;
  const cacheKey = `bars:${norm.secid}:${count}:${fqt || 'none'}`;

  if (!noCache) {
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) return hit;
  }

  // v3 多市场：美股 K 线接口必须带交易所后缀（usAAPL.OQ），而快照接口必须用裸代码
  // （usAAPL）。带后缀的完整代码从快照里拿不到时，退回裸代码尝试（指数等无后缀标的）。
  let klineSecid = norm.secid;
  let klineUrl = KLINE_URL;
  if (norm.market === 'hk') {
    klineUrl = KLINE_URL_HK;
  } else if (norm.market === 'us') {
    klineUrl = KLINE_URL_US;
    if (!/\.[A-Z]{1,4}$/.test(norm.code)) {
      // 无后缀：查一次快照拿真实代码（含后缀），失败则原样尝试
      try {
        const quotes = await fetchQuotes([norm.secid], { timeoutMs, signal, noCache: true });
        const real = quotes[0] && typeof quotes[0].code === 'string' ? quotes[0].code : null;
        if (real && real.includes('.')) klineSecid = `us${real}`;
      } catch {
        // 忽略，用裸代码直接试
      }
    }
  }

  /** @type {Array<object>} */
  let bars = [];

  if (isCnMarket(norm.market)) {
    // ── A 股：新浪为主源，腾讯为备用源 ──────────────────────────────────
    //
    // 为什么把新浪提到主源：腾讯 A 股的日 K 接口（web.ifzq.gtimg.cn）会被
    // WAF 拦截，返回 HTTP 501 + 一个 waf.tencent.com 跳转页（实测持续多日）。
    // 每次都先撞一次 501 再回退，等于白白多一次网络往返。
    //
    // 既然新浪（quotes.sina.cn，akshare 等开源量化库的核心源之一）稳定可用，
    // 就把它当成主源；腾讯仅在它失败时兜底——腾讯的优势是**前复权**数据。
    //
    // 数据差异（必须知道）：
    //   - 新浪返回的是**不复权**数据，除权日附近会有跳空
    //   - 腾讯返回前复权（qfq），技术指标更准确
    // 所以顺序是「新浪优先求可用性，腾讯兜底求准确性」，而不是反过来。
    bars = await fetchSinaBars(norm.secid, count, timeoutMs, signal);

    // 新浪失败或为空 → 回退腾讯
    if (bars.length === 0) {
      const param = `${klineSecid},day,,,${count},${fqt}`;
      const url = `${klineUrl}?param=${encodeURIComponent(param)}`;
      try {
        const text = await httpGetText(url, { encoding: 'utf-8', timeoutMs, signal });
        bars = parseKlineResponse(text, klineSecid);
      } catch (error) {
        // WAF 拦截（501）说明腾讯这边也不可用，但新浪已经试过了，
        // 此时确实没有数据；超时/取消仍然要抛，不能伪装成「没有数据」。
        if (isWafBlocked(error)) {
          bars = [];
        } else {
          throw error;
        }
      }
    }
  } else {
    // ── 港股 / 美股：仍走腾讯（这两个市场的腾讯接口正常）────────────────
    const param = `${klineSecid},day,,,${count},${fqt}`;
    const url = `${klineUrl}?param=${encodeURIComponent(param)}`;
    try {
      const text = await httpGetText(url, { encoding: 'utf-8', timeoutMs, signal });
      bars = parseKlineResponse(text, klineSecid);
    } catch (error) {
      if (isWafBlocked(error) && norm.market === 'us') {
        bars = [];
      } else {
        throw error;
      }
    }

    // 美股备用源：腾讯失败/空时走新浪（全历史、未复权）
    if (bars.length === 0 && norm.market === 'us') {
      bars = await fetchSinaUsBars(norm.code, count, timeoutMs, signal);
    }
  }

  // 接口可能返回多于请求的条数，取尾部
  if (bars.length > count) bars = bars.slice(bars.length - count);

  cacheSet(cacheKey, bars);
  return bars;
}

/** 是否 A 股市场（可用新浪备用源）。 */
function isCnMarket(market) {
  return market === 'sh' || market === 'sz' || market === 'bj';
}

/**
 * 判断错误是否来自腾讯 WAF 拦截。
 *
 * WAF 拦截的特征是 HTTP 501，响应体是一段 `waf.tencent.com/501page.html`
 * 跳转脚本。超时（AbortError）与外部取消都不算，必须继续抛出。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isWafBlocked(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /HTTP 501/.test(message) || /waf\.tencent\.com/.test(message);
}

/**
 * 从新浪取 A 股日 K（备用源）。
 *
 * @param {string} secid - 'sh600519'
 * @param {number} count
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<object>>}
 */
async function fetchSinaUsBars(code, count, timeoutMs, signal) {
  // 新浪美股用裸代码（AAPL），不带交易所后缀
  const symbol = String(code || '').split('.')[0].toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(symbol)) return [];
  const url = `${KLINE_URL_SINA_US}?symbol=${encodeURIComponent(symbol)}&_=1`;
  try {
    const text = await httpGetText(url, { encoding: 'utf-8', timeoutMs, signal });
    const all = parseSinaUsKlineResponse(text);
    // 新浪返回全历史，取尾部 count 根
    return all.length > count ? all.slice(all.length - count) : all;
  } catch {
    return [];
  }
}

async function fetchSinaBars(secid, count, timeoutMs, signal) {
  const url = `${KLINE_URL_SINA}?symbol=${encodeURIComponent(secid)}&scale=240&ma=no&datalen=${count}`;
  try {
    const text = await httpGetText(url, { encoding: 'utf-8', timeoutMs, signal });
    return parseSinaKlineResponse(text);
  } catch {
    return [];
  }
}

/**
 * 解析新浪日 K 响应（A 股备用源）。
 *
 * 结构：`[{ day, open, high, low, close, volume }, ...]`，字段是字符串，
 * 按日期升序返回。
 *
 * @param {string} text
 * @returns {Array<{date:string,open:number,close:number,high:number,low:number,volume:number}>}
 */
export function parseSinaKlineResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (row === null || typeof row !== 'object') continue;
    const date = typeof row.day === 'string' ? row.day.slice(0, 10) : '';
    const open = numOf(row.open);
    const close = numOf(row.close);
    const high = numOf(row.high);
    const low = numOf(row.low);
    if (!date || open === null || close === null) continue;
    out.push({
      date,
      open,
      close,
      high: high === null ? close : high,
      low: low === null ? close : low,
      volume: numOf(row.volume) ?? 0,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * 解析新浪美股日 K 响应。
 *
 * 结构：`[{ d, o, h, l, c, v, a }, ...]`，字段都是字符串，升序返回。
 *
 * @param {string} text
 * @returns {Array<{date:string,open:number,close:number,high:number,low:number,volume:number}>}
 */
export function parseSinaUsKlineResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (row === null || typeof row !== 'object') continue;
    const date = typeof row.d === 'string' ? row.d.slice(0, 10) : '';
    const open = numOf(row.o);
    const close = numOf(row.c);
    const high = numOf(row.h);
    const low = numOf(row.l);
    if (!date || open === null || close === null) continue;
    out.push({
      date,
      open,
      close,
      high: high === null ? close : high,
      low: low === null ? close : low,
      volume: numOf(row.v) ?? 0,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/** 把任意值转成有限数字，失败返回 null。 */
function numOf(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析新浪 K 线响应并**保留完整时间戳**（分钟线用）。
 *
 * 与 parseSinaKlineResponse 的区别：那个把 day 截断成 YYYY-MM-DD（日线够用），
 * 分钟线的 day 是 `2026-11-06 14:15:00`，截断后就分不清是哪根 K 线了。
 *
 * @param {string} text
 * @returns {Array<{time:string,date:string,open:number,close:number,high:number,low:number,volume:number}>}
 */
export function parseSinaTimedKlineResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (row === null || typeof row !== 'object') continue;
    const time = typeof row.day === 'string' ? row.day.trim() : '';
    if (!time) continue;
    const open = numOf(row.open);
    const close = numOf(row.close);
    const high = numOf(row.high);
    const low = numOf(row.low);
    if (open === null || close === null) continue;
    out.push({
      time,
      date: time.slice(0, 10),
      open,
      close,
      high: high === null ? close : high,
      low: low === null ? close : low,
      volume: numOf(row.volume) ?? 0,
    });
  }
  out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return out;
}

/**
 * 拉取分钟级 K 线（A 股，新浪源）。
 *
 * 实测各 scale 的 200 根覆盖范围（2026-11-07）：
 *   scale=5   约 5 个交易日
 *   scale=15  约 13 个交易日
 *   scale=30  约 1 个月
 *   scale=60  约 2.5 个月
 * 日线请用 fetchDailyBars，不要传 scale=240 到这里。
 *
 * @param {string} secid - 'sh600519'
 * @param {{ scale?: 5|15|30|60, limit?: number, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function fetchMinuteBars(secid, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const norm = normalizeCode(secid);
  if (norm === null) throw new Error(`${ERR}非法股票代码：${secid}`);
  // 分钟线只有 A 股可用；港美股走日线
  if (norm.market !== 'sh' && norm.market !== 'sz' && norm.market !== 'bj') return [];

  const allowed = [5, 15, 30, 60];
  const scale = allowed.includes(Number(opts.scale)) ? Number(opts.scale) : 5;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(1000, Math.floor(opts.limit)) : 200;
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;

  const cacheKey = `min:${norm.secid}:${scale}:${limit}`;
  if (opts.noCache !== true) {
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) return hit;
  }

  const url = `${KLINE_URL_SINA}?symbol=${encodeURIComponent(norm.secid)}&scale=${scale}&ma=no&datalen=${limit}`;
  try {
    const text = await httpGetText(url, { encoding: 'utf-8', timeoutMs, signal: opts.signal });
    const bars = parseSinaTimedKlineResponse(text);
    cacheSet(cacheKey, bars);
    return bars;
  } catch (error) {
    // 超时与取消必须原样抛出，不能被当成「没数据」
    if (error && typeof error.message === 'string'
      && (error.message.includes('超时') || error.message.includes('取消'))) {
      throw error;
    }
    return [];
  }
}

/**
 * 名称搜索。
 * @param {string} keyword
 * @param {{ timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} options
 * @returns {Promise<Array<{market:string,code:string,secid:string,name:string,pinyin:string}>>}
 */
export async function searchSymbols(keyword, options = {}) {
  const kw = typeof keyword === 'string' ? keyword.trim() : '';
  if (!kw) return [];

  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, noCache = false } = options;
  const cacheKey = `suggest:${kw.toLowerCase()}`;

  if (!noCache) {
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) return hit;
  }

  const url = `${SUGGEST_URL}?v=2&q=${encodeURIComponent(kw)}&t=all&c=1`;
  const text = await httpGetText(url, { encoding: 'gbk', timeoutMs, signal });
  const results = parseSuggestResponse(text);

  cacheSet(cacheKey, results);
  return results;
}

/**
 * 一次取齐评估所需数据。单点失败不抛，转成 warnings。
 * @param {string} code
 * @param {{ days?: number, timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} options
 * @returns {Promise<{quote: object|null, bars: Array<object>, warnings: string[]}>}
 */
export async function loadStockData(code, options = {}) {
  const warnings = [];
  const norm = normalizeCode(code);
  if (!norm) {
    return { quote: null, bars: [], warnings: [`非法股票代码：${code}`] };
  }

  const { days = DEFAULT_KLINE_LIMIT, timeoutMs = DEFAULT_TIMEOUT_MS, signal, noCache = false } = options;
  const shared = { timeoutMs, signal, noCache };

  const [quoteResult, barsResult] = await Promise.allSettled([
    fetchQuotes([norm.secid], shared).then((list) => list[0] ?? null),
    fetchDailyBars(norm.secid, { ...shared, limit: days }),
  ]);

  let quote = null;
  if (quoteResult.status === 'fulfilled') {
    quote = quoteResult.value;
    if (!quote) warnings.push(`未获取到 ${norm.secid} 的实时快照（可能已退市或代码有误）`);
  } else {
    warnings.push(`实时快照获取失败：${quoteResult.reason && quoteResult.reason.message ? quoteResult.reason.message : String(quoteResult.reason)}`);
  }

  let bars = [];
  if (barsResult.status === 'fulfilled') {
    bars = barsResult.value;
    if (bars.length === 0) warnings.push(`未获取到 ${norm.secid} 的日K线数据`);
  } else {
    warnings.push(`日K线获取失败：${barsResult.reason && barsResult.reason.message ? barsResult.reason.message : String(barsResult.reason)}`);
  }

  return { quote, bars, warnings };
}

// ---------------------------------------------------------------------------
// 常用指数（供 RPC indices endpoint 复用）
// ---------------------------------------------------------------------------

/** 上证指数 / 深证成指 / 创业板指 */
export const INDEX_SECIDS = ['sh000001', 'sz399001', 'sz399006'];

export default {
  normalizeCode,
  fetchQuotes,
  fetchDailyBars,
  searchSymbols,
  loadStockData,
  clearCache,
  INDEX_SECIDS,
};
