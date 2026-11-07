/**
 * dsh-stock-surf 个股详情增强数据层：公司业务介绍、最新公告、板块成分股。
 *
 * 纯 Host Node（Node 18，ESM，零 npm 依赖），只用全局 fetch。
 *
 * 数据源（均已实测，见 CONTRACT.md「v5 追加」）：
 *
 *   1. 公司概况  东财 F10 PageAjax
 *      https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=SH600519
 *      返回 `{ jbzl: [{ ORG_NAME, ORG_PROFILE, BUSINESS_SCOPE, INDUSTRYCSRC1, ... }] }`
 *      ORG_PROFILE 是「公司简介」正文，BUSINESS_SCOPE 是「经营范围」。
 *      ⚠️ 只覆盖 A 股；港美股无此接口。
 *
 *   2. 最新公告  东财公告接口
 *      https://np-anotice-stock.eastmoney.com/api/security/ann
 *          ?sr=-1&page_size=N&page_index=1&ann_type=A&client_source=web&stock_list=600519
 *      返回真实公告列表（季报、董事会决议等），含标题与日期。
 *
 *   3. 板块成分股  东财 datacenter 反向查询
 *      https://datacenter-web.eastmoney.com/api/data/v1/get
 *          ?reportName=RPT_F10_CORETHEME_BOARDTYPE
 *          &columns=SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,BOARD_CODE,BOARD_NAME
 *          &filter=(BOARD_CODE%3D%22896%22)&pageSize=100&pageNumber=N
 *      实测：白酒(896)=41 只、食品饮料(438)=132 只、酿酒概念(477)=38 只。
 *
 * ⚠️ 重要：东财 `push2*` 系列域名（行情/排行/clist）在本机**不可达**（IPv6 解析问题），
 *    但 `emweb` / `datacenter-web` / `np-anotice-stock` 三个域名**可用**。
 *    因此本模块只依赖这三个域名，绝不碰 push2。
 */

const F10_URL = 'https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax';
const ANN_URL = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const DATA_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

const DEFAULT_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 300000; // 公司简介与公告变化慢，缓存 5 分钟

/** 缓存：key -> { at, value } */
const cache = new Map();

/** 单次请求带超时的 JSON。 */
async function httpGetJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, referer } = {}) {
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
          'Mozilla/5.0 (compatible; dsh-stock-surf/0.1; +https://github.com/FanXingChunShui/dsh-stock) AppleWebKit/537.36 (KHTML, like Gecko)',
        Accept: 'application/json, text/javascript, */*',
        ...(referer ? { Referer: referer } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`astock: 详情接口返回 HTTP ${response.status}`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('astock: 详情接口返回的不是合法 JSON');
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`astock: 详情请求超时或被取消（${timeoutMs}ms）`);
    }
    if (error && typeof error.message === 'string' && error.message.startsWith('astock:')) throw error;
    throw new Error(`astock: 详情请求失败：${error && error.message ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 读缓存（未过期才返回）。 */
function cacheGet(key) {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

/** 写缓存。 */
function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.at > CACHE_TTL_MS) cache.delete(k);
    }
  }
}

/** 把字符串压成一行（去掉多余空白与换行）。 */
function oneLine(raw) {
  // 东财同一份响应里字段类型不统一（ORG_PROFILE 是字符串，EMP_NUM 是数字），
  // 一律先转字符串再压行，避免数字字段被静默丢成空串。
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : '';
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 东财 secid 格式：`600519.SH` / `000001.SZ`。
 *
 * @param {string} secid - 内部 secid，如 'sh600519'
 * @returns {string|null} '600519.SH' 或 null（非 A 股）
 */
export function toEastmoneyCode(secid) {
  const text = String(secid || '').trim().toLowerCase();
  const m = text.match(/^(sh|sz|bj)(\d{6})$/);
  if (!m) return null;
  const suffix = m[1] === 'sh' ? 'SH' : m[1] === 'sz' ? 'SZ' : 'BJ';
  return `${m[2]}.${suffix}`;
}

/**
 * 把 `600519.SH` 转成 F10 要求的 `SH600519`。
 *
 * F10 的 code 参数格式很挑：`SH600519` 与 `sh600519` 可用，
 * `600519` 与 `SH.600519` 都返回空响应（实测）。
 *
 * @param {string} eastmoneyCode - 如 '600519.SH'
 * @returns {string} 如 'SH600519'
 */
export function toF10Code(eastmoneyCode) {
  const text = String(eastmoneyCode || '').trim();
  const m = text.match(/^(\d{6})\.(SH|SZ|BJ)$/i);
  if (!m) return text.toUpperCase();
  return `${m[2].toUpperCase()}${m[1]}`;
}

/**
 * 解析公司概况响应。
 *
 * @param {object} payload - PageAjax 的 JSON
 * @returns {object|null}
 */
export function parseCompanyProfile(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const row = Array.isArray(payload.jbzl) && payload.jbzl.length > 0 ? payload.jbzl[0] : null;
  if (row === null) return null;

  const profile = oneLine(row.ORG_PROFILE);
  const scope = oneLine(row.BUSINESS_SCOPE);
  const name = oneLine(row.ORG_NAME);
  if (!profile && !scope && !name) return null;

  return {
    code: String(row.SECURITY_CODE || '').trim(),
    secid: typeof row.SECUCODE === 'string' ? row.SECUCODE.replace('.', '').toLowerCase() : null,
    name,
    nameEn: oneLine(row.ORG_NAME_EN),
    // 公司简介正文（可能较长，界面折叠显示）
    profile,
    // 经营范围
    businessScope: scope,
    industry: oneLine(row.INDUSTRYCSRC1) || oneLine(row.EM2016),
    chairman: oneLine(row.CHAIRMAN),
    president: oneLine(row.PRESIDENT),
    regCapital: oneLine(row.REG_CAPITAL),
    employees: oneLine(row.EMP_NUM),
    // 东财 F10 没有 FOUND_DATE 字段（实测），成立日期通常写在 ORG_PROFILE 正文里
    foundedAt: oneLine(row.FOUND_DATE) || oneLine(row.ESTABLISH_DATE) || null,
    website: oneLine(row.ORG_WEB),
    address: oneLine(row.REG_ADDRESS) || oneLine(row.ADDRESS),
    tel: oneLine(row.ORG_TEL),
    source: 'eastmoney-f10',
  };
}

/**
 * 解析公告列表响应。
 *
 * @param {object} payload
 * @returns {Array<object>}
 */
export function parseAnnouncements(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const data = payload.data;
  const list = data && Array.isArray(data.list) ? data.list : [];
  const out = [];
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue;
    const title = oneLine(row.title);
    if (!title) continue;
    out.push({
      title,
      date: typeof row.notice_date === 'string' ? row.notice_date.slice(0, 10) : null,
      // 东财公告详情页
      url: row.art_code
        ? `https://data.eastmoney.com/notices/detail/${String(row.codes?.[0]?.stock_code || '')}/${row.art_code}.html`
        : null,
      type: oneLine(row.columns?.[0]?.column_name),
    });
  }
  return out;
}

/**
 * 取公司业务介绍（A 股专用）。
 *
 * @param {string} secid - 'sh600519'
 * @param {{ timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} [options]
 * @returns {Promise<object|null>} 非 A 股返回 null（不抛错）
 */
export async function fetchCompanyProfile(secid, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const code = toEastmoneyCode(secid);
  // 港美股没有这个接口，直接返回 null，让界面隐藏该区块
  if (code === null) return null;

  const key = `profile:${code}`;
  if (opts.noCache !== true) {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
  }
  // ⚠️ F10 的 code 参数要求「市场前缀 + 代码」，如 SH600519；
  // 传 600519 或 SH.600519 都会返回 {"status":...} 空响应（实测）。
  const f10Code = toF10Code(code);
  const url = `${F10_URL}?code=${encodeURIComponent(f10Code)}&_=${Date.now()}`;
  const payload = await httpGetJson(url, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    referer: `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/Index?type=web&code=${f10Code}`,
  });
  const parsed = parseCompanyProfile(payload);
  cacheSet(key, parsed);
  return parsed;
}

/**
 * 取最新公告（A 股专用）。
 *
 * @param {string} secid
 * @param {{ limit?: number, timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} [options]
 * @returns {Promise<Array<object>>} 非 A 股返回空数组
 */
export async function fetchAnnouncements(secid, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const code = toEastmoneyCode(secid);
  if (code === null) return [];

  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(30, Math.floor(opts.limit)) : 8;
  const key = `ann:${code}:${limit}`;
  if (opts.noCache !== true) {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
  }
  const numeric = code.split('.')[0];
  const url = `${ANN_URL}?sr=-1&page_size=${limit}&page_index=1&ann_type=A&client_source=web&stock_list=${numeric}`;
  const payload = await httpGetJson(url, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    referer: 'https://data.eastmoney.com/',
  });
  const list = parseAnnouncements(payload);
  cacheSet(key, list);
  return list;
}

/**
 * 把内部板块代码转成东财板块数字码。
 *
 * 腾讯板块代码形如 `pt01801120`，东财形如 `896`（白酒）——两者**不通用**。
 * 目前板块详情页的成分股走东财时需要用户先有东财板块码，因此这里做
 * 「名称 → 东财板块码」的映射查询，实测可用。
 *
 * @param {string} boardName - 板块名，如 '白酒'
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<string|null>} 东财板块码，如 '896'
 */
export async function findEastmoneyBoardCode(boardName, options = {}) {
  const name = typeof boardName === 'string' ? boardName.trim() : '';
  if (!name) return null;
  const opts = options && typeof options === 'object' ? options : {};
  const key = `board:${name}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  // 用板块成分报表按名称反查一条，拿到 BOARD_CODE
  const url = `${DATA_URL}?reportName=RPT_F10_CORETHEME_BOARDTYPE`
    + '&columns=SECUCODE,SECURITY_CODE,BOARD_CODE,BOARD_NAME'
    + `&filter=(BOARD_NAME%3D%22${encodeURIComponent(name)}%22)`
    + '&pageSize=1&pageNumber=1';
  try {
    const payload = await httpGetJson(url, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    const row = payload && payload.result && Array.isArray(payload.result.data) ? payload.result.data[0] : null;
    const code = row && row.BOARD_CODE !== undefined && row.BOARD_CODE !== null ? String(row.BOARD_CODE) : null;
    cacheSet(key, code);
    return code;
  } catch {
    cacheSet(key, null);
    return null;
  }
}

/**
 * 拉取某个东财板块的全部成分股。
 *
 * @param {string} boardCode - 东财板块码，如 '896'
 * @param {{ timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} [options]
 * @returns {Promise<Array<{code:string,secid:string,name:string}>>}
 */
export async function fetchBoardConstituents(boardCode, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const code = String(boardCode || '').trim();
  if (!/^[0-9]{1,6}$/.test(code)) return [];

  const key = `cons:${code}`;
  if (opts.noCache !== true) {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
  }

  const base = `${DATA_URL}?reportName=RPT_F10_CORETHEME_BOARDTYPE`
    + '&columns=SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,BOARD_CODE,BOARD_NAME'
    + `&filter=(BOARD_CODE%3D%22${code}%22)`
    + '&sortColumns=SECURITY_CODE&sortTypes=1';

  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 30; page += 1) {
    const payload = await httpGetJson(`${base}&pageSize=100&pageNumber=${page}`, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const rows = payload && payload.result && Array.isArray(payload.result.data) ? payload.result.data : [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const stockCode = typeof row.SECURITY_CODE === 'string' ? row.SECURITY_CODE.trim() : '';
      if (!stockCode || seen.has(stockCode)) continue;
      seen.add(stockCode);
      const secucode = typeof row.SECUCODE === 'string' ? row.SECUCODE : '';
      const market = secucode.endsWith('.SH') ? 'sh' : secucode.endsWith('.SZ') ? 'sz' : secucode.endsWith('.BJ') ? 'bj' : null;
      all.push({
        code: stockCode,
        secid: market === null ? null : `${market}${stockCode}`,
        name: oneLine(row.SECURITY_NAME_ABBR),
      });
    }
    if (rows.length < 100) break;
  }
  cacheSet(key, all);
  return all;
}

/** 清空缓存（测试用）。 */
export function clearDetailCache() {
  cache.clear();
}
