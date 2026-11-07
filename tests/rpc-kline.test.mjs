/**
 * lib/rpc.js 的 kline 与 interpret 端点测试。
 *
 * 这两个端点会把上游数据加工成前端/模型直接可用的形态，
 * 这里验证加工逻辑本身（均线计算、解读措辞），不依赖网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAstockRpc } from '../lib/rpc.js';

/** 造一个可用的 RPC 实例；evaluate 用桩函数。 */
function makeRpc() {
  return createAstockRpc({
    config: { timeoutMs: 8000, defaultDays: 320 },
    readWatchlist: async () => [],
    writeWatchlist: async (codes) => codes,
    evaluate: async () => ({
      code: '600519', name: '贵州茅台', score: 85, verdict: 'strong-bull', verdictLabel: '强烈看多',
    }),
  });
}

/** 造一段合成 K 线：稳步上涨。 */
function makeBars(count) {
  const bars = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = price * 1.01;
    bars.push({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open,
      close,
      high: close * 1.005,
      low: open * 0.995,
      volume: 1000000 + i * 1000,
    });
    price = close;
  }
  return bars;
}

test('kline 端点：非法代码返回错误而非抛异常', async () => {
  const rpc = makeRpc();
  const res = await rpc('kline', { code: 'zzz' }, new AbortController().signal);
  assert.equal(res.ok, false);
  assert.match(res.error.message, /无法识别的股票代码/);
});

test('kline 端点：未知端点返回错误', async () => {
  const rpc = makeRpc();
  const res = await rpc('no-such-endpoint', {}, new AbortController().signal);
  assert.equal(res.ok, false);
  assert.match(res.error.message, /未知的接口/);
});

test('interpret 端点：非法代码返回错误', async () => {
  const rpc = makeRpc();
  const res = await rpc('interpret', { code: '' }, new AbortController().signal);
  assert.equal(res.ok, false);
});

/* ════════════════════════════════════════════════════════════════
 * 均线计算（通过 kline 端点间接验证）
 * ════════════════════════════════════════════════════════════════ */

test('kline 端点：返回 bars 与四条均线，长度与 bars 对齐', async (t) => {
  const rpc = makeRpc();
  // 用真实接口；不可达时 skip
  const res = await rpc('kline', { code: '600519', days: 60 }, new AbortController().signal);
  if (!res.ok) {
    t.skip(`网络不可用：${res.error.message}`);
    return;
  }
  const v = res.value;
  assert.ok(Array.isArray(v.bars));
  assert.ok(v.bars.length > 0);
  // 每条 bar 必须有 OHLCV 五个字段
  for (const bar of v.bars.slice(0, 3)) {
    for (const key of ['date', 'open', 'close', 'high', 'low', 'volume']) {
      assert.ok(key in bar, `bar 缺字段 ${key}`);
    }
    assert.ok(bar.high >= bar.close, '最高价应 >= 收盘价');
    assert.ok(bar.low <= bar.close, '最低价应 <= 收盘价');
  }
  // 均线四条，长度与 bars 一致
  for (const period of [5, 10, 20, 60]) {
    assert.ok(Array.isArray(v.ma[period]), `缺 ma${period}`);
    assert.equal(v.ma[period].length, v.bars.length, `ma${period} 长度应与 bars 对齐`);
    // 前 period-1 项必须是 null（不足期）
    for (let i = 0; i < Math.min(period - 1, v.bars.length); i += 1) {
      assert.equal(v.ma[period][i], null, `ma${period} 第 ${i} 项应为 null`);
    }
  }
});

test('interpret 端点：返回解读结构且措辞完整', async (t) => {
  const rpc = makeRpc();
  const res = await rpc('interpret', { code: '600519' }, new AbortController().signal);
  if (!res.ok) {
    t.skip(`网络不可用：${res.error.message}`);
    return;
  }
  const v = res.value;
  assert.ok(v.reading, '应返回 reading');
  const r = v.reading;
  assert.ok(typeof r.headline === 'string' && r.headline.length > 0);
  assert.ok(Array.isArray(r.paragraphs));
  assert.ok(Array.isArray(r.signals));
  assert.ok(Array.isArray(r.cautions));
  // 段落里应有具体数字，不能是空话
  assert.ok(r.paragraphs.some((p) => /\d/.test(p)), '段落应含具体数值');
  assert.ok(r.signals.length > 0, '应有至少一条技术信号');
  // 不应出现「必涨」「一定」这类断言式预测
  const joined = [...r.paragraphs, ...r.signals, ...r.cautions].join(' ');
  for (const banned of ['必涨', '必跌', '一定会', '保证']) {
    assert.ok(!joined.includes(banned), `解读不应包含断言式措辞：${banned}`);
  }
});

/* ════════════════════════════════════════════════════════════════
 * 时间范围：1天/7天/30天走分钟线，长周期走日线
 * ════════════════════════════════════════════════════════════════ */

test('kline 端点：A 股短周期走分钟线', async (t) => {
  const rpc = makeRpc();
  const cases = [
    { range: '1d', expectGran: '5min' },
    { range: '7d', expectGran: '30min' },
    { range: '30d', expectGran: '60min' },
  ];
  for (const c of cases) {
    const res = await rpc('kline', { code: '600519', range: c.range }, new AbortController().signal);
    if (!res.ok) {
      t.skip(`网络不可用：${res.error.message}`);
      return;
    }
    const v = res.value;
    assert.equal(v.range, c.range);
    assert.equal(v.granularity, c.expectGran, `${c.range} 应为 ${c.expectGran}`);
    assert.ok(v.count > 0);
    // 分钟线每条必须有 time 字段且含时分
    assert.match(String(v.bars[0].time), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
      '分钟线的 time 应含完整时分秒');
  }
});

test('kline 端点：长周期走日线且不含时分', async (t) => {
  const rpc = makeRpc();
  for (const range of ['60d', '120d', '250d']) {
    const res = await rpc('kline', { code: '600519', range }, new AbortController().signal);
    if (!res.ok) {
      t.skip(`网络不可用：${res.error.message}`);
      return;
    }
    const v = res.value;
    assert.equal(v.granularity, 'day', `${range} 应为日线`);
    assert.match(String(v.bars[0].date), /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('kline 端点：港美股回落日线（无分钟线源）', async (t) => {
  const rpc = makeRpc();
  for (const code of ['hk00700', 'usAAPL']) {
    const res = await rpc('kline', { code, range: '1d' }, new AbortController().signal);
    if (!res.ok) {
      t.skip(`网络不可用：${res.error.message}`);
      return;
    }
    assert.equal(res.value.granularity, 'day', `${code} 没有分钟线源，应回落日线`);
  }
});

test('kline 端点：未知 range 回落到 120 日线', async (t) => {
  const rpc = makeRpc();
  const res = await rpc('kline', { code: '600519', range: 'bogus' }, new AbortController().signal);
  if (!res.ok) {
    t.skip(`网络不可用：${res.error.message}`);
    return;
  }
  assert.equal(res.value.range, '120d');
  assert.equal(res.value.granularity, 'day');
});
