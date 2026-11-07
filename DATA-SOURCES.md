# 开源数据源调研报告

> 调研时间：2026-11-07　调研方式：Node 全局 fetch 直连各接口
> 方法：全部结论来自**本机真实请求**，不是文档摘抄。不可达的一律标注为「不可用」，不做推测。

## 一、结论速览

| 市场 | 推荐主源 | 备源 | 现状 |
|---|---|---|---|
| **A 股** | 腾讯 `qt.gtimg.cn`（快照） | 新浪 `quotes.sina.cn`（K 线） | ⚠️ 腾讯 K 线被 WAF 拦截，必须走新浪 |
| **港股** | 腾讯 `qt.gtimg.cn` + `hkfqkline` | 无可用备源 | ✅ 快照与 K 线都正常 |
| **美股** | 腾讯 `qt.gtimg.cn`（快照） | **新浪美股 K 线（含 1984 年至今全历史）** | ✅ 两家都正常 |

**核心结论：三个市场可以用不同数据源，而且现在就必须分开用**——因为腾讯的 A 股 K 线接口已被 WAF 封禁（HTTP 501），而港美股接口正常。

---

## 二、逐源实测结果

### 2.1 A 股

| 源 | 接口 | 状态 | 实测数据 |
|---|---|---|---|
| 腾讯 | `qt.gtimg.cn/q=sh600519` | ✅ 200 | 539 字节，88 字段，GBK |
| 腾讯 | `web.ifzq.gtimg.cn/.../fqkline/get` | ❌ **501 WAF** | 返回 `waf.tencent.com/501page.html` 跳转页 |
| 新浪 | `quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData` | ✅ 200 | 320 根，35844 字节，字段 `day,open,high,low,close,volume` |
| 同花顺 | `d.10jqka.com.cn/v6/line/hs_600519/01/last.js` | ✅ 200 | 11784 字节，JSONP，含 2001 年至今年度统计 + 当日序列 |
| 网易 | `quotes.money.163.com/service/chddata.html` | ❌ 502 | nginx Bad Gateway |
| 东方财富 | `push2.eastmoney.com` | ❌ 不可达 | `fetch failed`（IPv6 解析问题，Node 侧同样失败） |
| 雪球 | `stock.xueqiu.com/v5/stock/chart/kline.json` | ❌ 400 | 需要登录 Cookie（`error_code: 400016`） |

**腾讯 A 股 K 线 501 详情**（这是本次最重要的发现）：

```html
<!DOCTYPE html><html><head><script>
  window.location.href="https://waf.tencent.com/501page.html?u=...&id=e384619ecd109e56..."
</script>
```

不是限流，是 WAF 拦截页。实测持续 20+ 分钟未恢复，三个不同 A 股代码（`sh600519` / `sh000001` / `sz000001`）全部 501。

### 2.2 港股

| 源 | 接口 | 状态 | 实测数据 |
|---|---|---|---|
| 腾讯 | `qt.gtimg.cn/q=hk00700` | ✅ 200 | 433 字节，GBK，字段布局与 A 股不同 |
| 腾讯 | `hkfqkline/get?param=hk00700,day,,,320,qfq` | ✅ 200 | **320 根**，58071 字节 |
| 新浪 | `HK_StockService.getDayKLine` | ❌ Service not found | 接口已下线 |
| 新浪 | `finance.sina.com.cn/.../klc_kl.js` | ❌ 404 | 旧接口已移除 |
| 阿斯达克 | `aastocks.com` | ⚠️ 200 但需解析 HTML | 215KB 页面，非 API |
| 港交所 | `hkex.com.hk` | ❌ 404 | 无公开日行情 API |

**港股结论：腾讯是唯一可靠源**，没有可用备源。这是单点风险。

港股 K 线数组是 **8 位**（A 股是 6 位）：
```json
["2026-11-02","387.600","392.200","397.600","384.600","22621767.000",{},"0.250","888121.441"]
   日期        开        收        高        低        成交量          分红对象  换手   成交额
```

### 2.3 美股

| 源 | 接口 | 状态 | 实测数据 |
|---|---|---|---|
| 腾讯 | `qt.gtimg.cn/q=usAAPL` | ✅ 200 | 779 字节，GBK |
| 腾讯 | `usfqkline/get?param=usAAPL.OQ,day,,,320,qfq` | ✅ 200 | 320 根，22817 字节 |
| **新浪** | `US_MinKService.getDailyK?symbol=AAPL` | ✅ 200 | **10070 条，从 1984-09-07 至今** |
| 新浪 | `hq.sinajs.cn/list=gb_aapl` | ❌ 403 | Forbidden |
| Yahoo | `query1.finance.yahoo.com/v8/finance/chart` | ❌ 超时 | `fetch failed`（10 秒无响应） |
| Stooq | `stooq.com/q/d/l/?s=aapl.us` | ❌ 403 | 反爬 |
| 富途 | `futunn.com/quote-api` | ❌ 404 | 需签名 |
| 老虎/雪球 | `xueqiu.com/v5/stock/quote.json` | ❌ 400 | 需登录 |

**新浪美股 K 线是被严重低估的宝藏**：免费、无需 key、无分页限制、给全历史。

实测覆盖：
```
AAPL  10070 条  1984-09-07 → 2026-11-06
MSFT   9688 条  末 2026-11-06  close=530.61
NVDA   5802 条  末 2026-11-06  close=186.64
BABA   3052 条  末 2026-11-06  close=109.45
TSLA   3941 条  末 2026-11-06  close=358.22
```

字段：`d` 日期、`o` 开、`h` 高、`l` 低、`c` 收、`v` 成交量、**`a` 成交额**（腾讯美股 K 线没有成交额）。

---

## 三、开源库评估

这些库本身是 Python，我们只关心**它们的底层数据源是否可用**（JS 插件不能直接调 Python 库，但可以复刻其接口）。

| 库 | 底层源 | 本机可用性 | 能否用于本插件 |
|---|---|---|---|
| [akshare](https://github.com/akfamily/akshare) | 东财、新浪、腾讯等聚合 | ⚠️ 东财部分不可达，新浪/腾讯可用 | 可作为**接口清单参考**，不直接依赖 |
| [efinance](https://github.com/micro-sheep/efinance) | 东方财富 | ❌ 东财本机不可达 | 不可用 |
| [baostock](https://github.com/baostock/baostock) | 自有 socket 服务器 | ⚠️ 需 Python socket，HTTP 无法测 | 引入 Python 依赖，与零依赖目标冲突 |
| [tushare](https://tushare.pro) | 自有 API | ⚠️ 需 token（`40101 不是合格的json格式`） | 需注册 + 积分门槛 |
| [yfinance](https://github.com/ranaroussi/yfinance) | Yahoo Finance | ❌ Yahoo 本机超时 | 不可用 |
| [pytdx](https://github.com/rainx/pytdx) | 通达信行情服务器 | ⚠️ 需 TCP socket + 服务器列表 | 需 Python/长连接，不适合插件 |
| pandas-datareader | 多源封装 | ❌ 依赖 Yahoo/Stooq 等，均已不可达 | 不可用 |

**关键判断**：本机网络环境下，**所有国外源（Yahoo / Stooq）都不可达**，所以 yfinance、pandas-datareader 这条路直接排除。国内源里东财也不可达。真正能用的只有 **腾讯 + 新浪 + 同花顺**。

---

## 四、推荐方案

### 4.1 分市场选源（按你提出的「不同市场用不同源」）

```
A 股
  快照  → 腾讯 qt.gtimg.cn        （88 字段，含 PE/PB/量比/涨跌停价）
  K 线  → 新浪 quotes.sina.cn      （腾讯已被 WAF 封，必须用新浪）
  列表  → 新浪 Market_Center       （5578 只全量，56 页并发 1.6 秒）

港股
  快照  → 腾讯 qt.gtimg.cn        （唯一可用）
  K 线  → 腾讯 hkfqkline          （唯一可用，320 根）
  列表  → 新浪 getHKStockData     （仅 60 只，源上限）

美股
  快照  → 腾讯 qt.gtimg.cn        （字段含货币、市值）
  K 线  → 新浪 US_MinKService     ★ 主选：全历史 + 成交额
        → 腾讯 usfqkline          备选：320 根，无成交额
  列表  → 无免费全量源，种子 + 搜索
```

### 4.2 为什么美股主选新浪而不是腾讯

| 维度 | 新浪 | 腾讯 |
|---|---|---|
| 历史深度 | **10070 条（1984 起）** | 320 条 |
| 成交额字段 | ✅ 有（`a`） | ❌ 无 |
| 复权 | 未复权 | **前复权** ✅ |
| 稳定性 | 未知（本次新发现） | 已验证 |

腾讯的优势是**前复权**，对技术指标更准确。建议：**腾讯优先，新浪兜底**——与现在 A 股的策略一致。若腾讯某天也被封，新浪能立刻接上。

### 4.3 需要立刻做的加固

1. **A 股 K 线已实现新浪回退**（上一轮已修），但只对 `HTTP 501` 触发，建议把判定放宽到「非 200 或响应体含 `waf.tencent.com`」。
2. **港股是单点风险**：腾讯一旦像 A 股一样被封，港股功能全废。建议把新浪 `US_MinKService` 的思路反向试一下港股是否有对应接口（本次未找到），或接受该风险。
3. **美股建议加新浪备源**：`US_MinKService.getDailyK` 已验证可用且数据更全，值得接入作为腾讯的兜底。

---

## 五、实测命令（可复现）

```bash
# A 股快照（腾讯，可用）
curl -s 'https://qt.gtimg.cn/q=sh600519' | iconv -f GBK -t UTF-8

# A 股 K 线（腾讯，当前 501 WAF）
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,320,qfq'

# A 股 K 线（新浪，可用）
curl -s 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sh600519&scale=240&ma=no&datalen=320'

# 港股（腾讯，可用）
curl -s 'https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hk00700,day,,,320,qfq'

# 美股（腾讯，可用）
curl -s 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=usAAPL.OQ,day,,,320,qfq'

# 美股全历史（新浪，可用）
curl -s 'https://stock.finance.sina.com.cn/usstock/api/json_v2.php/US_MinKService.getDailyK?symbol=AAPL&_=1'

# 以下均不可用，仅供对照
curl -s -m 10 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d'   # 超时
curl -s -m 10 'https://stooq.com/q/d/l/?s=aapl.us&i=d'                             # 403
curl -s -m 10 'https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519'        # 不可达
```

---

## 六、风险与局限

1. **所有源都是非官方公开接口**，没有 SLA，随时可能改版或封禁。A 股的 501 就是活证据。
2. **WAF 封禁是服务端行为**，可能自动解除也可能长期持续，不能依赖。
3. 本次调研只测了**可达性**，未测**长期频率限制**。高频调用（如列表页 100 只并发评分）可能触发限流，需要缓存兜底。
4. 港股无备源是**已知单点风险**，若腾讯封港股，该市场功能会整体失效。
5. 国外源（Yahoo/Stooq）在本机网络不可达，**换网络环境（如海外 VPS）结论可能不同**。
