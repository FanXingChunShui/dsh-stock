/**
 * dsh-astock 板块（Sector）数据层。
 *
 * 纯 Host Node（Node 18，ESM，零 npm 依赖），只用全局 fetch 与 TextDecoder('gbk')。
 * 数据源见 CONTRACT.md「v2 追加：板块（Sector）功能 / 数据源事实」：
 *
 *   1. 板块排行列表  https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank
 *      UTF-8 JSON，{ code: 0, msg: 'ok', data: { rank_list: [...] } }
 *      board_type: hy(一级行业) / hy2(二级行业) / gn(概念)
 *   2. 板块实时行情  https://qt.gtimg.cn/q=pt01801120
 *      **GBK** 文本，v_pt01801120="2~食品饮料~01801120~...";
 *   3. 板块日K —— 不可用（任何 limit 都只返回 1 条），本模块不提供 K 线。
 *
 * 冻结主 API：normalizeSector / fetchSectors / fetchSectorQuotes / fetchSector。
 * 额外导出（契约允许，供测试用）：parseSectorRank / parseSectorQuoteLine /
 *   mergeSectorPages / toNumber / parseZgb / clearSectorCache。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const RANK_URL = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank';
const QT_URL = 'https://qt.gtimg.cn/q=';

const DEFAULT_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 30000;

/**
 * ⚠️ 排行接口 `count` 硬上限 = 100！
 *
 * 实测（2026-11-07）：count=101 以上直接返回错误
 *   {"code":1619377101,"msg":"error_type=2 suggest=2 msg=参数错误:count too large"}
 * 拿不到 data.rank_list（早期版本甚至返回空 data 让人误以为"板块只有这么多"）。
 * 所以想取全量必须按 offset 0/100/200/... 自己翻页，绝不能把 count 调大。
 * 实测规模：hy=31、hy2=124、gn=805。offset 翻页不重复、末页不足 100 条。
 */
const PAGE_SIZE = 100;

/** 单次请求最多翻多少页，防止服务端异常时无限循环（100 * 50 = 5000 条，远大于 805）。 */
const MAX_PAGES = 50;

/** qt 接口一次带太多板块代码 URL 会过长，分批。 */
const QT_BATCH = 50;

/** 有效的 board_type。 */
const BOARD_TYPES = new Set(['hy', 'hy2', 'gn']);

/**
 * 服务端 `sort_type` 只有 price / speed / turnover / volume 有效，而且**返回值并非按该字段排序**
 * （实测 price 返回的是行业代码序）。这里固定传 price 只为让分页稳定可复现，
 * 真正的排序由调用方在本地做 —— 本模块不做任何本地排序（见 CONTRACT.md）。
 */
const RANK_SORT_TYPE = 'price';

const ERR = 'astock: ';

const UA =
  'Mozilla/5.0 (compatible; dsh-astock/0.1; +https://github.com/OWNER/dsh-astock) AppleWebKit/537.36 (KHTML, like Gecko)';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 稳健转数字：空串 / '-' / '--' / null / undefined / NaN / 非法值一律返回 null，**绝不返回 NaN**。
 * 排行接口里所有数值字段都是字符串，务必走这里。
 * @param {unknown} raw
 * @returns {number|null}
 */
export function toNumber(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '' || s === '-' || s === '--' || s === '—') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析涨跌家数 `zgb`，格式 "24/122"（上涨/下跌）。
 * 也容忍 '24-122'、'24 / 122'、单边缺失。解析不了返回 { upCount: null, downCount: null }。
 * @param {unknown} raw
 * @returns {{ upCount: number|null, downCount: number|null }}
 */
export function parseZgb(raw) {
  const none = { upCount: null, downCount: null };
  if (typeof raw !== 'string') return none;
  const s = raw.trim();
  if (!s) return none;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[/\-]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return none;
  return { upCount: toNumber(m[1]), downCount: toNumber(m[2]) };
}

/** 数组安全取值。 */
function at(arr, i) {
  return i < arr.length ? arr[i] : undefined;
}

/** 同步 throw 的取消检查。 */
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new Error(`${ERR}请求已被外部取消`);
}

/** 合并外部 signal 与超时 signal。返回 { signal, cleanup, timedOut() }。 */
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
    if (signal.aborted) controller.abort();
    else {
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
 * @returns {Promise<string>}
 */
async function httpGetText(url, opts = {}) {
  const { encoding = 'utf-8', timeoutMs, signal } = opts;
  const guard = withTimeout(signal, timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, {
        signal: guard.signal,
        headers: { 'User-Agent': UA, Accept: '*/*' },
      });
    } catch (err) {
      if (guard.timedOut) {
        throw new Error(`${ERR}请求超时（${timeoutMs || DEFAULT_TIMEOUT_MS}ms）：${url}`);
      }
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

/**
 * 重试等待。
 * ⚠️ 这里**不能** unref：若定时器被 unref，Node 可能在等待期间发现没有其它活跃句柄，
 * 直接判定事件循环已空并退出进程（测试里表现为 exit code 13 / "event loop has already resolved"）。
 * 超时用的 AbortController 定时器则相反，要 unref，避免拖住进程。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 三层缓存（30 秒）
//   1. 列表层   boardType -> Sector[]（fetchSectors 的返回）
//   2. 分页层   `${boardType}:${offset}` -> 单页原始 rank_list（翻页复用，避免重复请求）
//   3. 单条层   code -> Sector（fetchSector 查找结果）
// ---------------------------------------------------------------------------

/** @type {Map<string, { at: number, value: any }>} */
const listCache = new Map();
/** @type {Map<string, { at: number, value: any }>} */
const pageCache = new Map();
/** @type {Map<string, { at: number, value: any }>} */
const oneCache = new Map();

function cacheGet(store, key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(store, key, value) {
  store.set(key, { at: Date.now(), value });
  return value;
}

/** 清空全部板块缓存（测试用）。 */
export function clearSectorCache() {
  listCache.clear();
  pageCache.clear();
  oneCache.clear();
}

// ---------------------------------------------------------------------------
// 1. 板块代码规范化
// ---------------------------------------------------------------------------

/**
 * 板块代码形态（实测 805 条真实数据）：`pt` + 8 位，纯数字或数字与字母混合。
 *   pt01801120 / pt02031283 / pt02GN2287 / pt02B20001
 * 前 4 位实测只有 pt01（行业）与 pt02（概念/板块分组）两种，但这里只校验整体形态，
 * 不锁死前缀，避免服务端加新分组时误杀。
 */
const SECTOR_CODE_RE = /^pt[0-9a-z]{8}$/i;

/**
 * 规范化板块代码。接受：
 *   - 'pt01801120' / 'PT01801120' / 'pt02GN2287'（完整板块代码，原样小写化前缀）
 *   - '01801120' / '02GN2287'（缺 pt 前缀，自动补）
 *   - '食品饮料'（板块名，需 nameCache 已由 fetchSectors 填充，否则 name 返回 null）
 *
 * @param {string} input
 * @returns {{ code: string, secid: string, name: string|null } | null}
 *   code / secid 均为 'pt...' 形式的小写代码；name 仅在能解析出中文名时非 null。
 */
export function normalizeSector(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  // a) 完整 / 缺前缀的板块代码
  let cand = null;
  const lower = raw.toLowerCase();
  if (lower.startsWith('pt')) cand = lower;
  else if (/^[0-9a-z]{8}$/i.test(raw)) cand = `pt${lower}`;

  if (cand !== null) {
    if (!SECTOR_CODE_RE.test(cand)) return null;
    const name = nameIndex.get(cand) ?? null;
    return { code: cand, secid: cand, name };
  }

  // b) 板块中文名 —— 只能查已加载过的列表索引（本模块不做搜索接口调用）
  const hit = nameIndex.get(raw);
  if (hit) return { code: hit, secid: hit, name: raw };

  return null;
}

/**
 * 板块代码 -> 中文名 / 中文名 -> 板块代码 的双向索引。
 * 由 parseSectorRank / fetchSectors 填充，让 normalizeSector('食品饮料') 能命中。
 * @type {Map<string, string>}
 */
const nameIndex = new Map();

function indexNames(list) {
  for (const it of list) {
    if (it && it.code && it.name) {
      nameIndex.set(it.code, it.name);
      if (!nameIndex.has(it.name)) nameIndex.set(it.name, it.code);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. 排行列表解析（UTF-8 JSON）
// ---------------------------------------------------------------------------

/** 解析领涨股 `lzg`：{ code, name, zxj, zd, zdf }，缺失返回 null。 */
function parseLeader(lzg) {
  if (!lzg || typeof lzg !== 'object') return null;
  const code = typeof lzg.code === 'string' ? lzg.code.trim() : '';
  const name = typeof lzg.name === 'string' ? lzg.name.trim() : '';
  if (!code && !name) return null;
  return {
    code,
    name,
    price: toNumber(lzg.zxj),
    change: toNumber(lzg.zd),
    changePercent: toNumber(lzg.zdf),
  };
}

/**
 * 把排行接口单条 rank_list 记录规范化为 Sector 对象。
 * 注意：字段值全部是字符串，一律经 toNumber 转换，缺失/非法 -> null（绝不 NaN）。
 * @param {object} item
 * @param {'hy'|'hy2'|'gn'} boardType
 */
function mapSectorItem(item, boardType) {
  if (!item || typeof item !== 'object') return null;
  const code = typeof item.code === 'string' ? item.code.trim() : '';
  if (!code) return null;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const { upCount, downCount } = parseZgb(item.zgb);

  return {
    code,
    name,
    boardType,
    stockType: typeof item.stock_type === 'string' ? item.stock_type : '',
    // 板块指数点位（非价格）
    price: toNumber(item.zxj),
    change: toNumber(item.zd),
    changePercent: toNumber(item.zdf),
    change5d: toNumber(item.zdf_d5),
    change20d: toNumber(item.zdf_d20),
    change60d: toNumber(item.zdf_d60),
    change52w: toNumber(item.zdf_w52),
    changeYtd: toNumber(item.zdf_y),
    turnoverRate: toNumber(item.hsl),
    volumeRatio: toNumber(item.lb),
    speed: toNumber(item.speed),
    // 亿元
    totalCap: toNumber(item.zsz),
    floatCap: toNumber(item.ltsz),
    // 来自 zgb "24/122"
    upCount,
    downCount,
    // 万元
    capitalNet: toNumber(item.zljlr),
    capitalNet5d: toNumber(item.zljlr_d5),
    capitalNet20d: toNumber(item.zljlr_d20),
    // 额外保留（契约 Sector 未列出，但契约表格里有，评分/展示可用）
    mainIn: toNumber(item.zllr),
    mainOut: toNumber(item.zllc),
    leader: parseLeader(item.lzg),
  };
}

/**
 * 解析排行接口响应文本（不做任何网络请求，纯函数，供测试）。
 * @param {string} text 接口原始文本（UTF-8 JSON）
 * @param {'hy'|'hy2'|'gn'} boardType
 * @returns {Sector[]} 解析失败 / 服务端报错时返回 []
 */
export function parseSectorRank(text, boardType) {
  const bt = BOARD_TYPES.has(boardType) ? boardType : 'hy';
  if (typeof text !== 'string' || !text.trim()) return [];

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (!json || typeof json !== 'object') return [];
  // 服务端错误（如 count 太大）时 code !== 0 且没有 rank_list
  const rawList = json.data && Array.isArray(json.data.rank_list) ? json.data.rank_list : null;
  if (!rawList) return [];

  // 服务端返回顺序即代码序，保持原始顺序以保证列表顺序稳定（不排序）
  const out = [];
  for (const item of rawList) {
    const s = mapSectorItem(item, bt);
    if (s) out.push(s);
  }
  indexNames(out);
  return out;
}

/**
 * 合并多页解析结果：按 code 去重，保留首次出现的顺序。
 * 供不可变合并与测试使用（fetchSectors 用可变实现插入，语义一致）。
 * @param {Array<Sector[]|Sector[][]>} pages
 * @returns {Sector[]}
 */
export function mergeSectorPages(pages) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(pages)) return out;
  for (const page of pages) {
    if (!Array.isArray(page)) continue;
    for (const it of page) {
      if (!it || typeof it !== 'object') continue;
      const code = typeof it.code === 'string' ? it.code : '';
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push(it);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 排行接口分页抓取
// ---------------------------------------------------------------------------

function rankUrl(boardType, offset) {
  const params = new URLSearchParams({
    board_type: boardType,
    sort_type: RANK_SORT_TYPE,
    direct: 'down',
    offset: String(offset),
    count: String(PAGE_SIZE),
  });
  return `${RANK_URL}?${params.toString()}`;
}

/** 分页重试：单页失败重试一次（网络抖动很常见），仍失败则抛出。 */
async function fetchRankPage(boardType, offset, { timeoutMs, signal }) {
  const key = `${boardType}:${offset}`;
  const cached = cacheGet(pageCache, key);
  if (cached) return cached;

  const url = rankUrl(boardType, offset);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(signal);
    try {
      const text = await httpGetText(url, { encoding: 'utf-8', timeoutMs, signal });
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${ERR}板块排行返回的不是合法 JSON（board_type=${boardType}, offset=${offset}）`);
      }
      if (json && json.code !== 0 && !(json.data && Array.isArray(json.data.rank_list))) {
        throw new Error(
          `${ERR}板块排行接口报错：${json.msg || '未知错误'}（board_type=${boardType}, offset=${offset}）`,
        );
      }
      const list = parseSectorRank(text, boardType);
      cacheSet(pageCache, key, list);
      return list;
    } catch (err) {
      lastErr = err;
      // 外部取消 / 超时不重试
      if (signal && signal.aborted) throw err;
      if (err && typeof err.message === 'string' && err.message.includes('超时')) throw err;
      if (attempt === 0) await sleep(200);
    }
  }
  throw lastErr;
}

/**
 * 拉取板块列表（自动分页取全量）。
 *
 * ⚠️ 分页是硬需求：排行接口 count 上限 100，超过直接报 "count too large"，
 *    所以按 offset 0/100/200... 翻页，直到某页返回条数 < 100 或为空为止，按 code 去重合并。
 *
 * 返回顺序 = 服务端 offset 顺序（稳定），**不做本地排序**，排序交给调用方。
 *
 * @param {{ boardType?: 'hy'|'hy2'|'gn', timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} [options]
 * @returns {Promise<Sector[]>}
 */
export async function fetchSectors(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const boardType = opts.boardType === undefined ? 'hy' : opts.boardType;
  if (!BOARD_TYPES.has(boardType)) {
    throw new Error(`${ERR}无效的板块类型「${String(boardType)}」，只支持 hy / hy2 / gn`);
  }
  throwIfAborted(opts.signal);

  if (!opts.noCache) {
    const cached = cacheGet(listCache, boardType);
    if (cached) return cached;
  } else {
    // 强刷：丢掉该类型的列表缓存与全部分页缓存，否则翻页仍会命中旧数据
    listCache.delete(boardType);
    for (let off = 0; off < PAGE_SIZE * MAX_PAGES; off += PAGE_SIZE) {
      pageCache.delete(`${boardType}:${off}`);
    }
  }

  const out = [];
  const seen = new Set();
  let incomplete = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const list = await fetchRankPage(boardType, offset, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });

    if (!Array.isArray(list) || list.length === 0) {
      if (page === 0) incomplete = true; // 首页就空：服务端异常或该类型无数据
      break;
    }

    for (const item of list) {
      if (seen.has(item.code)) continue;
      seen.add(item.code);
      out.push(item);
    }

    if (list.length < PAGE_SIZE) break; // 末页
  }

  if (incomplete) {
    // 首页空：不静默返回空数组（否则会被误认为"该类型没有板块"）
    throw new Error(`${ERR}板块列表为空（board_type=${boardType}），可能是接口异常或网络问题`);
  }

  indexNames(out);
  if (!opts.noCache) cacheSet(listCache, boardType, out);
  return out;
}

// ---------------------------------------------------------------------------
// 4. 板块实时行情（GBK qt 接口）
// ---------------------------------------------------------------------------

/**
 * 板块 qt 字段下标（实测 **63** 个字段，逐个下标核对过，见 CONTRACT.md）。
 *
 * 与个股布局有几处不同，别照抄 quote.js：
 *   - 板块没有买卖五档：下标 7~28 全是 "0"，第 29 位是空串；
 *   - 30 时间戳 / 31 涨跌额 / 32 涨跌幅% / 33 最高 / 34 最低 与个股一致；
 *   - 37 成交额、38 换手率%、39 市盈率、43 振幅%、44 流通市值(亿)、45 总市值(亿)、46 市净率；
 *   - 49 量比、50 年初至今%、51 5日%、52 20日%、54 60日%、61 52周%；
 *   - 58 类型（BK-HY-1 / BK-HY-2 / BK-GN / BK-GN-FG）、59 涨速 —— 比个股晚 2 位。
 * 解析时按最小长度防御，缺字段一律 null，不做越界访问。
 */
const QF = {
  name: 1,
  code: 2,
  price: 3,
  prevClose: 4,
  open: 5,
  volume: 6,
  time: 30,
  change: 31,
  changePercent: 32,
  high: 33,
  low: 34,
  amount: 37,
  turnoverRate: 38,
  pe: 39,
  amplitude: 43,
  floatCap: 44,
  totalCap: 45,
  pb: 46,
  volumeRatio: 49,
  changeYtd: 50,
  change5d: 51,
  change20d: 52,
  change60d: 54,
  stockType: 58,
  speed: 59,
  change52w: 61,
};

/**
 * 解析一行 qt 文本：`v_pt01801120="2~食品饮料~01801120~...";`
 * 不是板块行情行（例如 `v_pv_none_match="1"` 表示代码不存在）返回 null。
 * @param {string} line
 * @returns {{
 *   code: string, name: string, price: number|null, prevClose: number|null,
 *   open: number|null, high: number|null, low: number|null, change: number|null,
 *   changePercent: number|null, volume: number|null, amount: number|null,
 *   turnoverRate: number|null, amplitude: number|null, volumeRatio: number|null,
 *   speed: number|null, totalCap: number|null, floatCap: number|null,
 *   change5d: number|null, change20d: number|null, change60d: number|null,
 *   changeYtd: number|null, change52w: number|null, stockType: string, time: string
 * } | null}
 */
export function parseSectorQuoteLine(line) {
  if (typeof line !== 'string') return null;
  const s = line.trim().replace(/;$/, '');
  const m = s.match(/^v_([0-9a-zA-Z_]+)="([\s\S]*)"$/);
  if (!m) return null;
  // 板块代码大小写敏感（概念板块形如 pt02GN2287），这里必须保留原样，
  // 否则小写化后与请求侧的有序 key 对不上。
  const key = m[1];
  // 非法代码时服务端返回 v_pv_none_match="1"
  if (!/^pt/i.test(key)) return null;

  const f = m[2].split('~');
  // 防御：字段太少（不是板块行）直接 null，不做越界访问
  if (f.length < 35) return null;
  const name = (at(f, QF.name) || '').trim();
  const digits = (at(f, QF.code) || '').trim();
  if (!name && !digits) return null;

  return {
    code: key,
    name,
    // 板块点位（非价格）
    price: toNumber(at(f, QF.price)),
    prevClose: toNumber(at(f, QF.prevClose)),
    open: toNumber(at(f, QF.open)),
    high: toNumber(at(f, QF.high)),
    low: toNumber(at(f, QF.low)),
    change: toNumber(at(f, QF.change)),
    changePercent: toNumber(at(f, QF.changePercent)),
    volume: toNumber(at(f, QF.volume)),
    amount: toNumber(at(f, QF.amount)),
    turnoverRate: toNumber(at(f, QF.turnoverRate)),
    amplitude: toNumber(at(f, QF.amplitude)),
    volumeRatio: toNumber(at(f, QF.volumeRatio)),
    speed: toNumber(at(f, QF.speed)),
    totalCap: toNumber(at(f, QF.totalCap)),
    floatCap: toNumber(at(f, QF.floatCap)),
    change5d: toNumber(at(f, QF.change5d)),
    change20d: toNumber(at(f, QF.change20d)),
    change60d: toNumber(at(f, QF.change60d)),
    changeYtd: toNumber(at(f, QF.changeYtd)),
    change52w: toNumber(at(f, QF.change52w)),
    stockType: (at(f, QF.stockType) || '').trim(),
    time: (at(f, QF.time) || '').trim(),
  };
}

/**
 * 批量解析 qt 响应（纯函数，供测试）。
 * @param {string} text 已解码的 GBK 文本
 * @returns {Map<string, object>} code -> 行情
 */
function parseSectorQuoteResponse(text) {
  const map = new Map();
  if (typeof text !== 'string' || !text) return map;
  for (const chunk of text.split(';')) {
    const q = parseSectorQuoteLine(chunk);
    if (q) map.set(q.code, q);
  }
  return map;
}

/**
 * 校验并规范化一个待查板块代码（fetchSectorQuotes 用）。
 * 注意：**不能复用个股的 normalizeCode** —— 板块代码形如 pt01801120，
 * 必须原样（小写化后）传给 qt 接口，不能被当成 6 位个股代码。
 */
function toSectorKey(input) {
  if (typeof input !== 'string') return null;
  // 板块代码**大小写敏感**：概念板块形如 pt02GN2287，qt 接口用全小写会返回
  // `v_pv_none_match`。这里只补 `pt` 前缀，绝不改写用户给的大小写。
  const s = input.trim();
  if (!s) return null;
  const cand = /^pt/i.test(s) ? s : `pt${s}`;
  return SECTOR_CODE_RE.test(cand) ? cand : null;
}

/**
 * 板块实时行情（qt 接口，GBK）。
 *
 * 板块代码形如 pt01801120，与个股同一套 qt 接口但**必须原样传** —— 个股的
 * normalizeCode 会把它当非法输入丢掉，所以这里走独立逻辑。
 *
 * @param {string[]} codes
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<Array<object|null>>} 与 codes 同序，查不到的为 null
 */
export async function fetchSectorQuotes(codes, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const list = Array.isArray(codes) ? codes : typeof codes === 'string' ? [codes] : [];
  if (list.length === 0) return [];
  throwIfAborted(opts.signal);

  const keys = list.map(toSectorKey);
  const wanted = [...new Set(keys.filter((k) => k !== null))];
  if (wanted.length === 0) return keys.map(() => null);

  /** @type {Map<string, object>} */
  const found = new Map();
  for (let i = 0; i < wanted.length; i += QT_BATCH) {
    const batch = wanted.slice(i, i + QT_BATCH);
    throwIfAborted(opts.signal);
    const url = `${QT_URL}${batch.join(',')}`;
    // 板块实时行情是 GBK 编码
    const text = await httpGetText(url, {
      encoding: 'gbk',
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const parsed = parseSectorQuoteResponse(text);
    for (const [code, q] of parsed) found.set(code, q);
  }

  // 服务端回传的键大小写可能与请求不完全一致，因此做一次大小写不敏感兜底匹配。
  const lowerIndex = new Map();
  for (const [code, quote] of found) lowerIndex.set(code.toLowerCase(), quote);
  return keys.map((k) => {
    if (!k) return null;
    return found.get(k) ?? lowerIndex.get(k.toLowerCase()) ?? null;
  });
}

// ---------------------------------------------------------------------------
// 5. 单条板块
// ---------------------------------------------------------------------------

/**
 * 按板块代码（或已加载过的板块名）取列表里的单条。
 * 会拉全量列表后查找，两层缓存：列表缓存（30s）+ 单条缓存（30s）。
 *
 * 注意：如果不确定 boardType，可以逐个类型尝试（options.boardTypes）。
 *
 * @param {string} code 'pt01801120' / '01801120' / '食品饮料'
 * @param {{ boardType?: 'hy'|'hy2'|'gn', boardTypes?: Array<'hy'|'hy2'|'gn'>, timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} [options]
 * @returns {Promise<Sector|null>}
 */
export async function fetchSector(code, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const norm = normalizeSector(code);
  if (!norm) return null;

  const cacheKey = norm.code;
  if (!opts.noCache) {
    const hit = cacheGet(oneCache, cacheKey);
    if (hit) return hit;
  }

  const types = Array.isArray(opts.boardTypes) && opts.boardTypes.length ? opts.boardTypes : null;
  const order = types
    ? types.filter((t) => BOARD_TYPES.has(t))
    : opts.boardType && BOARD_TYPES.has(opts.boardType)
      ? [opts.boardType]
      : ['hy2', 'hy', 'gn'];
  if (order.length === 0) {
    throw new Error(`${ERR}无效的板块类型，只支持 hy / hy2 / gn`);
  }

  for (const boardType of order) {
    const all = await fetchSectors({
      boardType,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      noCache: opts.noCache,
    });
    const hit = all.find((s) => s.code === norm.code);
    if (hit) {
      if (!opts.noCache) cacheSet(oneCache, cacheKey, hit);
      return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 6. 便捷常量（调用方做本地排序时可用）
// ---------------------------------------------------------------------------

/** 支持的板块类型。 */
export const SECTOR_BOARD_TYPES = Object.freeze(['hy', 'hy2', 'gn']);

/** 排行接口单页上限（不可超过 100，见 PAGE_SIZE 注释）。 */
export const SECTOR_PAGE_SIZE = PAGE_SIZE;

/** 缓存有效期（毫秒）。 */
export const SECTOR_CACHE_TTL_MS = CACHE_TTL_MS;
