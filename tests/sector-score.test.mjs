/**
 * dsh-astock / tests/sector-score.test.mjs
 * lib/sector-score.js 自测。全部使用合成的 Sector 对象，不联网、不读文件。
 *
 * 覆盖 CONTRACT.md「v2 追加：板块（Sector）功能」要求的情况：
 *   1. 强势板块（各项为正、资金大幅流入、涨跌比高）→ bull / strong-bull
 *   2. 弱势板块（各项为负、资金流出）→ bear / strong-bear
 *   3. 中性板块 → neutral
 *   4. 全 null 字段 → 不抛异常、score 约 50、verdict neutral、有 warnings
 *   5. 权重和 = 1，且任何输入下都不重新分配
 *   6. score 恒在 0-100
 *   7. levels.support / levels.resistance 恒为空数组
 *   8. evaluateSectors 的排序（desc/asc、各 sortBy、limit）正确
 * 另外补充：SectorEvaluation 结构完整性、纯函数性（不改入参）、
 *           资金流对数压缩的量级不敏感性、边界输入（市值 0 / 资金全 0 / zgb 缺失）。
 *
 * 运行：cd dsh-astock && node --test tests/sector-score.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SECTOR_WEIGHTS,
  SECTOR_VERDICT_THRESHOLDS,
  SECTOR_DISCLAIMER,
  evaluateSector,
  evaluateSectors,
} from '../lib/sector-score.js';

/* ════════════════════════════════════════════════════════════════
 * 合成 Sector 工厂
 * ════════════════════════════════════════════════════════════════ */

/**
 * 构造一个字段齐全的 Sector（结构照 lib/sector.js 的契约）。
 * 所有字段都可以用 overrides 覆盖，包括显式传 null 来模拟数据缺失。
 */
function makeSector(overrides = {}) {
  const base = {
    code: 'pt01801120',
    name: '食品饮料',
    boardType: 'hy',
    stockType: 'BK-HY-1',
    price: 14898.96,
    change: 0,
    changePercent: 0,
    change5d: 0,
    change20d: 0,
    change60d: 0,
    change52w: 0,
    changeYtd: 0,
    turnoverRate: 1.8,
    volumeRatio: 1,
    speed: 0,
    totalCap: 40092.99,
    floatCap: 38977.92,
    upCount: 50,
    downCount: 50,
    capitalNet: 0,
    capitalNet5d: 0,
    capitalNet20d: 0,
    leader: { code: 'sh605339', name: '南侨食品', price: 15.8, change: 0, changePercent: 0 },
  };
  return { ...base, ...overrides };
}

/** 取某个因子的分。 */
function facScore(ev, key) {
  const f = ev.factors.find((x) => x.key === key);
  assert.ok(f, `缺少因子 ${key}`);
  return f.score;
}

/* ════════════════════════════════════════════════════════════════
 * 1. 权重
 * ════════════════════════════════════════════════════════════════ */

test('SECTOR_WEIGHTS：5 个因子、权重和为 1、对象被冻结', () => {
  const keys = Object.keys(SECTOR_WEIGHTS).sort();
  assert.deepEqual(keys, ['activity', 'breadth', 'capital', 'momentum', 'trend']);

  const sum = Object.values(SECTOR_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 1e9) / 1e9, 1, `权重和应为 1，实际 ${sum}`);

  // 契约规定的具体数值
  assert.equal(SECTOR_WEIGHTS.momentum, 0.3);
  assert.equal(SECTOR_WEIGHTS.trend, 0.25);
  assert.equal(SECTOR_WEIGHTS.capital, 0.2);
  assert.equal(SECTOR_WEIGHTS.activity, 0.15);
  assert.equal(SECTOR_WEIGHTS.breadth, 0.1);

  assert.ok(Object.isFrozen(SECTOR_WEIGHTS), 'SECTOR_WEIGHTS 必须被冻结');
});

test('权重在任何输入下都不重新分配（全 null 输入也保持 5 因子同权重）', () => {
  const ev = evaluateSector(null);
  assert.equal(ev.factors.length, 5);
  for (const f of ev.factors) {
    assert.equal(f.weight, SECTOR_WEIGHTS[f.key], `因子 ${f.key} 的权重被重新分配了`);
  }
  const sum = ev.factors.reduce((a, f) => a + f.weight, 0);
  assert.equal(Math.round(sum * 1e9) / 1e9, 1);
});

/* ════════════════════════════════════════════════════════════════
 * 2. 强势 / 弱势 / 中性
 * ════════════════════════════════════════════════════════════════ */

test('强势板块（各项为正、资金大幅流入、涨跌比高）→ bull 或 strong-bull', () => {
  const strong = makeSector({
    code: 'pt02031283',
    name: '强势概念',
    boardType: 'gn',
    changePercent: 3.2,
    change: 450,
    change5d: 9.5,
    change20d: 18,
    change60d: 26,
    changeYtd: 55,
    volumeRatio: 1.9,
    turnoverRate: 3.2,
    speed: 0.2,
    // 流通市值 7459.96 万元，净流入 80 万万元（= 80 亿）→ 比值非常极端
    capitalNet: 800000,
    capitalNet5d: 2200000,
    capitalNet20d: 4500000,
    upCount: 130,
    downCount: 20,
    leader: { code: 'sz301697', name: '贝特利', price: 36.6, change: 6.1, changePercent: 20 },
  });

  const ev = evaluateSector(strong);
  assert.ok(['bull', 'strong-bull'].includes(ev.verdict), `强势板块应给出 bull/strong-bull，实际 ${ev.verdict}（${ev.score}）`);
  assert.ok(ev.score >= SECTOR_VERDICT_THRESHOLDS.bull, `强势板块 score 应 ≥ 60，实际 ${ev.score}`);

  // 各个因子都应该在 50 分以上
  for (const f of ev.factors) {
    assert.ok(f.score > 50, `强势板块的因子 ${f.key} 应 > 50，实际 ${f.score}`);
  }
});

test('弱势板块（各项为负、资金流出）→ bear 或 strong-bear', () => {
  const weak = makeSector({
    name: '弱势板块',
    changePercent: -3.5, // 锚点给出很低的分
    change: -500,
    change5d: -8,
    change20d: -22,
    change60d: -28,
    changeYtd: -35,
    volumeRatio: 0.6,
    turnoverRate: 0.4,
    speed: -0.15,
    capitalNet: -900000,
    capitalNet5d: -2000000,
    capitalNet20d: -5000000,
    upCount: 8,
    downCount: 140,
    leader: { code: 'sh600000', name: '某股', price: 5, change: -0.3, changePercent: -6 },
  });

  const ev = evaluateSector(weak);
  assert.ok(['bear', 'strong-bear'].includes(ev.verdict), `弱势板块应给出 bear/strong-bear，实际 ${ev.verdict}（${ev.score}）`);
  assert.ok(ev.score < SECTOR_VERDICT_THRESHOLDS.bear, `弱势板块 score 应 < 45，实际 ${ev.score}`);
});

test('中性板块（各项持平）→ neutral，分数接近 50', () => {
  const ev = evaluateSector(makeSector());
  assert.equal(ev.verdict, 'neutral');
  assert.ok(Math.abs(ev.score - 50) < 5, `中性板块 score 应接近 50，实际 ${ev.score}`);
});

test('强势与弱势之间分数必须拉开明显差距', () => {
  const strong = evaluateSector(
    makeSector({
      changePercent: 3,
      change5d: 8,
      change20d: 15,
      change60d: 20,
      changeYtd: 40,
      volumeRatio: 1.8,
      turnoverRate: 3,
      speed: 0.2,
      capitalNet: 600000,
      capitalNet5d: 1500000,
      capitalNet20d: 3000000,
      upCount: 120,
      downCount: 20,
      leader: { code: 'x', name: '龙头', price: 10, change: 1, changePercent: 10 },
    }),
  );
  const weak = evaluateSector(
    makeSector({
      changePercent: -3,
      change5d: -8,
      change20d: -20,
      change60d: -25,
      changeYtd: -30,
      volumeRatio: 0.6,
      turnoverRate: 0.4,
      speed: -0.15,
      capitalNet: -600000,
      capitalNet5d: -1500000,
      capitalNet20d: -3000000,
      upCount: 10,
      downCount: 120,
      leader: { code: 'y', name: '弱势股', price: 5, change: -0.3, changePercent: -8 },
    }),
  );
  assert.ok(strong.score - weak.score > 25, `强弱分差应 > 25，实际 ${strong.score} vs ${weak.score}`);
});

/* ════════════════════════════════════════════════════════════════
 * 3. 边界：全 null / 缺字段 / 异常值
 * ════════════════════════════════════════════════════════════════ */

test('全 null 字段：不抛异常、score ≈ 50、verdict neutral、有 warnings、signals 齐全', () => {
  const empty = {
    code: 'pt01999999',
    name: '空数据板块',
    boardType: 'hy',
    price: null,
    change: null,
    changePercent: null,
    change5d: null,
    change20d: null,
    change60d: null,
    change52w: null,
    changeYtd: null,
    turnoverRate: null,
    volumeRatio: null,
    speed: null,
    totalCap: null,
    floatCap: null,
    upCount: null,
    downCount: null,
    capitalNet: null,
    capitalNet5d: null,
    capitalNet20d: null,
    leader: null,
  };

  let ev;
  assert.doesNotThrow(() => {
    ev = evaluateSector(empty);
  }, '全 null 输入绝不允许抛异常');

  assert.equal(ev.score, 50, `全 null 输入 score 应为 50，实际 ${ev.score}`);
  assert.equal(ev.verdict, 'neutral');
  assert.equal(ev.verdictLabel, '中性');
  assert.ok(ev.dataQuality.warnings.length > 0, '必须有 warnings 说明降级原因');

  // 每个因子仍然有 2-5 条 signals
  for (const f of ev.factors) {
    assert.ok(f.signals.length >= 2 && f.signals.length <= 5, `因子 ${f.key} 的 signals 应为 2-5 条，实际 ${f.signals.length}`);
    assert.equal(f.score, 50, `缺失数据的因子 ${f.key} 应退回 50 分，实际 ${f.score}`);
    for (const s of f.signals) assert.equal(typeof s, 'string');
  }

  // summary 必须带启发式标注
  assert.match(ev.summary, /启发式估计，非概率模型输出/);
});

test('evaluateSector 对 null / undefined / 非对象输入都返回完整结构', () => {
  for (const bad of [null, undefined, 0, 'abc', [], {}]) {
    let ev;
    assert.doesNotThrow(() => {
      ev = evaluateSector(bad);
    }, `evaluateSector(${JSON.stringify(bad)}) 不应抛异常`);
    assert.equal(ev.kind, 'sector');
    assert.equal(ev.score, 50);
    assert.equal(ev.verdict, 'neutral');
    assert.deepEqual(ev.levels, { support: [], resistance: [] });
    assert.equal(ev.factors.length, 5);
    assert.equal(ev.dataQuality.fundamentals, 'cross-sectional');
  }
});

test('市值 0 / 资金全 0 / zgb 缺失 / leader 为 null：不抛异常且有 warnings', () => {
  const odd = makeSector({
    floatCap: 0,
    totalCap: 0,
    capitalNet: 0,
    capitalNet5d: 0,
    capitalNet20d: 0,
    upCount: null,
    downCount: null,
    leader: null,
    changePercent: 1.2,
    change5d: 2.5,
  });

  let ev;
  assert.doesNotThrow(() => {
    ev = evaluateSector(odd);
  });
  assert.equal(ev.kind, 'sector');
  assert.ok(ev.dataQuality.warnings.length > 0);
  assert.ok(ev.dataQuality.warnings.some((w) => /流通市值/.test(w)), '应提示流通市值缺失');
  assert.ok(ev.dataQuality.warnings.some((w) => /涨跌家数/.test(w)), '应提示涨跌家数缺失');
  assert.ok(ev.dataQuality.warnings.some((w) => /领涨股/.test(w)), '应提示领涨股缺失');
  assert.equal(ev.leader, null);
  assert.deepEqual(ev.breadth, { up: null, down: null, ratio: null });
  // 资金全为 0 时资金流因子应保持中性（0 偏离中枢 → 但 0 万元不等于中枢，
  // 具体分数由压缩决定；这里只断言不抛异常且是有限数）
  assert.ok(Number.isFinite(facScore(ev, 'capital')));
});

test('极端值（涨跌幅 ±2000%、换手 500%、资金 ±1e12）不溢出，分数仍限在 0-100', () => {
  const insane = makeSector({
    changePercent: 2000,
    change5d: 5000,
    change20d: 10000,
    change60d: 20000,
    changeYtd: 50000,
    volumeRatio: 500,
    turnoverRate: 500,
    speed: 99,
    capitalNet: 1e12,
    capitalNet5d: 1e12,
    capitalNet20d: 1e12,
    upCount: 999999,
    downCount: 1,
    leader: { code: 'x', name: '妖股', price: 1, change: 1, changePercent: 1000 },
  });
  const ev = evaluateSector(insane);
  assert.ok(ev.score >= 0 && ev.score <= 100, `score 越界：${ev.score}`);
  assert.equal(ev.verdict, 'strong-bull');

  for (const f of ev.factors) {
    assert.ok(f.score >= 0 && f.score <= 100, `因子 ${f.key} 分数越界：${f.score}`);
    assert.ok(Number.isFinite(f.contribution));
  }
});

test('zgb 字符串格式被正确解析（"24/122" / 缺失 / 非法）', () => {
  // 注意：zgb 的解析在 lib/sector.js 里完成，这里验证的是 sector-score
  // 拿到的 upCount/downCount 是数字时能正确算 ratio（含字符串数字）
  const ev1 = evaluateSector(makeSector({ upCount: 24, downCount: 122 }));
  assert.deepEqual(ev1.breadth, { up: 24, down: 122, ratio: 0.1644 });

  const ev2 = evaluateSector(makeSector({ upCount: null, downCount: null }));
  assert.deepEqual(ev2.breadth, { up: null, down: null, ratio: null });

  // 防御：即便上游误传字符串数字，也要能算
  const ev3 = evaluateSector(makeSector({ upCount: '30', downCount: '70' }));
  assert.deepEqual(ev3.breadth, { up: 30, down: 70, ratio: 0.3 });
});

test('stop-and-think：字段为 "-" 或空串时一律当缺失，不产生 NaN', () => {
  const ev = evaluateSector(
    makeSector({
      changePercent: '-',
      change5d: '',
      change20d: '-',
      change60d: '',
      changeYtd: '-',
      volumeRatio: '',
      turnoverRate: '-',
      speed: '',
      capitalNet: '-',
      capitalNet5d: '',
      capitalNet20d: '-',
      floatCap: '-',
      upCount: '-',
      downCount: '',
    }),
  );
  assert.ok(Number.isFinite(ev.score), 'score 不允许为 NaN');
  for (const f of ev.factors) {
    assert.ok(Number.isFinite(f.score), `因子 ${f.key} 分数不允许为 NaN`);
    assert.ok(Number.isFinite(f.contribution), `因子 ${f.key} 贡献不允许为 NaN`);
  }
  assert.ok(Number.isFinite(ev.upProbability));
  assert.equal(ev.breadth.ratio, null);
});

/* ════════════════════════════════════════════════════════════════
 * 4. 结构完整性
 * ════════════════════════════════════════════════════════════════ */

test('SectorEvaluation 结构完整，字段名严格符合契约', () => {
  const ev = evaluateSector(makeSector());
  const expected = [
    'kind', 'code', 'name', 'boardType', 'score', 'verdict', 'verdictLabel',
    'upProbability', 'price', 'changePercent',
    // v2.1 契约追加：排序与列表展示所需的多周期与量能字段
    'change5d', 'change20d', 'change60d', 'capitalNet', 'volumeRatio', 'turnoverRate',
    'factors', 'levels', 'risks',
    'summary', 'disclaimer', 'leader', 'breadth', 'capital', 'dataQuality',
  ];
  assert.deepEqual(Object.keys(ev).sort(), expected.slice().sort());

  assert.equal(ev.kind, 'sector');
  assert.equal(ev.boardType, 'hy');
  assert.ok(typeof ev.verdictLabel === 'string' && ev.verdictLabel.length > 0);
  assert.ok(ev.upProbability > 0 && ev.upProbability < 1);

  // factors 结构
  for (const f of ev.factors) {
    assert.deepEqual(Object.keys(f).sort(), ['contribution', 'key', 'label', 'score', 'signals', 'weight']);
    assert.equal(typeof f.label, 'string');
    assert.ok(f.signals.length >= 2 && f.signals.length <= 5);
  }

  // 结构块
  assert.deepEqual(Object.keys(ev.breadth).sort(), ['down', 'ratio', 'up']);
  assert.deepEqual(Object.keys(ev.capital).sort(), ['net', 'net20d', 'net5d']);
  assert.equal(ev.dataQuality.fundamentals, 'cross-sectional');
  assert.ok(Array.isArray(ev.dataQuality.warnings));

  // 免责声明必须说明「不含 K 线技术指标」
  assert.match(ev.disclaimer, /不含 K 线技术指标/);
  assert.equal(ev.disclaimer, SECTOR_DISCLAIMER);
});

test('levels 恒为 { support: [], resistance: [] }，任何输入都一样', () => {
  const inputs = [
    makeSector(),
    null,
    {},
    makeSector({ changePercent: 9, change5d: 20, change20d: 40 }),
    makeSector({ changePercent: -9, change5d: -20, change20d: -40 }),
    makeSector({ price: 0 }),
  ];
  for (const inp of inputs) {
    const ev = evaluateSector(inp);
    assert.deepEqual(ev.levels, { support: [], resistance: [] });
    assert.equal(ev.levels.support.length, 0);
    assert.equal(ev.levels.resistance.length, 0);
  }
});

test('summary 2-4 句，且必须包含启发式标注', () => {
  const ev = evaluateSector(makeSector({ changePercent: 1.5, change5d: 4 }));
  assert.match(ev.summary, /启发式估计，非概率模型输出/);
  const sentences = ev.summary.split('。').filter((s) => s.trim());
  assert.ok(sentences.length >= 2 && sentences.length <= 4, `summary 应为 2-4 句，实际 ${sentences.length}：${ev.summary}`);
});

test('factors 顺序按权重降序，contribution = score * weight', () => {
  const ev = evaluateSector(makeSector({ changePercent: 2, change5d: 5 }));
  const keys = ev.factors.map((f) => f.key);
  assert.deepEqual(keys, ['momentum', 'trend', 'capital', 'activity', 'breadth']);
  for (let i = 1; i < ev.factors.length; i += 1) {
    assert.ok(ev.factors[i - 1].weight >= ev.factors[i].weight, 'factors 必须按权重降序');
  }
  for (const f of ev.factors) {
    assert.equal(f.contribution, Math.round(f.score * f.weight * 100) / 100);
  }
  // 加权和就等于总分
  const total = ev.factors.reduce((a, f) => a + f.contribution, 0);
  assert.ok(Math.abs(total - ev.score) < 0.11, `贡献之和 ${total} 应约等于总分 ${ev.score}`);
});

/* ════════════════════════════════════════════════════════════════
 * 5. 资金流：对数压缩的量级不敏感性
 * ════════════════════════════════════════════════════════════════ */

test('资金流量级差异极大时不会把分数打满：小板块与大板块可比', () => {
  // 同一相对流入强度（净流入 / 流通市值 相同），绝对金额差 1000 倍，
  // 资金流因子分应当基本一致——这是对数压缩 + 相对化存在的全部意义。
  const small = makeSector({ name: '小板块', floatCap: 1458.33, capitalNet: 3000, capitalNet5d: 6000, capitalNet20d: 10000 });
  const big = makeSector({ name: '大板块', floatCap: 119350.12, capitalNet: 245400, capitalNet5d: 490800, capitalNet20d: 818000 });

  const sSmall = facScore(evaluateSector(small), 'capital');
  const sBig = facScore(evaluateSector(big), 'capital');
  assert.ok(Math.abs(sSmall - sBig) < 3, `相对强度相同时，大小板块资金流分应接近，实际 ${sSmall} vs ${sBig}`);
});

test('资金流方向正确：净流入得分高于净流出', () => {
  const inflow = evaluateSector(makeSector({ capitalNet: 500000, capitalNet5d: 1200000, capitalNet20d: 2000000 }));
  const outflow = evaluateSector(makeSector({ capitalNet: -500000, capitalNet5d: -1200000, capitalNet20d: -2000000 }));
  assert.ok(
    facScore(inflow, 'capital') > facScore(outflow, 'capital'),
    `净流入分 ${facScore(inflow, 'capital')} 应高于净流出分 ${facScore(outflow, 'capital')}`,
  );
});

/* ════════════════════════════════════════════════════════════════
 * 6. 纯函数性
 * ════════════════════════════════════════════════════════════════ */

test('evaluateSector 不修改入参（深比较快照）', () => {
  const input = makeSector({ changePercent: 2.5, upCount: 88, downCount: 40 });
  const snapshot = JSON.parse(JSON.stringify(input));
  evaluateSector(input);
  assert.deepEqual(input, snapshot, 'evaluateSector 不应修改传入的 Sector 对象');
});

test('两次调用同一输入得到完全相同结果（确定性）', () => {
  const input = makeSector({ changePercent: 1.1, change5d: 3.3, upCount: 70, downCount: 40 });
  const a = JSON.stringify(evaluateSector(input));
  const b = JSON.stringify(evaluateSector(input));
  assert.equal(a, b);
});

/* ════════════════════════════════════════════════════════════════
 * 7. evaluateSectors 批量与排序
 * ════════════════════════════════════════════════════════════════ */

/** 一组分数/涨跌幅明确可区分的板块，用于排序测试。 */
function makeRankingSet() {
  return [
    makeSector({
      code: 'pt01', name: '甲板块',
      changePercent: 3, change5d: 9, change20d: 18, change60d: 25, changeYtd: 50,
      volumeRatio: 1.8, turnoverRate: 3, speed: 0.2,
      capitalNet: 600000, capitalNet5d: 1500000, capitalNet20d: 3000000,
      upCount: 120, downCount: 20,
      leader: { code: 'a', name: 'A龙头', price: 10, change: 1, changePercent: 10 },
    }),
    makeSector({
      code: 'pt02', name: '乙板块',
      changePercent: 0.2, change5d: 0.5, change20d: 1, change60d: 2, changeYtd: 5,
      volumeRatio: 1, turnoverRate: 1.8, speed: 0,
      capitalNet: 0, capitalNet5d: 0, capitalNet20d: 0,
      upCount: 50, downCount: 50,
      leader: { code: 'b', name: 'B龙头', price: 10, change: 0, changePercent: 3 },
    }),
    makeSector({
      code: 'pt03', name: '丙板块',
      changePercent: -3, change5d: -8, change20d: -20, change60d: -25, changeYtd: -30,
      volumeRatio: 0.6, turnoverRate: 0.4, speed: -0.15,
      capitalNet: -600000, capitalNet5d: -1500000, capitalNet20d: -3000000,
      upCount: 10, downCount: 120,
      leader: { code: 'c', name: 'C龙头', price: 10, change: -1, changePercent: -8 },
    }),
    makeSector({
      code: 'pt04', name: '丁板块',
      changePercent: 1, change5d: 2, change20d: 5, change60d: 8, changeYtd: 15,
      volumeRatio: 1.2, turnoverRate: 2.2, speed: 0.05,
      capitalNet: 200000, capitalNet5d: 400000, capitalNet20d: 900000,
      upCount: 80, downCount: 40,
      leader: { code: 'd', name: 'D龙头', price: 10, change: 0.5, changePercent: 6 },
    }),
  ];
}

test('evaluateSectors：默认按 score 降序，total 是排序前的总数', () => {
  const set = makeRankingSet();
  const { items, total } = evaluateSectors(set);
  assert.equal(total, 4);
  assert.equal(items.length, 4);
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(items[i - 1].score >= items[i].score, '默认应按 score 降序');
  }
  assert.equal(items[0].name, '甲板块');
  assert.equal(items[items.length - 1].name, '丙板块');
});

test('evaluateSectors：order=asc 与 desc 完全反向', () => {
  const set = makeRankingSet();
  const desc = evaluateSectors(set, { sortBy: 'score', order: 'desc' }).items.map((x) => x.code);
  const asc = evaluateSectors(set, { sortBy: 'score', order: 'asc' }).items.map((x) => x.code);
  assert.deepEqual(asc, desc.slice().reverse());
});

test('evaluateSectors：各 sortBy 字段都按该字段排序', () => {
  const set = makeRankingSet();
  for (const sortBy of ['score', 'changePercent', 'change5d', 'change20d', 'capitalNet']) {
    const asc = evaluateSectors(set, { sortBy, order: 'asc' }).items;
    for (let i = 1; i < asc.length; i += 1) {
      const prev = asc[i - 1][sortBy];
      const cur = asc[i][sortBy];
      if (prev === null || cur === null) continue;
      assert.ok(prev <= cur, `sortBy=${sortBy} 升序失败：${prev} > ${cur}`);
    }
    const desc = evaluateSectors(set, { sortBy, order: 'desc' }).items;
    for (let i = 1; i < desc.length; i += 1) {
      const prev = desc[i - 1][sortBy];
      const cur = desc[i][sortBy];
      if (prev === null || cur === null) continue;
      assert.ok(prev >= cur, `sortBy=${sortBy} 降序失败：${prev} < ${cur}`);
    }
  }
});

test('evaluateSectors：sortBy=name 按中文名排序，结果稳定可确定', () => {
  const set = makeRankingSet();
  const a = evaluateSectors(set, { sortBy: 'name', order: 'asc' }).items.map((x) => x.name);
  const b = evaluateSectors(set, { sortBy: 'name', order: 'asc' }).items.map((x) => x.name);
  assert.deepEqual(a, b, 'name 排序必须稳定');
  assert.equal(a.length, 4);
  // 只断言是字典序（不绑定具体 locale 的排序表）
  const sorted = a.slice().sort((x, y) => x.localeCompare(y, 'zh-Hans-CN'));
  assert.deepEqual(a, sorted);
});

test('evaluateSectors：limit 生效，total 不受 limit 影响', () => {
  const set = makeRankingSet();
  const { items, total } = evaluateSectors(set, { sortBy: 'score', order: 'desc', limit: 2 });
  assert.equal(total, 4, 'total 应是 limit 之前的总数');
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((x) => x.code), ['pt01', 'pt04']);

  // limit 大于总数时返回全部
  const all = evaluateSectors(set, { limit: 99 });
  assert.equal(all.items.length, 4);
  assert.equal(all.total, 4);

  // limit 非法值不生效
  for (const badLimit of [null, undefined, 0, -5, 'abc', NaN]) {
    const r = evaluateSectors(set, { limit: badLimit });
    assert.equal(r.items.length, 4, `limit=${String(badLimit)} 不应截断`);
  }
});

test('evaluateSectors：缺失排序字段的板块恒沉底（asc 和 desc 都一样）', () => {
  const set = [
    makeSector({ code: 'p1', name: '有数据', capitalNet: -1000 }),
    makeSector({ code: 'p2', name: '无数据', capitalNet: null }),
    makeSector({ code: 'p3', name: '有数据2', capitalNet: 5000 }),
  ];
  for (const order of ['asc', 'desc']) {
    const items = evaluateSectors(set, { sortBy: 'capitalNet', order }).items;
    assert.equal(items[items.length - 1].code, 'p2', `order=${order} 时 null 应沉底`);
  }
});

test('evaluateSectors：空数组 / 非数组输入返回 { items: [], total: 0 }', () => {
  for (const bad of [[], null, undefined, 'abc', 123]) {
    const r = evaluateSectors(bad);
    assert.deepEqual(r, { items: [], total: 0 });
  }
});

test('evaluateSectors：不修改入参数组顺序', () => {
  const set = makeRankingSet();
  const before = set.map((x) => x.code);
  evaluateSectors(set, { sortBy: 'score', order: 'asc' });
  assert.deepEqual(set.map((x) => x.code), before, 'evaluateSectors 不应就地排序入参');
});

/* ════════════════════════════════════════════════════════════════
 * 8. 全量属性测试：随机合成板块的恒等式
 * ════════════════════════════════════════════════════════════════ */

test('属性测试：任意随机板块都满足 score∈[0,100]、权重和=1、levels 为空', () => {
  // 确定性伪随机，避免测试结果抖动
  let seed = 20261107;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  for (let i = 0; i < 300; i += 1) {
    const maybeNull = (v) => (rand() < 0.25 ? null : v);
    const sec = makeSector({
      code: `pt${i}`,
      name: `板块${i}`,
      changePercent: maybeNull(Math.round((rand() - 0.5) * 200) / 10),
      change5d: maybeNull(Math.round((rand() - 0.5) * 600) / 10),
      change20d: maybeNull(Math.round((rand() - 0.5) * 800) / 10),
      change60d: maybeNull(Math.round((rand() - 0.5) * 1000) / 10),
      changeYtd: maybeNull(Math.round((rand() - 0.5) * 4000) / 10),
      volumeRatio: maybeNull(Math.round(rand() * 500) / 100),
      turnoverRate: maybeNull(Math.round(rand() * 4000) / 100),
      speed: maybeNull(Math.round((rand() - 0.5) * 100) / 100),
      floatCap: maybeNull(rand() < 0.1 ? 0 : Math.round(rand() * 200000)),
      upCount: maybeNull(Math.round(rand() * 500)),
      downCount: maybeNull(Math.round(rand() * 500)),
      capitalNet: maybeNull(Math.round((rand() - 0.5) * 3e6)),
      capitalNet5d: maybeNull(Math.round((rand() - 0.5) * 6e6)),
      capitalNet20d: maybeNull(Math.round((rand() - 0.5) * 2e7)),
      leader: rand() < 0.2 ? null : { code: 'x', name: '领涨', price: 10, change: 1, changePercent: maybeNull(Math.round((rand() - 0.3) * 300) / 10) },
    });

    const ev = evaluateSector(sec);
    assert.ok(ev.score >= 0 && ev.score <= 100, `score 越界：${ev.score}`);
    assert.ok(Number.isFinite(ev.score));
    assert.ok(ev.upProbability > 0 && ev.upProbability < 1, `upProbability 越界：${ev.upProbability}`);
    assert.ok(['strong-bull', 'bull', 'neutral', 'bear', 'strong-bear'].includes(ev.verdict));
    assert.deepEqual(ev.levels, { support: [], resistance: [] });

    const wsum = ev.factors.reduce((a, f) => a + f.weight, 0);
    assert.equal(Math.round(wsum * 1e9) / 1e9, 1);
    for (const f of ev.factors) {
      assert.ok(f.score >= 0 && f.score <= 100, `因子 ${f.key} 越界：${f.score}`);
      assert.ok(f.signals.length >= 2 && f.signals.length <= 5);
    }
    // verdict 与阈值一致
    const s = ev.score;
    const expected =
      s >= 75 ? 'strong-bull' : s >= 60 ? 'bull' : s >= 45 ? 'neutral' : s >= 30 ? 'bear' : 'strong-bear';
    assert.equal(ev.verdict, expected, `score=${s} 对应的 verdict 应为 ${expected}`);
  }
});

test('属性测试：evaluateSectors 在随机集合上排序结果单调且 total 正确', () => {
  let seed = 424242;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const set = [];
  for (let i = 0; i < 50; i += 1) {
    set.push(
      makeSector({
        code: `pt${String(i).padStart(4, '0')}`,
        name: `板块${i}`,
        changePercent: Math.round((rand() - 0.5) * 60) / 10,
        change5d: Math.round((rand() - 0.5) * 200) / 10,
        capitalNet: Math.round((rand() - 0.5) * 1e6),
      }),
    );
  }
  for (const sortBy of ['score', 'changePercent', 'change5d', 'capitalNet', 'name']) {
    for (const order of ['desc', 'asc']) {
      const { items, total } = evaluateSectors(set, { sortBy, order, limit: 10 });
      assert.equal(total, 50);
      assert.equal(items.length, 10);
      if (sortBy !== 'name') {
        for (let i = 1; i < items.length; i += 1) {
          const a = items[i - 1][sortBy];
          const b = items[i][sortBy];
          if (a === null || b === null) continue;
          if (order === 'desc') assert.ok(a >= b);
          else assert.ok(a <= b);
        }
      }
    }
  }
});
