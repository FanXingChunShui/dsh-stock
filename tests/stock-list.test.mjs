/**
 * lib/stock-list.js 单元测试。
 *
 * 解析类用例使用实测抓到的真实响应片段；联网冒烟用例失败时 skip 而非 fail。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toNumber,
  parseCnRow,
  parseHkRow,
  mergeListPages,
  searchInList,
  listStocksByMarket,
  clearListCache,
} from '../lib/stock-list.js';

/* ════════════════════════════════════════════════════════════════
 * 1. toNumber：字符串转数字的边界
 * ════════════════════════════════════════════════════════════════ */

test('toNumber: 正常数字字符串', () => {
  assert.equal(toNumber('11.24'), 11.24);
  assert.equal(toNumber('-2.091'), -2.091);
  assert.equal(toNumber('0'), 0);
  assert.equal(toNumber(12.5), 12.5);
});

test('toNumber: 空值与非法值一律 null，绝不 NaN', () => {
  for (const bad of ['', '   ', '-', '--', null, undefined, 'abc', {}, [], NaN]) {
    const got = toNumber(bad);
    assert.equal(got, null, `应 null: ${JSON.stringify(bad)}`);
    assert.ok(!Number.isNaN(got), '绝不能返回 NaN');
  }
});

/* ════════════════════════════════════════════════════════════════
 * 2. parseCnRow：A 股行解析（真实字段）
 * ════════════════════════════════════════════════════════════════ */

const CN_ROW = {
  symbol: 'sh600519',
  code: '600519',
  name: '贵州茅台',
  trade: '1453.000',
  pricechange: 1.0,
  changepercent: 0.069,
  buy: '1453.000',
  sell: '1453.010',
  settlement: '1452.000',
  open: '1450.000',
  high: '1457.720',
  low: '1436.000',
  volume: 4284772,
  amount: 6199528289,
  ticktime: '15:00:00',
  per: 22.11,
  pb: 6.7,
  mktcap: 181636900,
  nmc: 181636900,
  turnoverratio: 0.34,
};

test('parseCnRow: 字段全部正确', () => {
  const r = parseCnRow(CN_ROW);
  assert.ok(r);
  assert.equal(r.secid, 'sh600519');
  assert.equal(r.code, '600519');
  assert.equal(r.market, 'sh');
  assert.equal(r.marketLabel, '沪A');
  assert.equal(r.currency, 'CNY');
  assert.equal(r.name, '贵州茅台');
  assert.equal(r.price, 1453);
  assert.equal(r.prevClose, 1452);
  assert.equal(r.changePercent, 0.069);
  assert.equal(r.peTtm, 22.11);
  assert.equal(r.pb, 6.7);
  // 新浪 mktcap 单位是万元，输出统一成亿元
  assert.equal(r.totalCap, 18163.69);
  assert.equal(r.isSuspended, false);
});

test('parseCnRow: 深市 / 北交所市场识别', () => {
  assert.equal(parseCnRow({ ...CN_ROW, symbol: 'sz000001', code: '000001' }).market, 'sz');
  assert.equal(parseCnRow({ ...CN_ROW, symbol: 'bj920000', code: '920000' }).market, 'bj');
  assert.equal(parseCnRow({ ...CN_ROW, symbol: 'bj920000', code: '920000' }).marketLabel, '北交所');
});

test('parseCnRow: 停牌（价格 0 或成交 0）', () => {
  assert.equal(parseCnRow({ ...CN_ROW, trade: '0.000', volume: 0 }).isSuspended, true);
  assert.equal(parseCnRow({ ...CN_ROW, volume: 0 }).isSuspended, true);
});

test('parseCnRow: 缺失关键字段返回 null', () => {
  assert.equal(parseCnRow(null), null);
  assert.equal(parseCnRow({}), null);
  assert.equal(parseCnRow({ symbol: 'sh600519' }), null, '无名称应 null');
});

/* ════════════════════════════════════════════════════════════════
 * 3. parseHkRow：港股行解析
 * ════════════════════════════════════════════════════════════════ */

const HK_ROW = {
  symbol: '00001',
  name: '长和',
  engname: 'CKH HOLDINGS',
  lasttrade: '70.20000',
  prevclose: '71.25000',
  open: '69.95000',
  high: '70.90000',
  low: '69.65000',
  volume: '6679876',
  amount: '469375845',
  pricechange: '-1.05',
  changepercent: '-1.474',
  pe_ratio: '11.2',
};

test('parseHkRow: 字段正确，代码补足 5 位', () => {
  const r = parseHkRow(HK_ROW);
  assert.ok(r);
  assert.equal(r.secid, 'hk00001');
  assert.equal(r.code, '00001');
  assert.equal(r.market, 'hk');
  assert.equal(r.currency, 'HKD');
  assert.equal(r.name, '长和');
  assert.equal(r.price, 70.2);
  assert.equal(r.changePercent, -1.474);
});

test('parseHkRow: 无中文名时回退英文名', () => {
  const r = parseHkRow({ ...HK_ROW, name: '' });
  assert.equal(r.name, 'CKH HOLDINGS');
});

/* ════════════════════════════════════════════════════════════════
 * 4. mergeListPages：分页合并去重
 * ════════════════════════════════════════════════════════════════ */

test('mergeListPages: 合并多页并按 secid 去重', () => {
  const page1 = [CN_ROW];
  const page2 = [
    { ...CN_ROW, symbol: 'sz000001', code: '000001', name: '平安银行' },
    CN_ROW, // 与第 1 页重复
  ];
  const merged = mergeListPages([page1, page2], parseCnRow);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((r) => r.secid), ['sh600519', 'sz000001']);
});

test('mergeListPages: 非数组页与无效行被跳过', () => {
  const merged = mergeListPages([null, [CN_ROW], 'x', [{}]], parseCnRow);
  assert.equal(merged.length, 1);
});

/* ════════════════════════════════════════════════════════════════
 * 5. searchInList：代码/名称/拼音过滤
 * ════════════════════════════════════════════════════════════════ */

const ROWS = [
  { secid: 'sh600519', code: '600519', name: '贵州茅台' },
  { secid: 'sz000001', code: '000001', name: '平安银行' },
  { secid: 'sh600036', code: '600036', name: '招商银行' },
];

test('searchInList: 按名称匹配', () => {
  assert.deepEqual(searchInList(ROWS, '银行').map((r) => r.code), ['000001', '600036']);
});

test('searchInList: 按代码片段匹配', () => {
  assert.deepEqual(searchInList(ROWS, '6005').map((r) => r.code), ['600519']);
});

test('searchInList: 空关键词返回前 N 条', () => {
  assert.equal(searchInList(ROWS, '', 2).length, 2);
  assert.equal(searchInList(ROWS, '').length, 3);
});

test('searchInList: limit 生效且无匹配返回空数组', () => {
  assert.equal(searchInList(ROWS, '银行', 1).length, 1);
  assert.deepEqual(searchInList(ROWS, '不存在的名字'), []);
});

/* ════════════════════════════════════════════════════════════════
 * 6. 联网冒烟（失败 skip，不 fail）
 * ════════════════════════════════════════════════════════════════ */

test('联网：A 股全量列表可取且规模合理', async (t) => {
  clearListCache();
  let result;
  try {
    result = await listStocksByMarket('cn', { noCache: true, timeoutMs: 20000 });
  } catch (error) {
    t.skip(`网络不可用：${error.message}`);
    return;
  }
  assert.ok(result.rows.length > 1000, `A 股应超过 1000 只，实际 ${result.rows.length}`);
  assert.equal(result.meta.complete, true);
  assert.equal(result.meta.market, 'cn');
  assert.ok(result.rows.every((r) => typeof r.secid === 'string' && r.secid.length > 0));
});

test('联网：港股列表可取（源上限，complete=false）', async (t) => {
  let result;
  try {
    result = await listStocksByMarket('hk', { noCache: true, timeoutMs: 15000 });
  } catch (error) {
    t.skip(`网络不可用：${error.message}`);
    return;
  }
  assert.ok(result.rows.length > 0);
  assert.equal(result.meta.complete, false, '港股源非全量，必须如实标注');
  assert.equal(result.rows[0].currency, 'HKD');
});

test('联网：美股返回种子且标注非全量', async (t) => {
  let result;
  try {
    result = await listStocksByMarket('us', { noCache: true });
  } catch (error) {
    t.skip(`网络不可用：${error.message}`);
    return;
  }
  assert.ok(result.rows.length > 0);
  assert.equal(result.meta.complete, false);
  assert.ok(result.rows.every((r) => r.secid.startsWith('us')));
});
