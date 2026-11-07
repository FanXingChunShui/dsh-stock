# dsh-stock-surf 接口契约（冻结版）

所有并行开发必须严格遵守本文件。任何签名变更必须先改本文件并在群里说明。

## 目录与职责（写作用域互不重叠）

| 文件 | 归属 | 职责 |
|---|---|---|
| `lib/quote.js` | data-source | 行情数据源：代码解析、实时快照、日K线、名称搜索。纯 Host Node，无 DSH 依赖 |
| `tests/quote.test.mjs` | data-source | `lib/quote.js` 自测 |
| `lib/score.js` | scorer | 技术指标计算 + 多因子评分引擎。**纯函数，无 IO，无网络** |
| `tests/score.test.mjs` | scorer | `lib/score.js` 自测（用合成K线） |
| `lib/config.js` `lib/rpc.js` `lib/tools.js` `index.js` `cordis.patch.yml` `package.json` `locale/*.json` | lead | Host 接线、RPC、工具、配置、清单 |
| `client.js` | ui-panel | Web UI 面板（sidebar.panellist + main） |

禁止修改不属于自己的文件。需要别人的文件变更 → 发消息给 lead。

## 环境事实（已验证）

- Node **18.20.0**（`node --version`）。无 TypeScript，无构建步骤，纯 ESM `.js` / `.mjs`。
- 全局 `fetch` 可用。`new TextDecoder('gbk')` 可用（已验证）。
- 工作目录：插件包根目录（即 `package.json` 所在目录）

## 数据源事实（已实测）

### 1. 腾讯实时快照（GBK 编码）
```
GET https://qt.gtimg.cn/q=sh600519,sz000001,sh000001
```
响应：`v_sh600519="1~贵州茅台~600519~1453.00~...";`（每行一个，`\n` 分隔，**GBK 字节**，必须 `new TextDecoder('gbk')` 解码）

字段下标（`~` 分割，下标从 0 开始；实测 `sz000001` 验证）：
- 0: 市场标志（1=沪, 51=深）
- 1: 名称
- 2: 代码
- 3: **当前价**
- 4: 昨收
- 5: 今开
- 6: 成交量（手）
- 7: 外盘
- 8: 内盘
- 9..28: 买一~买五（价,量 交替）、卖一~卖五（价,量 交替）
- 30: **时间戳 `YYYYMMDDHHMMSS`**
- 31: **涨跌额**
- 32: **涨跌幅 %**
- 33: 今日最高
- 34: 今日最低
- 35: `价格/成交量(手)/成交额(元)`
- 36: 成交量（手）
- 37: 成交额（万元）
- 38: **换手率 %**
- 39: **市盈率 TTM**
- 41: 最高
- 42: 最低
- 43: 振幅 %
- 44: 流通市值（亿元）
- 45: 总市值（亿元）
- 46: 市净率
- 47: 涨停价
- 48: 跌停价
- 49: **量比**
- 51: 均价
- 52: 市盈(动)
- 53: 市盈(静)
- 57: 名称后缀（如 `   A`，带前导空格）
- 58: 数值位（茅台为 `232.4800`，指数为 `0.0000`），**不是**类型标志
- **61: 类型标志 `GP-A`（个股）/ `ZS`（指数）/ `GP`** ← 判定 `isIndex` 用这个

> 已由 data-source 对 sh600519 / sz000001 / sh000001 / sz399001 / sz399006 五只逐一核对修正：原契约把类型标志写成 58 是错的。实现同时探测 61 与 58 兜底。

> 注意：字段数在个股/指数之间不一致（指数没有买卖五档）。**按数组长度做防御**，缺失字段返回 `null` 而不是 NaN。

### 2. 腾讯日 K 线（UTF-8 JSON，前复权）
```
GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,320,qfq
```
响应结构：
```json
{"code":0,"msg":"","data":{"sh600519":{"qfqday":[["2026-08-07","1308.660","1309.220","1315.280","1301.000","24976.000"], ...]}}}
```
每条数组字段顺序：`[日期, 开, 收, 高, 低, 成交量(手)]`（已实测验证：开1308.66 收1309.22 高1315.28 低1301.00，高>=收/开/低 成立）

> **数组长度不恒为 6**：除权日会多出第 7 位（分红对象，如 `{"nd":"2025","fh_sh":"239.57","FHcontent":"10派239.57元"}`）。解析只取前 6 位，下游不得假设 `bar.length === 6`。

坑：
- `qfqday` 键名随 `fqt` 变化；请求 qfq 时若该键不存在，回退读 `day`。
- 响应有时包在 `data[code]` 下，`code` 是带市场前缀的 `sh600519`。
- 最后一条可能是当日未收盘数据。

### 3. 名称/代码搜索（GBK）
```
GET https://smartbox.gtimg.cn/s3/?v=2&q=<urlencoded 关键词>&t=all&c=1
```
响应：`v_hint="sh~600519~贵州茅台~gzmt~GP-A^sz~000001~平安银行~payh~GP-A"`（`^` 分隔多条，`~` 分隔字段；中文为 `\uXXXX` 转义，需 `JSON.parse('"'+s+'"')` 或手动 unescape；整体 GBK 解码）
字段：`[市场, 代码, 名称, 拼音, 类型]`

> 东方财富接口在本机网络**不可用**（`curl: (52) Empty reply from server`），不要依赖。

## `lib/quote.js` 必须导出的 API（冻结）

```js
/** 规范化股票代码。接受 '600519' / 'sh600519' / 'SH600519' / '000001' / 'sz000001'。
 *  6 开头→sh，0/3 开头→sz，4/8 开头→bj，5 开头→sh（ETF）。
 *  返回 { market: 'sh'|'sz'|'bj', code: '600519', secid: 'sh600519' }，非法返回 null。 */
export function normalizeCode(input)

/** 批量实时快照。
 *  @param {string[]} codes - 已规范化或原始代码
 *  @returns {Promise<Array<Quote|null>>} 与 codes 同序；失败项为 null
 *  Quote = {
 *    code: string,          // '600519'
 *    secid: string,         // 'sh600519'
 *    market: string,        // 'sh'
 *    name: string,
 *    price: number|null, prevClose: number|null, open: number|null,
 *    high: number|null, low: number|null,
 *    change: number|null,      // 涨跌额
 *    changePercent: number|null, // 涨跌幅 %
 *    volume: number|null,      // 手
 *    amount: number|null,      // 元（由"万元"字段 ×10000 还原）
 *    turnoverRate: number|null,// 换手率 %
 *    peTtm: number|null, pb: number|null,
 *    volumeRatio: number|null, // 量比
 *    amplitude: number|null,   // 振幅 %
 *    floatCap: number|null,    // 流通市值（亿元）
 *    totalCap: number|null,    // 总市值（亿元）
 *    limitUp: number|null, limitDown: number|null,
 *    timestamp: string|null,   // 'YYYY-MM-DD HH:mm:ss'（本地时区格式化）
 *    isIndex: boolean,
 *    isSuspended: boolean      // 价格为 0 或成交量 0 且非指数
 *  }
 */
export async function fetchQuotes(codes, options = {})

/** 日 K 线（前复权，按日期升序）。
 *  @param {string} code
 *  @param {{ limit?: number, adjust?: 'qfq'|'none', timeoutMs?: number, signal?: AbortSignal }} options
 *  @returns {Promise<Array<Bar>>}
 *  Bar = { date: 'YYYY-MM-DD', open: number, close: number, high: number, low: number, volume: number }
 */
export async function fetchDailyBars(code, options = {})

/** 名称搜索。
 *  @param {string} keyword
 *  @returns {Promise<Array<{ market, code, secid, name, pinyin }>>}
 */
export async function searchSymbols(keyword)

/** 一次取齐评估所需数据。
 *  @returns {Promise<{ quote: Quote|null, bars: Bar[], warnings: string[] }>}
 */
export async function loadStockData(code, options = {})
```

要求：
- 所有网络请求必须有超时（默认 8000ms，用 `AbortSignal.timeout` 或手写 AbortController，Node 18 的 `AbortSignal.timeout` 可用）。
- 内置 30 秒内存缓存（Map，key 含 secid + 数据类型），避免面板反复刷新打爆接口。
- 失败抛 `Error`，message 形如 `astock: <具体原因>`（可读中文）。
- 不要引入任何 npm 依赖。
- 尊重传入的 `signal`（外部取消）。

## `lib/score.js` 必须导出的 API（冻结）

```js
/** 计算技术指标。纯函数。
 *  @param {Bar[]} bars - 升序日K
 *  @returns {Indicators} 见下 */
export function computeIndicators(bars)

/** 评分主入口。纯函数，绝不联网。
 *  @param {{ quote: object|null, bars: object[] }} input
 *  @returns {Evaluation} 见下 */
export function evaluateStock(input)

/** 批量评分 */
export function evaluateMany(inputs)
```

`Indicators`：
```js
{
  closes: number[],        // 收盘序列
  ma: { ma5, ma10, ma20, ma60 },   // 最新值，不足则为 null
  maSeries: { ma5: number[], ma20: number[] },
  rsi14: number|null,
  macd: { dif, dea, hist },        // 最新
  macdPrevHist: number|null,
  boll: { upper, mid, lower, percentB, bandwidth },  // 20日, 2σ
  atr14: number|null,
  atrPercent: number|null,
  volumeMa5: number|null,
  volumeMa20: number|null,
  high60: number|null, low60: number|null,
  high250: number|null, low250: number|null,
  returns: { d1, d5, d20, d60 },   // 各周期涨跌幅 %
  consecutiveUp: number, consecutiveDown: number,
  ma20SlopePercent: number|null,   // MA20 近 5 日斜率 %
  aboveMa20Days: number            // 连续站上 MA20 的天数
}
```

`Evaluation`：
```js
{
  code, secid, name,
  asOf: string,              // 数据时间
  price: number|null,
  changePercent: number|null,
  score: number,             // 0-100 总分
  verdict: 'strong-bull'|'bull'|'neutral'|'bear'|'strong-bear',
  verdictLabel: string,      // 中文：强烈看多/偏多/中性/偏空/强烈看空
  upProbability: number,     // 0-1，启发式，必须在输出中标注为启发式
  factors: [                 // 按权重降序
    { key: 'trend'|'momentum'|'volume'|'volatility'|'position'|'risk',
      label: string,         // 中文名
      score: number,         // 0-100
      weight: number,        // 权重，全部加起来 = 1
      contribution: number,  // score*weight
      signals: string[] }    // 中文可读依据，2-5 条
  ],
  levels: {
    support: number[],       // 支撑位，降序
    resistance: number[]     // 压力位，升序
  },
  risks: string[],           // 中文风险提示，可为空数组
  summary: string,           // 2-4 句中文结论
  disclaimer: string,        // 固定免责声明
  dataQuality: { bars: number, hasQuote: boolean, stale: boolean, warnings: string[] }
}
```

评分要求（scorer 自行实现，但要满足）：
- 6 个因子，权重和为 1，默认：trend 0.28 / momentum 0.22 / volume 0.18 / position 0.16 / volatility 0.10 / risk 0.06
- 数据不足（< 30 根 K 线）时降级：只用可得指标，并在 `dataQuality.warnings` 说明
- 边界：停牌、涨跌停、价格 0、K 线为空，都要返回结构完整的结果而不是抛异常
- 所有中文文案由 `score.js` 产出（Host 端直接给模型和 UI 用），不要依赖 locale

## RPC 契约（lead 实现 `lib/rpc.js`，ui-panel 直接消费）

channel：`/astock`

```js
rpc.call('/astock', endpoint, payload, signal) -> { ok: true, value } | { ok: false, error: { message } }
```

### Host 端注册方式（踩过的坑，务必照做）

```js
ctx.inject(['connection', 'webServer'], (connectionCtx) => {
  const connection = connectionCtx.connection;
  // 必须用 connection.register(ctx, channel, handler)，把 connectionCtx 传进去
  const dispose = connection.register(connectionCtx, '/astock', handler);
});
```

**不要**直接调 `connection.rpc.handle(CHANNEL, handler)`。它内部要读 `webServer`，而 `webServer` 是从调用方的注入目标上取的：

- 直接在插件 fiber 里调 → 抛 `cannot get property "webServer" without inject`（即使你已经 `inject: ['connection','webServer']`，因为读到的是错误的 ctx）
- 这个异常发生在 `apply()` 里，会被 Loader 记为 entry 未激活，表现为**面板所有请求都是 `HTTP 405` / `transport failure`**，而插件看起来「装成功了」（工具能注册、配置能读到）

诊断特征：
- 正常挂载的通道未带凭据时返回 `401`
- 未挂载的通道返回 `404`(GET) / `405`(POST)

所以「405」基本可以断定是通道压根没注册上，而不是鉴权或路径问题。

endpoints：

| endpoint | payload | value |
|---|---|---|
| `evaluate` | `{ code: string, days?: number }` | `Evaluation` |
| `batch` | `{ codes: string[] }` | `{ items: Evaluation[], errors: [{code,message}] }` |
| `quote` | `{ codes: string[] }` | `{ quotes: (Quote\|null)[] }` |
| `search` | `{ keyword: string }` | `{ results: [{secid,code,name,market}] }` |
| `watchlist` | `{}` | `{ codes: string[] }` |
| `watchlist/set` | `{ codes: string[] }` | `{ codes: string[] }` |
| `indices` | `{}` | `{ items: Quote[] }`（上证/深证/创业板） |

## Web UI 契约（ui-panel）

- 侧栏面板：`ctx.slots.register({ name: 'sidebar.panellist', id: 'astock', order: 20, label: () => t('panel'), locale: NS }, PanelIcon)`
- 主面板：`ctx.slots.register({ name: 'main', key: 'astock', locale: NS, inject: () => ({ rpc: connection.rpc, t }) }, AstockPage)`
- 必须 `ctx.slots.inject('main', ...)` 与 `ctx.slots.inject('sidebar.panellist', ...)` 包住
- 文件格式：`window.__ModuleLoader__.load({ id: 'dsh-stock-surf', factory(require) { ... return { inject: [...], apply } } })`
- 可用 `require('react')`；`@deepseek-ai/dsh-client-ui-primitives` 和 `@deepseek-ai/dsh-client-store` 要 try/catch 可选引入
- `inject` 至少 `['slots', 'locale', 'connection']`
- 样式：自己插 `<style data-plugin="dsh-astock">`（内部标识，与包名无关，不要改），用主题 CSS 变量（`--dsh-*`），不要硬编码颜色
- 文案：`locale/zh.json` / `locale/en.json` 由 lead 提供，client.js 内部也内置一份 zh/en 字典（自包含，避免加载顺序问题）

---

# v2 追加：板块（Sector）功能

## 数据源事实（已实测 2026-11-07）

### 1. 板块排行列表（UTF-8 JSON，腾讯 proxy）
```
GET https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank
    ?board_type=<hy|hy2|gn>&sort_type=price&direct=down&offset=<n>&count=<≤100>
```
- `board_type`：`hy` 一级行业（31 条）、`hy2` 二级行业（124 条）、`gn` 概念（500 条）
- **`count` 上限 100**，超过返回 `data` 为空 → 必须分页。`offset` 翻页不重复。
- **`sort_type` 只有 `price` / `speed` / `turnover` / `volume` 有效，且返回值并非按该字段排序**（实测 `price` 返回的是行业代码序）。其余值（`zdf`/`zf`/`hsl`/`lb`/`zsz`/`ltsz`）返回空列表。
  → **排序一律在本地做**，不要依赖服务端排序。
- 响应结构：`{ code: 0, msg: "ok", data: { rank_list: [ ... ] } }`

单条 `rank_list[i]` 字段（全部为字符串，需自行转数字）：
| 字段 | 含义 |
|---|---|
| `code` | 板块代码，如 `pt01801120` |
| `name` | 板块名，如 `食品饮料` |
| `stock_type` | `BK-HY-1` / `BK-HY-2` / `BK-GN-FG` |
| `zxj` | 最新点位（板块指数点位，非价格） |
| `zd` | 涨跌额 |
| `zdf` | **当日涨跌幅 %** |
| `zdf_d5` / `zdf_d20` / `zdf_d60` | 5/20/60 日涨跌幅 % |
| `zdf_w52` / `zdf_y` | 52 周 / 年初至今涨跌幅 % |
| `hsl` | 换手率 % |
| `lb` | 量比 |
| `speed` | 涨速 |
| `zsz` / `ltsz` | 总市值 / 流通市值（亿元） |
| `zgb` | 涨跌家数，格式 `"24/122"`（上涨/下跌） |
| `zljlr` | 主力净流入（万元） |
| `zljlr_d5` / `zljlr_d20` | 5/20 日主力净流入（万元） |
| `zllr` / `zllc` | 主力流入 / 流出（万元） |
| `lzg` | 领涨股 `{ code, name, zxj, zd, zdf }` |

### 2. 板块实时行情（GBK，腾讯 qt）
```
GET https://qt.gtimg.cn/q=pt01801120,pt02031283
```
板块代码可直接用个股同一套接口，字段布局一致：下标 1 名称、3 最新、4 昨收、5 今开、30 时间戳、31 涨跌额、32 涨跌幅%、33 最高、34 最低。板块无买卖五档，必须按长度防御。

### 3. 板块日 K —— **不可用**
```
GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=pt01801120,day,,,320,qfq
```
无论 `limit` 给多少，**始终只返回 1 条**（当日）。`kline/kline` 与不带 `qfq` 均同样失败。
→ **板块无法计算需要历史序列的技术指标**（MA/RSI/MACD/BOLL/ATR）。

## 板块评估的设计决定

因为没有板块历史 K 线，**板块评分不复用 `evaluateStock`**（它需要 `bars`），而是用排行接口自带的截面数据做一个**独立的 5 因子板块评分**，明确标注数据基础不同：

| 因子 | 权重 | 依据字段 |
|---|---|---|
| 短期动量 momentum | 0.30 | `zdf`、`zdf_d5` |
| 中期趋势 trend | 0.25 | `zdf_d20`、`zdf_d60`、`zdf_y` |
| 资金流 capital | 0.20 | `zljlr`、`zljlr_d5`、`zljlr_d20` |
| 活跃度 activity | 0.15 | `lb`、`hsl`、`speed` |
| 广度 breadth | 0.10 | `zgb` 上涨/下跌家数比、`lzg.zdf` |

- 权重和必须 = 1，分数 0-100，边界（字段缺失/为 0/无领涨股）要稳定降级到 50 分中性而不抛异常
- 输出结构复用与 `Evaluation` 相同的骨架，但加 `kind: 'sector'`，且 `dataQuality.fundamentals: 'cross-sectional'` 说明数据基础
- **不要**输出 support/resistance（板块无 K 线，算不出来），该字段给 `{ support: [], resistance: [] }`
- `upProbability` 同样必须是启发式，`summary`/`disclaimer` 必须标注

---

# v3 追加：多市场（港股/美股）+ 股票列表 Tab + 自选增强

## 数据源事实（已实测 2026-11-07）

### 1. 多市场实时快照（GBK，同一 qt 接口）
```
GET https://qt.gtimg.cn/q=sh600519,hk00700,usAAPL
```
- **港股**：`hk00700`（5 位数字代码，前导零保留）
- **美股**：`usAAPL`（字母代码，**不要带后缀**；`usAAPL.OQ` 会返回 `v_pv_none_match`）。响应第 2 位返回真实代码 `AAPL.OQ`
- **指数**：`hkHSI`（恒生指数）、`usDJI`（道琼斯）、`usIXIC`（纳斯达克）

字段布局与 A 股**不同**，以 `hk00700` 为例（`~` 分割，下标 0 起）：
| 下标 | 含义 |
|---|---|
| 0 | 市场标志：`1`=沪 `51`=深 `100`=港股 `200`=美股 |
| 1 | 名称 |
| 2 | 代码（港股 5 位；美股带后缀 `AAPL.OQ`） |
| 3 | 现价 |
| 4 | 昨收 |
| 5 | 今开 |
| 6 | 成交量 |
| **30** | **时间戳**：港股 `2026/11/06 16:08:54`、美股 `2026-11-06 16:00:01` —— **与 A 股的 `20261106150258` 格式完全不同，必须多格式解析** |
| 31 | 涨跌额 |
| 32 | 涨跌幅 % |
| 33 | 最高 |
| 34 | 最低 |
| **35** | **美股是货币 `USD`**（A 股此位是 `价格/量/额` 串） |
| 45 | 总市值 |
| 46 | 名称（英文，美股） |

> ⚠️ 港美股的字段偏移与 A 股**不重叠**，不能用现有 `parseQuoteLine` 硬套。必须按市场标志分支解析。

### 2. 多市场日 K（UTF-8 JSON）
| 市场 | URL |
|---|---|
| 港股 | `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hk00700,day,,,320,qfq` |
| 美股 | `https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=usAAPL.OQ,day,,,320,qfq` |
| A 股 | `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,320,qfq` |

- 三者都能取到 320 根，结构一致：`data[<secid>].qfqday` = `[日期, 开, 收, 高, 低, 成交量]`
- **美股 URL 里的代码必须带后缀**（`usAAPL.OQ`），而快照接口必须是 `usAAPL` —— 两者不一致，需先取快照拿到后缀再用
- 港股 K 线数组**可能是 8 位**（第 7 位是分红对象、第 8 位是换手率），解析只取前 6 位

### 3. 搜索（GBK，已支持港美股）
`https://smartbox.gtimg.cn/s3/?v=2&q=<关键词>&t=all&c=1`
返回 `v_hint="市场~代码~名称~拼音~类型^..."`，实测已能返回：
- `hk~00700~腾讯控股~txkg~GP`
- `us~tcehy.ps~腾讯控股(adr)~txkgadr~GP`
- `us~tme.n~腾讯音乐~txyl~GP`

类型后缀含义：`GP`=股票、`ZS`=指数、`QZ`=权证、`GP-A`=A股

### 4. 股票列表（用于「股票列表」Tab）
复用现有搜索接口按关键词检索，或按市场列出热门标的。**没有**官方的「全市场股票列表」免费接口，因此列表页采用：
- 默认展示各市场**热门/关注度前列**的固定种子列表（由配置提供）
- 支持关键词搜索后加入列表
- 每行显示：代码、名称、市场、现价、涨跌幅、评分、是否在自选

## 多市场设计决定

### 代码规范化 `normalizeCode` 扩展
```js
// 返回值增加 market 枚举与 secid 规则
// market: 'sh'|'sz'|'bj'|'hk'|'us'
//  - A 股：secid = 'sh600519'（保持现有行为）
//  - 港股：secid = 'hk00700'（5 位，补前导零）
//  - 美股：secid = 'usAAPL'（大写字母，去掉 .OQ/.N 等后缀）
// 返回增加 { marketLabel: '沪A'|'深A'|'北交所'|'港股'|'美股', currency: 'CNY'|'HKD'|'USD' }
```

### 评分复用
港美股**有完整日 K**，因此直接复用现有 `evaluateStock({ quote, bars })`，不需要新评分引擎。
但必须在 `dataQuality` 里标注市场，且 `Evaluation` 增加 `market` 字段。

### 自选股「位置模糊」问题（用户反馈）
用户反馈「加自选 位置模糊」。经核实是指**自选股按钮位置不清晰/不易发现**，不是代码 bug。
设计改动：
1. 个股详情卡右上角增加明确的「加入自选 / 已在自选」按钮（带图标与状态），不再只有行内小图标
2. 股票列表每行右侧增加 +/✓ 快捷加自选按钮
3. 已在自选时按钮变为实心并显示「已在自选」，点击可从自选移除
4. 所有加/移自选操作给 toast 反馈
