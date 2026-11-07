/**
 * dsh-astock 分红送配（派息 / 送股 / 转增）数据层。
 *
 * 用途：lib/adjust.js 要自建前复权，就需要知道「每个除权日每股派了多少现金、
 *       送转了多少股份」。现成的复权 K 线要么字段不全、要么口径不可控，
 *       所以这里只负责把原始分红方案抓准，复权换算交给 adjust.js。
 *
 * 数据源（实测确认，见 DATA-SOURCES.md）：
 *   https://vip.stock.finance.sina.com.cn/corp/go.php/vISSUE_ShareBonus/stockid/{6位代码}.phtml
 *
 *   · GBK 编码 HTML。必须 TextDecoder('gbk')，按 UTF-8 解会得到乱码，
 *     而乱码不会让任何字段解析「报错」，只会让进度列永远不等于「实施」，
 *     最终表现为「这只股票没有分红」——错误被静默吞掉，所以编码不能想当然。
 *   · 只要 6 位裸代码，sh600519 / sz000002 必须去掉交易所前缀。
 *   · 无效代码同样返回 HTTP 200（表格里是一行「暂时没有数据！」占位），
 *     所以「代码不存在」和「确实没分红」在 HTTP 层无法区分，
 *     只能落到表格内容层判断，这直接决定了本模块的错误语义（见下）。
 *   · ⚠️ 接口只认 6 位数字，**不区分市场**。而指数与个股共用同一段代码空间
 *     （sh000001 上证指数 与 sz000001 平安银行 都是 000001），
 *     所以把指数代码传进来会拿到同号个股的分红（实测 sh000001 返回平安银行 30 条）。
 *     本模块无法从接口侧辨别，调用方只应传个股 secid；复权本来也只对个股有意义。
 *
 * HTML 结构：
 *   页面里有**两个**表格，是这里最容易踩的坑：
 *     id="sharebonus_1"  分红送配，9 列  ← 本模块唯一目标
 *     id="sharebonus_2"  配股，11 列     ← 与复权无关，绝不能混进来
 *   因此截取范围必须精确锚定 sharebonus_1 的起始标签，并在它自己的 </table> 截止
 *   （分红表内部没有嵌套 table，实测 18 只股票、646 行均确认）。
 *
 *   列序（实测 100% 稳定为 9 列）：
 *     [0] 公告日期        YYYY-MM-DD
 *     [1] 送股(股)        每 10 股
 *     [2] 转增(股)        每 10 股
 *     [3] 派息(税前)(元)  每 10 股
 *     [4] 进度            实施 / 预案 / 不分配 / 取消
 *     [5] 除权除息日      YYYY-MM-DD；方案未落地时为 '--'
 *     [6] 股权登记日
 *     [7] 红股上市日
 *     [8] 查看详细（超链接）
 *
 * 为什么只保留「实施」：
 *   「预案」只是董事会提议，可能被股东大会否决或修改，真正影响除权价的是最终实施方案；
 *   「不分配」既无现金流也无股份变动；「取消」更不该参与计算。
 *   把它们算进复权因子会让历史价格系统性偏移，而复权错误是**静默**的
 *   ——不报错、不可见，只会让 MA/RSI/MACD 全部偏掉，进而污染评分。
 *   所以这里宁可少算不可多算：只认「实施」。
 *
 * 为什么同一除权日必须合并：
 *   600519 在 2006-05-19 有两条「实施」记录（2006-05-15 公告派息 3 元/10 股、
 *   2006-05-17 公告转增 10 股/10 股），是同一天执行的两套方案。
 *   adjust.js 按除权日逐日乘因子，同日出现两条事件时，要么被重复累乘、要么被漏掉一条，
 *   两种结果都错。这里把它们合并成一条（送股/转增/派息各自相加），保证 exDate 唯一。
 *
 * 缓存策略：
 *   分红送配是已经发生的历史事实，一家公司一年最多变动一两次，
 *   因此用 6 小时 TTL——远长于行情快照的 30 秒，避免复权计算反复打新浪。
 *   只缓存成功的结果（含「确实没有实施记录」），网络失败不缓存，下次仍会重试。
 *
 * 冻结导出：fetchBonusEvents / parseBonusHtml
 * 额外导出（便于测试与手动刷新）：clearBonusCache
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const BONUS_URL =
  'https://vip.stock.finance.sina.com.cn/corp/go.php/vISSUE_ShareBonus/stockid/';

const DEFAULT_TIMEOUT_MS = 8000;

/** 分红是历史事实，6 小时足以覆盖盘中新发布的实施公告，又能免掉重复抓取。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const ERR = 'astock: ';

/**
 * 通用浏览器 UA。新浪部分节点对无 UA 或不常见 UA 的请求返回空响应体，
 * 带上一个常规 UA 才稳定拿到 HTML。这里是公开的浏览器标识串，不带任何身份信息。
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 只认「实施」，其余进度一律丢弃（理由见文件头）。 */
const PROGRESS_IMPLEMENTED = '实施';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 数组第 i 项，越界返回 undefined。 */
function at(arr, i) {
  return i < arr.length ? arr[i] : undefined;
}

/**
 * 转数字。分红方案里「不送不转不派」写作 '0'，缺省列写作 '--' 或空串。
 * 对送股/转增/派息而言，「没写」和「0」是同一件事，所以统一返回 0 而不是 null，
 * 这样 adjust.js 不必再判空；非法值也退化成 0，宁可当没有分红也不让复权因子变成 NaN。
 */
function bonusNum(raw) {
  if (raw === undefined || raw === null) return 0;
  const s = String(raw).trim();
  if (s === '' || s === '-' || s === '--') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** 浮点相加会攒误差（如 0.1+0.2），保留 6 位小数对「每 10 股」的量级足够。 */
function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

/** 最简 HTML 实体解码。实测页面里只有 &nbsp;，但顺手覆盖常见的几个。 */
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x0*27;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * 单元格取纯文本。原始单元格里可能夹 <a>/<span>/<strong> 等标签，
 * 也可能有换行与制表符，统一剥掉再 trim。
 */
function cellText(raw) {
  if (!raw) return '';
  const stripped = String(raw).replace(/<[^>]*>/g, '');
  return decodeEntities(stripped).replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * 构造带元信息的空结果数组。
 *
 * 契约要求失败时返回空数组而不是抛异常（复权会自动降级），
 * 但调用方仍需要能区分「网络挂了」和「这只股票确实没分红」——
 * 前者应该提示用户或重试，后者是正常数据。把标记挂在数组上而不是
 * 改返回结构，是为了让 `Promise<Array<...>>` 的签名保持冻结不变；
 * 属性声明为非枚举，因此 JSON.stringify、deepStrictEqual、展开运算都不受影响。
 *
 * @param {boolean} ok
 * @param {'empty'|'network'|'aborted'|'parse'|'unsupported'} reason
 * @param {string} [detail]
 */
function emptyResult(ok, reason, detail) {
  const arr = [];
  Object.defineProperty(arr, 'ok', { value: ok, enumerable: false });
  Object.defineProperty(arr, 'reason', { value: reason, enumerable: false });
  if (detail) Object.defineProperty(arr, 'detail', { value: detail, enumerable: false });
  return arr;
}

/** 给已有数组补上元信息（解析成功但结果为空时用）。 */
function tagResult(arr, ok, reason, detail) {
  Object.defineProperty(arr, 'ok', { value: ok, enumerable: false });
  Object.defineProperty(arr, 'reason', { value: reason, enumerable: false });
  if (detail) Object.defineProperty(arr, 'detail', { value: detail, enumerable: false });
  return arr;
}

/**
 * 从 secid 里取 6 位裸代码：'sh600519' / 'SH600519' / '600519' → '600519'。
 * 港股美股没有这个分红接口，返回 null 由调用方降级。
 */
function bareCode(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  const m = s.match(/^(?:sh|sz|bj)?(\d{6})$/);
  return m ? m[1] : null;
}

/** 合并外部 signal 与超时 signal。与 lib/quote.js 保持同一套语义。 */
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

/** 统一 GET + 解码。分红页固定 GBK。 */
async function httpGetText(url, opts = {}) {
  const { encoding = 'gbk', timeoutMs, signal } = opts;
  const guard = withTimeout(signal, timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, {
        signal: guard.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
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

    // 新浪分红页声明 charset=gbk，中文进度列靠这里才解得对。
    return new TextDecoder(encoding).decode(buf);
  } finally {
    guard.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 缓存（6 小时 TTL 内存 Map，按 6 位代码）
// ---------------------------------------------------------------------------

/** code -> { at: number, value: BonusEvent[] } */
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
  // 顺手清理过期项，避免长驻进程无限增长。
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.at > CACHE_TTL_MS) cache.delete(k);
    }
  }
  return value;
}

/** 清空缓存（测试与手动刷新用）。 */
export function clearBonusCache() {
  cache.clear();
}

// ---------------------------------------------------------------------------
// parseBonusHtml（纯函数）
// ---------------------------------------------------------------------------

/**
 * 解析新浪分红送配页面 HTML。
 *
 * 纯函数：不做任何 IO，同样的输入永远得到同样的输出，方便单测与离线回归。
 *
 * @param {string} html GBK 已解码后的 HTML 文本
 * @returns {Array<{annDate: string|null, exDate: string, song: number, zhuan: number, pai: number, progress: string}>}
 *   仅含 progress === '实施' 且 exDate 为合法 YYYY-MM-DD 的记录，按 exDate 升序。
 *   返回数组上挂非枚举属性 hasTable（boolean），用于区分「页面里根本没找到分红表」
 *   与「有表但没有符合条件的记录」——前者说明页面结构变了或拿到的不是目标页，
 *   属于异常；后者是正常的「该股无分红」。
 */
export function parseBonusHtml(html) {
  if (typeof html !== 'string' || html === '') {
    return tagResult([], false, 'parse', '输入为空或非字符串');
  }

  // 精确锚定分红表起始标签：id 可能用单引号或双引号，前面可能还有别的属性。
  const startMatch = html.match(/<table[^>]*\bid\s*=\s*["']sharebonus_1["'][^>]*>/i);
  if (!startMatch) {
    // 找不到表：可能是页面改版，也可能命中了错误页面。
    // 这里返回 ok=false，绝不装作「没有分红」，否则复权会静默少算。
    return tagResult([], false, 'parse', '页面中未找到 id="sharebonus_1" 的分红表');
  }

  const startIdx = startMatch.index;
  // 分红表内部没有嵌套 <table>（实测确认），所以第一个 </table> 就是它的结束。
  // 必须在这里截止，否则会把后面的配股表 sharebonus_2（11 列）一起吞进来。
  const endIdx = html.indexOf('</table>', startIdx);
  const segment = endIdx < 0 ? html.slice(startIdx) : html.slice(startIdx, endIdx);

  const events = [];

  // 逐行提取。原始 HTML 用 <tr> 不带属性，但留 [^>]* 兼容将来加样式。
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(segment)) !== null) {
    const rowHtml = rowMatch[1];
    if (!/<td\b/i.test(rowHtml)) continue; // 表头行只含 <th>

    const cells = [];
    const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(cellText(cellMatch[1]));
    }

    // 「暂时没有数据！」是一行 colspan='9' 的占位，只有 1 个 td；
    // 不完整行同样跳过。正常数据行恒为 9 个 td，这里放宽到 6 只取前 6 列，
    // 这样将来页面末尾追加列也不会把整张表解析空。
    if (cells.length < 6) continue;

    const annDate = at(cells, 0) ?? '';
    const song = bonusNum(at(cells, 1));
    const zhuan = bonusNum(at(cells, 2));
    const pai = bonusNum(at(cells, 3));
    const progress = at(cells, 4) ?? '';
    const exDate = at(cells, 5) ?? '';

    // 只要「实施」：预案/不分配/取消都不影响真实除权价。
    if (progress !== PROGRESS_IMPLEMENTED) continue;

    // 除权日必须是确定的日期。未落地的方案这里是 '--'，
    // 这种记录无法定位到 K 线某一根，拿去做复权只会出错。
    if (!DATE_RE.test(exDate)) continue;

    events.push({
      annDate: DATE_RE.test(annDate) ? annDate : null,
      exDate,
      song,
      zhuan,
      pai,
      progress,
    });
  }

  // 同一除权日可能有多条实施记录（600519 的 2006-05-19 就是派息 + 转增两笔）。
  // 按除权日合并，保证 adjust.js 看到的 exDate 唯一，避免重复累乘或漏乘。
  const byExDate = new Map();
  for (const ev of events) {
    const prev = byExDate.get(ev.exDate);
    if (!prev) {
      byExDate.set(ev.exDate, { ...ev });
      continue;
    }
    prev.song = round6(prev.song + ev.song);
    prev.zhuan = round6(prev.zhuan + ev.zhuan);
    prev.pai = round6(prev.pai + ev.pai);
    // 公告日取更早的那一次：合并后这条记录代表「该除权日的全部方案」，
    // 最早公告日才是这套方案对外披露的起点。
    if (ev.annDate && (!prev.annDate || ev.annDate < prev.annDate)) prev.annDate = ev.annDate;
  }

  const merged = [...byExDate.values()];
  // 升序：adjust.js 从最早除权日往后乘因子，顺序错了因子的作用区间就错了。
  merged.sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0));

  return tagResult(merged, true, merged.length === 0 ? 'empty' : 'ok');
}

// ---------------------------------------------------------------------------
// fetchBonusEvents
// ---------------------------------------------------------------------------

/**
 * 抓取并解析某只 A 股的分红送配事件。
 *
 * 失败时**不抛异常**、返回空数组：复权链路会照常跑，只是少了除权修正。
 * 为了不让「网络故障」被误读成「这只股票不分红」，返回的数组上挂了两个
 * 非枚举属性：
 *   result.ok     boolean  本次取数是否成功（false 表示网络/解析异常，可重试）
 *   result.reason 'empty' | 'network' | 'aborted' | 'parse' | 'unsupported'
 *   result.detail 可选，原始错误信息
 * 正常有记录时 ok=true、reason='ok'。
 *
 * @param {string} secid 'sh600519' / 'sz000002' / '600519'
 *   ⚠️ 只应传**个股**代码。接口不支持港股美股（返回 reason='unsupported'），
 *   且不区分市场——传指数代码（如 sh000001）会拿到同号个股的分红，本模块无法识别。
 * @param {{ timeoutMs?: number, signal?: AbortSignal, noCache?: boolean }} [options]
 * @returns {Promise<Array<{annDate: string|null, exDate: string, song: number, zhuan: number, pai: number, progress: string}>>}
 */
export async function fetchBonusEvents(secid, options = {}) {
  const { timeoutMs, signal, noCache = false } = options;

  const code = bareCode(secid);
  if (!code) {
    // 港股/美股/指数没有这个分红接口，属于能力边界而不是故障。
    return emptyResult(false, 'unsupported', `不支持的分红查询代码：${String(secid)}`);
  }

  if (!noCache) {
    const hit = cacheGet(code);
    if (hit) return hit;
  }

  const url = `${BONUS_URL}${code}.phtml`;

  let html;
  try {
    html = await httpGetText(url, { encoding: 'gbk', timeoutMs, signal });
  } catch (err) {
    // 网络失败不写缓存：下次调用应该重试，而不是把故障固化 6 小时。
    const reason = signal && signal.aborted ? 'aborted' : 'network';
    return emptyResult(false, reason, err && err.message ? err.message : String(err));
  }

  const events = parseBonusHtml(html);

  if (!events.ok) {
    // 拿到了 HTTP 200 但没有分红表：页面结构变了或被劫持。
    // 宁可报异常也不上报「无分红」，否则复权会静默漏算。
    return emptyResult(false, 'parse', events.detail);
  }

  // 解析成功才缓存，包括「确实没有实施记录」这一正常结果。
  return cacheSet(code, events);
}
