/**
 * lib/quote.js 自测。
 * 第一部分：纯解析函数（喂原始响应文本，不联网）。
 * 第二部分：联网冒烟测试（网络失败时 skip，不 fail）。
 *
 * 运行：node --test tests/quote.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCode,
  fetchQuotes,
  fetchDailyBars,
  searchSymbols,
  loadStockData,
  clearCache,
  parseQuoteLine,
  parseQuoteResponse,
  parseKlineResponse,
  parseSinaKlineResponse,
  parseSinaUsKlineResponse,
  parseSinaTimedKlineResponse,
  fetchMinuteBars,
  parseSuggestResponse,
} from '../lib/quote.js';
import { evaluateStock } from '../lib/score.js';

// ---------------------------------------------------------------------------
// 实测抓下来的原始响应样本（腾讯接口真实返回，原样粘贴）
// ---------------------------------------------------------------------------

/** sh600519 贵州茅台，实测 88 字段，GP-A 在下标 61 */
const RAW_SH600519 =
  'v_sh600519="1~贵州茅台~600519~1453.00~1452.00~1450.00~42848~23139~19709~1452.00~2~1451.60~1~1451.33~1~1451.01~1~1451.00~5~1453.00~2~1453.01~2~1453.06~1~1453.07~8~1453.19~1~~20261106161458~1.00~0.07~1457.72~1436.00~1453.00/42848/6199528289~42848~619953~0.34~22.11~~1457.72~1436.00~1.50~18163.69~18163.69~6.70~1597.20~1306.80~0.65~-4~1446.87~21.13~22.06~~~-0.02~619952.8289~232.4800~16~   A~GP-A~7.70~4.38~3.58~30.29~26.74~1539.98~1151.01~8.84~15.04~11.04~1250081601~1250081601~-16.67~-2.94~1250081601~~~5.05~0.21~~CNY~0~___D__F__N~1450.04~3~";';

/** sz000001 平安银行 */
const RAW_SZ000001 =
  'v_sz000001="51~平安银行~000001~11.81~11.64~11.62~1640276~938074~702203~11.81~4384~11.80~3026~11.79~1562~11.78~1001~11.77~1836~11.82~1019~11.83~717~11.84~3560~11.85~44706~11.86~16687~~20261106161500~0.17~1.46~11.85~11.57~11.81/1640276/1927307591~1640276~192731~0.85~5.27~~11.85~11.57~2.41~2291.81~2291.84~0.48~12.80~10.48~0.99~-54880~11.75~4.39~5.38~~~0.13~192730.7591~31.5327~267~   A~GP-A~9.34~1.46~5.16~7.81~0.73~11.89~9.74~5.45~1.90~7.16~19405684991~19405918198~-69.91~13.99~19405684991~~~8.34~-0.08~~CNY~0~~11.88~-30327~";';

/** sh000001 上证指数：无买卖五档（全是 0），类型 ZS，涨停/跌停为 -1 */
const RAW_SH000001 =
'v_sh000001="1~上证指数~000001~3649.18~3689.91~3612.15~477042561~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20261106161401~-40.73~-1.10~3660.49~3610.20~3649.18/477042561/772634566231~477042561~77263457~0.98~16.58~~3660.49~3610.20~1.36~573906.07~638979.91~0.00~-1~-1~0.86~0~3641.33~~~~~~77263456.6231~0.0000~0~ ~ZS~-8.05~1.39~~~~4258.86~3574.27~-1.12~-4.32~-6.44~4862264107509~~2.94~-11.04~4862264107509~~~-8.95~0.10~~CNY~0~~0.00~0~";'

/** 北交所，87 字段，类型 GP，价格为 0（停牌样态） */
const RAW_BJ430047 =
'v_bj430047="62~诺思兰德~430047~8.17~8.17~0.00~0~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20261106090000~0.00~0.00~0.00~0.00~8.17/0/0~0~0.00~0.00~-35.67~C~0.00~0.00~0.00~14.71~22.41~9.68~-1~-1~0.00~0~0.00~-36.61~-41.71~~~~0.0000~0.0000~0~ ~GP~0.00~0.00~0.00~-27.13~-12.81~~~0.00~0.00~0.00~180106427~274271974~~0.00~180106427~~~0.00~0.00~~CNY~4~~0.00~0";'

/** 日K真实响应（截取头部若干条，结构与真实一致） */
const RAW_KLINE = JSON.stringify({
  code: 0,
  msg: '',
  data: {
    sh600519: {
      qfqday: [
        ['2025-07-14', '1378.019', '1371.619', '1382.999', '1369.619', '27781.000'],
        ['2025-07-15', '1371.000', '1380.000', '1385.000', '1370.000', '26000.000'],
        [
          '2025-12-19',
          '1381.976',
          '1381.976',
          '1384.426',
          '1372.986',
          '26509.000',
          { nd: '2025', fh_sh: '239.57', djr: '2025-12-18', cqr: '2025-12-19', FHcontent: '10派239.57元' },
        ],
      ],
      qt: {},
      prec: '1371.619',
      version: '15',
    },
  },
});

/** 指数日K：没有 qfqday 键，只有 day 键 */
const RAW_KLINE_INDEX = JSON.stringify({
  code: 0,
  msg: '',
  data: {
    sh000001: {
      day: [
        ['2026-11-05', '3646.570', '3689.910', '3701.590', '3646.570', '571291638.000'],
        ['2026-11-06', '3612.150', '3649.180', '3660.490', '3610.200', '477042561.000'],
      ],
      qt: {},
    },
  },
});

const RAW_SUGGEST =
  'v_hint="sh~600519~\\u8d35\\u5dde\\u8305\\u53f0~gzmt~GP-A^sz~000001~\\u5e73\\u5b89\\u94f6\\u884c~payh~GP-A"';

// ---------------------------------------------------------------------------
// 1. normalizeCode
// ---------------------------------------------------------------------------

// v3 起返回值增加 marketLabel 与 currency（见 CONTRACT.md「多市场设计决定」），
// 这里只断言核心三字段，市场标签用包含断言。
test('normalizeCode: 6 开头走沪市', () => {
  assert.deepEqual(
    { ...normalizeCode('600519'), marketLabel: undefined, currency: undefined },
    { market: 'sh', code: '600519', secid: 'sh600519', marketLabel: undefined, currency: undefined },
  );
  assert.equal(normalizeCode('sh600519').secid, 'sh600519');
  assert.equal(normalizeCode('SH600519').market, 'sh');
  assert.equal(normalizeCode('  sh600519  ').code, '600519');
  assert.equal(normalizeCode('600519').marketLabel, '沪A');
  assert.equal(normalizeCode('600519').currency, 'CNY');
});

test('normalizeCode: 0/3 开头走深市', () => {
  const a = normalizeCode('000001');
  assert.equal(a.market, 'sz');
  assert.equal(a.secid, 'sz000001');
  assert.equal(a.marketLabel, '深A');
  assert.equal(normalizeCode('300750').market, 'sz');
});

test('normalizeCode: 4/8 开头走北交所，5 开头 ETF 走沪市', () => {
  assert.equal(normalizeCode('430047').market, 'bj');
  assert.equal(normalizeCode('830799').market, 'bj');
  assert.equal(normalizeCode('510300').market, 'sh');
});

test('normalizeCode: 显式前缀优先于数字推断', () => {
  assert.equal(normalizeCode('sz600519').secid, 'sz600519');
});

test('normalizeCode: 港股（5 位补零）', () => {
  const r = normalizeCode('hk00700');
  assert.equal(r.market, 'hk');
  assert.equal(r.code, '00700');
  assert.equal(r.secid, 'hk00700');
  assert.equal(r.currency, 'HKD');
  assert.equal(normalizeCode('HK:0700').code, '00700');
  assert.equal(normalizeCode('700.hk').secid, 'hk00700');
  assert.equal(normalizeCode('hk1').code, '00001');
});

test('normalizeCode: 美股（去交易所后缀、统一大写）', () => {
  const r = normalizeCode('usAAPL');
  assert.equal(r.market, 'us');
  assert.equal(r.code, 'AAPL');
  assert.equal(r.secid, 'usAAPL');
  assert.equal(r.currency, 'USD');
  assert.equal(normalizeCode('us:aapl').code, 'AAPL');
  assert.equal(normalizeCode('aapl.us').code, 'AAPL');
  // 带交易所后缀的输入被剥掉
  assert.equal(normalizeCode('usAAPL.OQ').code, 'AAPL');
  assert.equal(normalizeCode('usBABA.N').code, 'BABA');
});

test('normalizeCode: 港美指数', () => {
  assert.equal(normalizeCode('hkHSI').secid, 'hkHSI');
  assert.equal(normalizeCode('usDJI').secid, 'usDJI');
  assert.equal(normalizeCode('usIXIC').marketLabel, '美股');
});

test('normalizeCode: 非法输入返回 null', () => {
  for (const bad of ['', '   ', 'abc', '60051', '6005199', 'sh60051', null, undefined, 600519, {}, []]) {
    assert.equal(normalizeCode(bad), null, `应当 null: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// 2. parseQuoteLine / parseQuoteResponse
// ---------------------------------------------------------------------------

test('parseQuoteLine: 个股字段全部正确', () => {
  const q = parseQuoteLine(RAW_SH600519);
  assert.ok(q, '应当解析成功');
  assert.equal(q.code, '600519');
  assert.equal(q.secid, 'sh600519');
  assert.equal(q.market, 'sh');
  assert.equal(q.name, '贵州茅台');
  assert.equal(q.price, 1453.0);
  assert.equal(q.prevClose, 1452.0);
  assert.equal(q.open, 1450.0);
  assert.equal(q.high, 1457.72);
  assert.equal(q.low, 1436.0);
  assert.equal(q.change, 1.0);
  assert.equal(q.changePercent, 0.07);
  assert.equal(q.volume, 42848);
  // 成交额：字段 37 是万元 619953，还原为元
  assert.equal(q.amount, 619953 * 10000);
  assert.equal(q.turnoverRate, 0.34);
  assert.equal(q.peTtm, 22.11);
  assert.equal(q.pb, 6.7);
  assert.equal(q.volumeRatio, 0.65);
  assert.equal(q.amplitude, 1.5);
  assert.equal(q.floatCap, 18163.69);
  assert.equal(q.totalCap, 18163.69);
  assert.equal(q.limitUp, 1597.2);
  assert.equal(q.limitDown, 1306.8);
  assert.equal(q.timestamp, '2026-11-06 16:14:58');
  assert.equal(q.isIndex, false);
  assert.equal(q.isSuspended, false);
});

test('parseQuoteLine: 平安银行涨跌幅与市值', () => {
  const q = parseQuoteLine(RAW_SZ000001);
  assert.equal(q.secid, 'sz000001');
  assert.equal(q.name, '平安银行');
  assert.equal(q.price, 11.81);
  assert.equal(q.changePercent, 1.46);
  assert.equal(q.peTtm, 5.27);
  assert.equal(q.pb, 0.48);
  assert.equal(q.volumeRatio, 0.99);
  assert.equal(q.amplitude, 2.41);
  assert.equal(q.floatCap, 2291.81);
  assert.equal(q.isIndex, false);
  assert.equal(q.isSuspended, false);
});

test('parseQuoteLine: 指数 isIndex=true 且无买卖五档不报错', () => {
  const q = parseQuoteLine(RAW_SH000001);
  assert.equal(q.secid, 'sh000001');
  assert.equal(q.name, '上证指数');
  assert.equal(q.isIndex, true);
  assert.equal(q.price, 3649.18);
  assert.equal(q.change, -40.73);
  assert.equal(q.changePercent, -1.1);
  assert.equal(q.high, 3660.49);
  assert.equal(q.low, 3610.2);
  // 指数涨停/跌停是 -1
  assert.equal(q.limitUp, -1);
  assert.equal(q.limitDown, -1);
  // 指数不应被判为停牌
  assert.equal(q.isSuspended, false);
});

test('parseQuoteLine: 成交量 0 的北交所标的判为停牌（87 字段，逐字段防御）', () => {
  const q = parseQuoteLine(RAW_BJ430047);
  assert.equal(q.secid, 'bj430047');
  assert.equal(q.market, 'bj');
  assert.equal(q.name, '诺思兰德');
  // 停牌时盘口仍带昨收价，价格为 8.17 而非 0
  assert.equal(q.price, 8.17);
  assert.equal(q.prevClose, 8.17);
  assert.equal(q.volume, 0);
  assert.equal(q.amount, 0);
  assert.equal(q.isIndex, false);
  // 成交量 0 且非指数 => 停牌
  assert.equal(q.isSuspended, true);
  // 该响应只有 87 字段（比个股少一个），尾部字段缺失应返回 null 而非 NaN
  assert.equal(q.limitUp, -1);
  assert.equal(q.limitDown, -1);
  assert.equal(q.floatCap, 14.71);
  assert.equal(q.totalCap, 22.41);
});

test('parseQuoteLine: 字段缺失返回 null 而不是 NaN', () => {
  // 只有 6 个字段的残缺响应
  const q = parseQuoteLine('v_sh600519="1~贵州茅台~600519~1453.00~1452.00~1450.00"');
  assert.ok(q, '仍应解析出基础字段');
  assert.equal(q.price, 1453);
  assert.equal(q.name, '贵州茅台');
  // 缺失字段全部 null，绝不 NaN
  for (const key of [
    'change',
    'changePercent',
    'turnoverRate',
    'peTtm',
    'pb',
    'volumeRatio',
    'amplitude',
    'floatCap',
    'totalCap',
    'limitUp',
    'limitDown',
    'amount',
    'timestamp',
  ]) {
    assert.equal(q[key], null, `${key} 应当为 null`);
    assert.ok(!Number.isNaN(q[key]), `${key} 不应为 NaN`);
  }
  assert.equal(q.isIndex, false);
});

test('parseQuoteLine: 空值与占位符解析为 null', () => {
  const q = parseQuoteLine('v_sz000001="51~平安银行~000001~11.81~11.64~11.62~1640276~~0~~"');
  assert.equal(q.price, 11.81);
  assert.equal(q.turnoverRate, null);
});

test('parseQuoteLine: 无法解析的行返回 null', () => {
  assert.equal(parseQuoteLine(''), null);
  assert.equal(parseQuoteLine('garbage'), null);
  assert.equal(parseQuoteLine('v_sh600519=""'), null);
  assert.equal(parseQuoteLine(null), null);
});

test('parseQuoteResponse: 多行响应全部解析，坏行跳过', () => {
  const text = [RAW_SH600519, 'v_badline_no_payload="";', RAW_SZ000001, '', RAW_SH000001].join('\n');
  const map = parseQuoteResponse(text);
  assert.equal(map.size, 3);
  assert.ok(map.has('sh600519'));
  assert.ok(map.has('sz000001'));
  assert.ok(map.has('sh000001'));
  assert.equal(map.get('sh600519').name, '贵州茅台');
});

// ---------------------------------------------------------------------------
// 3. parseKlineResponse
// ---------------------------------------------------------------------------

test('parseKlineResponse: 解析 qfqday，顺序与字段正确', () => {
  const bars = parseKlineResponse(RAW_KLINE, 'sh600519');
  assert.equal(bars.length, 3);
  assert.deepEqual(bars[0], {
    date: '2025-07-14',
    open: 1378.019,
    close: 1371.619,
    high: 1382.999,
    low: 1369.619,
    volume: 27781,
  });
  // 升序
  assert.ok(bars[0].date < bars[1].date);
  assert.ok(bars[1].date < bars[2].date);
  // 高 >= 收/开/低 恒成立
  for (const b of bars) {
    assert.ok(b.high >= b.close, `${b.date} high>=close`);
    assert.ok(b.high >= b.open, `${b.date} high>=open`);
    assert.ok(b.high >= b.low, `${b.date} high>=low`);
    assert.ok(b.low <= b.close, `${b.date} low<=close`);
  }
});

test('parseKlineResponse: 第 7 位分红对象被忽略', () => {
  const bars = parseKlineResponse(RAW_KLINE, 'sh600519');
  const divBar = bars.find((b) => b.date === '2025-12-19');
  assert.ok(divBar, '带分红信息的 bar 仍要保留');
  assert.equal(divBar.close, 1381.976);
  assert.equal(Object.keys(divBar).sort().join(','), 'close,date,high,low,open,volume');
});

test('parseKlineResponse: 缺 qfqday 时回退 day 键', () => {
  const bars = parseKlineResponse(RAW_KLINE_INDEX, 'sh000001');
  assert.equal(bars.length, 2);
  assert.equal(bars[0].date, '2026-11-05');
  assert.equal(bars[1].close, 3649.18);
  assert.equal(bars[1].volume, 477042561);
});

test('parseKlineResponse: 空数组正常返回 []', () => {
  const text = JSON.stringify({ code: 0, msg: '', data: { sh999999: { day: [], qt: {} } } });
  assert.deepEqual(parseKlineResponse(text, 'sh999999'), []);
});

test('parseKlineResponse: 非法 JSON / 缺节点抛 astock: 前缀错误', () => {
  assert.throws(() => parseKlineResponse('not json', 'sh600519'), /^Error: astock: /);
  assert.throws(
    () => parseKlineResponse(JSON.stringify({ code: 0, msg: '', data: {} }), 'sh600519'),
    /astock: .*sh600519/,
  );
});

// ---------------------------------------------------------------------------
// 4. parseSuggestResponse
// ---------------------------------------------------------------------------

test('parseSuggestResponse: 还原 \\uXXXX 中文', () => {
  const items = parseSuggestResponse(RAW_SUGGEST);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    market: 'sh',
    code: '600519',
    secid: 'sh600519',
    name: '贵州茅台',
    pinyin: 'gzmt',
  });
  assert.equal(items[1].name, '平安银行');
  assert.equal(items[1].secid, 'sz000001');
});

test('parseSuggestResponse: 空结果 N 返回 []', () => {
  assert.deepEqual(parseSuggestResponse('v_hint="N";'), []);
  assert.deepEqual(parseSuggestResponse('v_hint="";'), []);
  assert.deepEqual(parseSuggestResponse(''), []);
  assert.deepEqual(parseSuggestResponse(null), []);
});

test('parseSuggestResponse: 跳过非法市场与重复项', () => {
  const raw =
    'v_hint="sh~600519~\\u8d35\\u5dde\\u8305\\u53f0~gzmt~GP-A^us~AAPL~Apple~aapl~GP^sh~600519~\\u91cd\\u590d~cf~GP-A"';
  const items = parseSuggestResponse(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].secid, 'sh600519');
});

// ---------------------------------------------------------------------------
// 5. 联网冒烟测试（失败则 skip，不算 fail）
// ---------------------------------------------------------------------------

/** 探测网络是否可用，缓存结果避免重复探测。 */
let onlineCache;
async function isOnline() {
  if (onlineCache !== undefined) return onlineCache;
  try {
    const res = await fetch('https://qt.gtimg.cn/q=sh600519', { signal: AbortSignal.timeout(5000) });
    onlineCache = res.ok;
  } catch {
    onlineCache = false;
  }
  return onlineCache;
}

test('联网: fetchQuotes 取茅台真实快照', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearCache();
  const list = await fetchQuotes(['600519']);
  assert.equal(list.length, 1);
  const q = list[0];
  assert.ok(q, '应当拿到快照');
  assert.equal(q.secid, 'sh600519');
  assert.equal(q.name, '贵州茅台');
  assert.ok(q.price > 0, '现价应大于 0');
  assert.ok(typeof q.changePercent === 'number');
  assert.ok(q.timestamp && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(q.timestamp));
});

test('联网: fetchQuotes 批量 + 指数 + 非法代码占位 null', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearCache();
  const list = await fetchQuotes(['sh600519', 'sz000001', 'sh000001', 'not-a-code']);
  assert.equal(list.length, 4);
  assert.equal(list[0].secid, 'sh600519');
  assert.equal(list[1].secid, 'sz000001');
  assert.equal(list[2].secid, 'sh000001');
  assert.equal(list[2].isIndex, true);
  assert.equal(list[3], null, '非法代码应为 null 且不错位');
});

test('联网: fetchDailyBars 取日K且升序、limit 生效', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearCache();
  const bars = await fetchDailyBars('600519', { limit: 60 });
  assert.ok(bars.length > 0, '应当有 K 线');
  assert.ok(bars.length <= 60, `条数应 <= 60，实际 ${bars.length}`);
  assert.equal(bars.length, 60);
  for (let i = 1; i < bars.length; i += 1) {
    assert.ok(bars[i - 1].date < bars[i].date, '日期必须严格升序');
  }
  for (const b of bars) {
    assert.ok(b.open > 0 && b.close > 0 && b.high > 0 && b.low > 0);
    assert.ok(b.high >= b.close && b.high >= b.open && b.low <= b.close);
  }
});

test('联网: fetchDailyBars 指数走 day 键回退', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearCache();
  const bars = await fetchDailyBars('sh000001', { limit: 10 });
  assert.ok(bars.length > 0);
  assert.ok(bars[bars.length - 1].close > 100, '上证指数收盘应在千点量级');
});

test('联网: searchSymbols 搜中文与代码', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearCache();
  const byCode = await searchSymbols('600519');
  assert.ok(byCode.length > 0);
  assert.equal(byCode[0].secid, 'sh600519');
  assert.equal(byCode[0].name, '贵州茅台');

  const byName = await searchSymbols('茅台');
  assert.ok(byName.length > 0);
  assert.ok(byName.some((x) => x.secid === 'sh600519'));
});

test('联网: loadStockData 一次取齐，结构完整', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearCache();
  const data = await loadStockData('600519', { days: 120 });
  assert.ok(data.quote, '应有 quote');
  assert.ok(data.bars.length > 0, '应有 bars');
  assert.ok(Array.isArray(data.warnings));
  assert.equal(data.warnings.length, 0, `不应有 warning：${data.warnings.join('; ')}`);
});

test('联网: loadStockData 非法代码不抛异常，返回 warnings', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  const data = await loadStockData('bad-code');
  assert.equal(data.quote, null);
  assert.deepEqual(data.bars, []);
  assert.ok(data.warnings.length > 0);
});

// ---------------------------------------------------------------------------
// 6. 缓存行为
// ---------------------------------------------------------------------------

test('缓存: 30 秒内重复请求命中缓存（同对象引用）', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearCache();
  const a = await fetchDailyBars('600519', { limit: 30 });
  const b = await fetchDailyBars('600519', { limit: 30 });
  assert.equal(a, b, '应命中同一缓存数组');

  // noCache 绕过缓存
  const c = await fetchDailyBars('600519', { limit: 30, noCache: true });
  assert.notEqual(a, c, 'noCache 应重新请求');
  assert.equal(a.length, c.length);
});

test('缓存: 不同 limit 使用不同缓存键', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearCache();
  const a = await fetchDailyBars('600519', { limit: 20 });
  const b = await fetchDailyBars('600519', { limit: 40 });
  assert.equal(a.length, 20);
  assert.equal(b.length, 40);
});

// ---------------------------------------------------------------------------
// 7. 超时与取消
// ---------------------------------------------------------------------------

test('超时: 极短 timeoutMs 抛 astock: 前缀错误', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearCache();
  await assert.rejects(
    () => fetchDailyBars('600519', { limit: 30, timeoutMs: 1, noCache: true }),
    /^Error: astock: /,
  );
});

test('取消: 外部 signal 取消后抛错', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearCache();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => fetchDailyBars('600519', { limit: 30, noCache: true, signal: ac.signal }),
    /astock: /,
  );
});

test('fetchQuotes 空数组立即返回 []', async () => {
  assert.deepEqual(await fetchQuotes([]), []);
});

test('fetchQuotes 非数组抛错', async () => {
  await assert.rejects(() => fetchQuotes('600519'), /astock: /);
});

test('searchSymbols 空关键词返回 []（不联网）', async () => {
  assert.deepEqual(await searchSymbols(''), []);
  assert.deepEqual(await searchSymbols('   '), []);
  assert.deepEqual(await searchSymbols(null), []);
});

test('fetchDailyBars 非法代码抛错（不联网）', async () => {
  await assert.rejects(() => fetchDailyBars('zzz'), /astock: 非法股票代码/);
  await assert.rejects(() => fetchDailyBars(''), /astock: 非法股票代码/);
});

/* ════════════════════════════════════════════════════════════════
 * 新浪 A 股 K 线备用源（腾讯被 WAF 拦截时启用）
 * ════════════════════════════════════════════════════════════════ */

test('parseSinaKlineResponse: 解析新浪日K并升序', () => {
  const raw = JSON.stringify([
    { day: '2026-11-04', open: '1470.000', high: '1480.600', low: '1439.000', close: '1460.000', volume: '7000000' },
    { day: '2026-11-02', open: '1410.000', high: '1447.000', low: '1395.020', close: '1439.100', volume: '8269122' },
  ]);
  const bars = parseSinaKlineResponse(raw);
  assert.equal(bars.length, 2);
  // 必须升序：早的在前
  assert.equal(bars[0].date, '2026-11-02');
  assert.equal(bars[1].date, '2026-11-04');
  assert.equal(bars[0].open, 1410);
  assert.equal(bars[0].close, 1439.1);
  assert.equal(bars[0].high, 1447);
  assert.equal(bars[0].low, 1395.02);
  assert.equal(bars[0].volume, 8269122);
});

test('parseSinaKlineResponse: 非法输入返回空数组', () => {
  assert.deepEqual(parseSinaKlineResponse(''), []);
  assert.deepEqual(parseSinaKlineResponse('not json'), []);
  assert.deepEqual(parseSinaKlineResponse('null'), []);
  assert.deepEqual(parseSinaKlineResponse('{}'), []);
  assert.deepEqual(parseSinaKlineResponse('[{"day":"","open":"1"}]'), []);
});

test('parseSinaKlineResponse: 缺失 high/low 时回退到 close', () => {
  const bars = parseSinaKlineResponse(JSON.stringify([
    { day: '2026-11-02', open: '10', close: '11', volume: '100' },
  ]));
  assert.equal(bars.length, 1);
  assert.equal(bars[0].high, 11);
  assert.equal(bars[0].low, 11);
});

/* ════════════════════════════════════════════════════════════════
 * 新浪美股 K 线备用源
 * ════════════════════════════════════════════════════════════════ */

test('parseSinaUsKlineResponse: 解析美股日K并升序', () => {
  const raw = JSON.stringify([
    { d: '2026-11-06', o: '338.73', h: '345.79', l: '338.30', c: '342.37', v: '44703764', a: '15323800000' },
    { d: '2026-11-04', o: '341.56', h: '354.50', l: '340.99', c: '349.51', v: '89637676', a: '31441200000' },
  ]);
  const bars = parseSinaUsKlineResponse(raw);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].date, '2026-11-04');
  assert.equal(bars[1].date, '2026-11-06');
  assert.equal(bars[1].open, 338.73);
  assert.equal(bars[1].close, 342.37);
  assert.equal(bars[1].high, 345.79);
  assert.equal(bars[1].low, 338.3);
  assert.equal(bars[1].volume, 44703764);
});

test('parseSinaUsKlineResponse: 非法输入返回空数组', () => {
  assert.deepEqual(parseSinaUsKlineResponse(''), []);
  assert.deepEqual(parseSinaUsKlineResponse('bad'), []);
  assert.deepEqual(parseSinaUsKlineResponse('null'), []);
  assert.deepEqual(parseSinaUsKlineResponse('[]'), []);
});

/* ════════════════════════════════════════════════════════════════
 * 分钟线（fetchMinuteBars / parseSinaTimedKlineResponse）
 * ════════════════════════════════════════════════════════════════ */

test('parseSinaTimedKlineResponse: 保留完整时间戳', () => {
  const raw = JSON.stringify([
    { day: '2026-11-06 14:15:00', open: '1448.10', high: '1449.00', low: '1446.10', close: '1448.36', volume: '52900' },
    { day: '2026-11-06 14:10:00', open: '1447.00', high: '1448.50', low: '1445.00', close: '1448.10', volume: '40000' },
  ]);
  const bars = parseSinaTimedKlineResponse(raw);
  assert.equal(bars.length, 2);
  // 必须按时间升序
  assert.equal(bars[0].time, '2026-11-06 14:10:00');
  assert.equal(bars[1].time, '2026-11-06 14:15:00');
  // date 是 time 的日期部分
  assert.equal(bars[0].date, '2026-11-06');
  assert.equal(bars[1].open, 1448.1);
  assert.equal(bars[1].close, 1448.36);
});

test('parseSinaTimedKlineResponse: 非法输入返回空数组', () => {
  assert.deepEqual(parseSinaTimedKlineResponse(''), []);
  assert.deepEqual(parseSinaTimedKlineResponse('bad'), []);
  assert.deepEqual(parseSinaTimedKlineResponse('[]'), []);
});

test('fetchMinuteBars: 港美股返回空数组（无分钟线源）', async () => {
  assert.deepEqual(await fetchMinuteBars('hk00700', { scale: 5 }), []);
  assert.deepEqual(await fetchMinuteBars('usAAPL', { scale: 5 }), []);
});

test('fetchMinuteBars: 非法代码抛错', async () => {
  await assert.rejects(() => fetchMinuteBars('zzz'), /非法股票代码/);
});

test('联网：fetchMinuteBars 取 A 股 5 分钟线', async (t) => {
  let bars;
  try {
    bars = await fetchMinuteBars('sh600519', { scale: 5, limit: 48, noCache: true });
  } catch (error) {
    t.skip(`网络不可用：${error.message}`);
    return;
  }
  if (bars.length === 0) {
    t.skip('分钟线接口返回空（可能被限流）');
    return;
  }
  assert.ok(bars.length > 0);
  // 时间戳必须含时分
  assert.match(bars[0].time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // 升序
  for (let i = 1; i < Math.min(bars.length, 10); i += 1) {
    assert.ok(bars[i - 1].time <= bars[i].time, '时间必须升序');
  }
});

/* ════════════════════════════════════════════════════════════════
 * A 股 K 线主源：新浪（腾讯为备用）
 * ════════════════════════════════════════════════════════════════ */

test('联网：A 股日 K 走新浪主源（可连续多次取到）', async (t) => {
  // 主源稳定性验证：连续取 3 次不同标的，都应成功。
  // 如果主源仍是腾讯，这条会因 501 而依赖备用链路，耗时也会明显更长。
  const codes = ['sh600519', 'sz000001', 'sh601318'];
  for (const code of codes) {
    let bars;
    try {
      bars = await fetchDailyBars(code, { limit: 30, noCache: true, timeoutMs: 15000 });
    } catch (error) {
      t.skip(`网络不可用：${error.message}`);
      return;
    }
    if (bars.length === 0) {
      t.skip(`${code} 取不到数据（可能被限流）`);
      return;
    }
    assert.ok(bars.length >= 20, `${code} 应取到足够 K 线，实际 ${bars.length}`);
    // 每条必须是合法 OHLC
    for (const b of bars.slice(0, 5)) {
      assert.ok(b.high >= b.low, `${code} high 应 >= low`);
      assert.ok(b.close > 0, `${code} close 应为正数`);
      assert.match(b.date, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('联网：A 股 K 线与快照可组合成完整评分', async (t) => {
  // K 线走新浪、快照走腾讯，两者组合后评分必须完整。
  // 这条同时验证了「混合数据源」不会让 Evaluation 缺字段。
  let data;
  try {
    data = await loadStockData('600519', { limit: 120 });
  } catch (error) {
    t.skip(`网络不可用：${error.message}`);
    return;
  }
  if (data.quote === null || data.bars.length === 0) {
    t.skip('快照或 K 线缺失（可能被限流）');
    return;
  }
  const ev = evaluateStock({ quote: data.quote, bars: data.bars });
  assert.ok(typeof ev.score === 'number' && ev.score >= 0 && ev.score <= 100);
  assert.equal(ev.factors.length, 6);
  // 快照侧的富字段必须还在（证明没有因为换 K 线源而丢掉快照能力）
  assert.ok(data.quote.peTtm !== null || data.quote.pb !== null,
    '快照应仍带 PE/PB（来自腾讯，未被新浪替代）');
});
