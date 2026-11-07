/**
 * lib/sector.js 自测。
 * 第一部分：纯解析函数（喂实测原始响应文本，不联网）。
 * 第二部分：分页合并逻辑（纯函数，不联网）。
 * 第三部分：网络层（mock 全局 fetch，不联网）。
 * 第四部分：联网冒烟测试（网络失败时 skip，不 fail）。
 *
 * 运行：node --test tests/sector.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSector,
  fetchSectors,
  fetchSectorQuotes,
  fetchSector,
  parseSectorRank,
  parseSectorQuoteLine,
  mergeSectorPages,
  toNumber,
  parseZgb,
  clearSectorCache,
  SECTOR_BOARD_TYPES,
  SECTOR_PAGE_SIZE,
} from '../lib/sector.js';

// ---------------------------------------------------------------------------
// 实测抓下来的原始响应样本（腾讯接口真实返回，2026-11-07，原样粘贴）
// ---------------------------------------------------------------------------

/** hy 排行首页原文（实测 31 条，此处取前 2 条，结构与字段完全一致，UTF-8 JSON） */
const RAW_HY_PAGE1 = JSON.stringify({
  code: 0,
  msg: 'ok',
  data: {
    rank_list: [
      {
        code: 'pt01801120',
        hsl: '1.83',
        lb: '0.73',
        ltsz: '38977.92',
        lzg: { code: 'sh605339', name: '南侨食品', zd: '1.44', zdf: '10.03', zxj: '15.80' },
        name: '食品饮料',
        speed: '0.07',
        stock_type: 'BK-HY-1',
        turnover: '3162161',
        volume: '16920990.00',
        zd: '-33.36',
        zdf: '-0.22',
        zdf_d20: '8.71',
        zdf_d5: '3.89',
        zdf_d60: '5.65',
        zdf_w52: '-11.71',
        zdf_y: '-8.13',
        zgb: '24/122',
        zljlr: '-118309.84',
        zljlr_d20: '-310669.85',
        zljlr_d5: '-449986.25',
        zllc: '1121882.38',
        zllr: '1003572.54',
        zsz: '40092.99',
        zxj: '14898.96',
      },
      {
        code: 'pt01801110',
        hsl: '2.04',
        lb: '0.88',
        ltsz: '17169.76',
        lzg: { code: 'sh603366', name: '日出东方', zd: '0.82', zdf: '10.04', zxj: '8.99' },
        name: '家用电器',
        speed: '0.07',
        stock_type: 'BK-HY-1',
        turnover: '2131981',
        volume: '15391800.00',
        zd: '34.51',
        zdf: '0.40',
        zdf_d20: '2.37',
        zdf_d5: '2.47',
        zdf_d60: '-0.73',
        zdf_w52: '-6.20',
        zdf_y: '-6.75',
        zgb: '21/92',
        zljlr: '-26982.99',
        zljlr_d20: '-270874.23',
        zljlr_d5: '-209412.08',
        zllc: '668010.21',
        zllr: '641027.21',
        zsz: '19335.69',
        zxj: '8591.91',
      },
    ],
  },
});

/** hy2 排行原文首条：白酒Ⅱ（stock_type BK-HY-2） */
const RAW_HY2_ITEM = {
  code: 'pt01801125',
  hsl: '1.65',
  lb: '0.71',
  ltsz: '26589.08',
  lzg: { code: 'sh600809', name: '山西汾酒', zd: '1.68', zdf: '1.29', zxj: '132.00' },
  name: '白酒Ⅱ',
  speed: '0.13',
  stock_type: 'BK-HY-2',
  turnover: '1502058',
  volume: '2878595.00',
  zd: '-87.05',
  zdf: '-0.22',
  zdf_d20: '13.11',
  zdf_d5: '3.93',
  zdf_d60: '7.75',
  zdf_w52: '-14.11',
  zdf_y: '-8.22',
  zgb: '3/19',
  zljlr: '-76999.09',
  zljlr_d20: '214837.18',
  zljlr_d5: '-257608.46',
  zllc: '676510.62',
  zllr: '599511.53',
  zsz: '26715.85',
  zxj: '39675.26',
};

/** gn 排行末页原文首条：辅助生殖（stock_type BK-GN，注意不是 BK-GN-FG） */
const RAW_GN_ITEM = {
  code: 'pt02251415',
  hsl: '2.54',
  lb: '0.84',
  ltsz: '9019.12',
  lzg: { code: 'sz300147', name: '*ST香雪', zd: '0.23', zdf: '4.74', zxj: '5.08' },
  name: '辅助生殖',
  speed: '0.01',
  stock_type: 'BK-GN',
  turnover: '1877930',
  volume: '13052028.00',
  zd: '-9.23',
  zdf: '-1.78',
  zdf_d20: '-7.05',
  zdf_d5: '3.58',
  zdf_d60: '-0.86',
  zdf_w52: '-7.91',
  zdf_y: '-3.89',
  zgb: '12/78',
  zljlr: '-34568.37',
  zljlr_d20: '-441876.06',
  zljlr_d5: '-116128.83',
  zllc: '618467.84',
  zllr: '583899.47',
  zsz: '9869.19',
  zxj: '509.09',
};

function rankResponse(list, extra = {}) {
  return JSON.stringify({ code: 0, msg: 'ok', data: { rank_list: list }, ...extra });
}

/** count 给太大时服务端真实返回（实测 count=500） */
const RAW_COUNT_TOO_LARGE =
  '{"code":1619377101,"msg":"error_type=2 suggest=2 msg=参数错误:count too large"}';

/**
 * 板块 qt 接口是 **GBK 编码**的数字节流。为了让 mock 路径和真实路径完全一致
 * （连 TextDecoder('gbk') 解码都走一遍），这里保存的是实测抓下来的**原始字节的 base64**：
 *   GET https://qt.gtimg.cn/q=pt01801120,pt02GN2287,pt02B20001  ->  1042 字节
 * 用 new TextDecoder('gbk').decode(Buffer.from(QT_B64, 'base64')) 即可还原原文。
 */
const QT_B64 =
  'dl9wdDAxODAxMTIwPSIyfsqzxrfS+8HPfjAxODAxMTIwfjE0ODk4Ljk2fjE0OTMyLjMyfjE0ODc2LjQyfjE2OTIxMDAwLjAwMDB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH5+MjAyNjExMDYxNTAyNTh+LTMzLjM2fi0wLjIyfjE0OTMzLjE0fjE0ODAxLjU0fn4xNjkyMTAwMC4wMDAwfjMxNjIxNjIuMDAwMH4xLjgzfjIzLjExfn4xNDkzMy4xNH4xNDgwMS41NH4wLjg4fjM4OTc3LjkyfjQwMDkyLjk5fjMuNDl+LTF+LTF+MC43M34tOC4xM34zLjg5fjguNzF+Ny4zMH41LjY1fjE3NjY1Ljc4fjEyNzIxLjAzfi0xMi41Mn5CSy1IWS0xfjAuMDd+MTEuODh+LTExLjcxfjkyNzEzMDQxMzI3LjAiOwp2X3B0MDJHTjIyODc9IjJ+QUlQQ34wMkdOMjI4N34yMzcyLjUzfjI0NjEuMjR+MjMzNC45N34xNjg2NzY2OS4wMDAwfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+fjIwMjYxMTA2MTUwMDMzfi04OC43MX4tMy42MH4yNDEyLjI2fjIzMzQuOTd+fjE2ODY3NjY5LjAwMDB+NTA0ODMwMy4wMDAwfjIuMDJ+MjYuOTB+fjI0MTIuMjZ+MjMzNC45N34zLjE0fjE4NjYwLjA1fjIyNzQ4LjQ4fjMuMTJ+LTF+LTF+MC43Nn4wLjYyfjMuNzB+LTEyLjk1fi05Ljc2fi0xNS4yNn4zNTQ1LjU5fjIwNTUuNTJ+LTguMjV+QkstR05+MC4wNn4tMzIuNjN+Mi43NH44MzQxMTk1ODQ5OS4wIjsKdl9wdDAyQjIwMDAxPSIyfrDXvsa4xcTufjAyQjIwMDAxfjI5MjMuNjh+Mjk3OS41MX4yOTQ5Ljc1fjc3MjIzOTEuMDAwMH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfjB+MH4wfn4yMDI2MTEwNjE1MDAzM34tNTUuODN+LTEuODd+Mjk0OS43NX4yOTE4Ljk5fn43NzIyMzkxLjAwMDB+MTg2NDgxMy4wMDAwfjEuNn4yNy41Mn5+Mjk0OS43NX4yOTE4Ljk5fjEuMDN+Mjg2ODAuNjZ+Mjg4ODAuOTV+My40N34tMX4tMX4wLjcyfi0xMy43OH4zLjkzfi0yLjg3fjIuMjh+LTAuMDV+Mzc0Ni4yNX4yNjgwLjg5fi0yMC40NH5CSy1HTn4wLjF+My44MX4tMTguMjZ+NDgxMzU5ODk4NjUuMCI7Cg==';

/** 还原后的 GKB→文本（等价于真实 fetch 解码后的文本） */
const RAW_SECTOR_QT_GBK = new TextDecoder('gbk').decode(Buffer.from(QT_B64, 'base64'));

/** 板块 qt 响应原文（GBK 解码后的文本，实测 63 字段） */
const RAW_SECTOR_QT_PT01801120 =
  'v_pt01801120="2~食品饮料~01801120~14898.96~14932.32~14876.42~16921000.0000~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~20261106150258~-33.36~-0.22~14933.14~14801.54~~16921000.0000~3162162.0000~1.83~23.11~~14933.14~14801.54~0.88~38977.92~40092.99~3.49~-1~-1~0.73~-8.13~3.89~8.71~7.30~5.65~17665.78~12721.03~-12.52~BK-HY-1~0.07~11.88~-11.71~92713041327.0";';

const RAW_SECTOR_QT_GN =
  'v_pt02GN2287="2~AIPC~02GN2287~2372.53~2461.24~2334.97~16867669.0000~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~20261106150033~-88.71~-3.60~2412.26~2334.97~~16867669.0000~5048303.0000~2.02~26.90~~2412.26~2334.97~3.14~18660.05~22748.48~3.12~-1~-1~0.76~0.62~3.70~-12.95~-9.76~-15.26~3545.59~2055.52~-8.25~BK-GN~0.06~-32.63~2.74~83411958499.0";';

/** 两个板块 + 一条非法代码（非法代码服务端直接不返回该 key） */
const RAW_SECTOR_QT_MULTI = `${RAW_SECTOR_QT_PT01801120}\n${RAW_SECTOR_QT_GN}\n`;

/** 代码不存在时服务端真实返回 */
const RAW_SECTOR_QT_NONE = 'v_pv_none_match="1";\n';

// ---------------------------------------------------------------------------
// 1. toNumber：字符串转数字边界
// ---------------------------------------------------------------------------

test('toNumber: 空串 / 占位符 / null / 非法一律返回 null，绝不 NaN', () => {
  for (const bad of ['', '   ', '-', '--', '—', null, undefined, 'abc', '1.2.3', 'N/A', {}, [], true]) {
    assert.equal(toNumber(bad), null, `应当 null: ${JSON.stringify(bad)}`);
  }
});

test('toNumber: 正常数字字符串转数字', () => {
  assert.equal(toNumber('1.23'), 1.23);
  assert.equal(toNumber('-118309.84'), -118309.84);
  assert.equal(toNumber('14898.96'), 14898.96);
  assert.equal(toNumber(' 42 '), 42);
  assert.equal(toNumber('0'), 0);
  assert.equal(toNumber('-0.22'), -0.22);
});

test('toNumber: 数字输入透传，NaN/Infinity 归 null', () => {
  assert.equal(toNumber(1.23), 1.23);
  assert.equal(toNumber(0), 0);
  assert.equal(toNumber(NaN), null);
  assert.equal(toNumber(Infinity), null);
});

test('toNumber: 任何输入结果都不是 NaN', () => {
  for (const v of ['', '-', null, 'abc', '1.23', 'undefined', 'NaN', 'Infinity', '1e5']) {
    const n = toNumber(v);
    assert.ok(n === null || Number.isFinite(n), `不能是 NaN: ${JSON.stringify(v)}`);
  }
});

// ---------------------------------------------------------------------------
// 2. parseZgb：涨跌家数
// ---------------------------------------------------------------------------

test('parseZgb: "24/122" -> up 24 down 122（实测食品饮料）', () => {
  assert.deepEqual(parseZgb('24/122'), { upCount: 24, downCount: 122 });
});

test('parseZgb: 其它真实样本', () => {
  assert.deepEqual(parseZgb('3/19'), { upCount: 3, downCount: 19 });
  assert.deepEqual(parseZgb('12/78'), { upCount: 12, downCount: 78 });
  assert.deepEqual(parseZgb('61/481'), { upCount: 61, downCount: 481 });
  assert.deepEqual(parseZgb('0/0'), { upCount: 0, downCount: 0 });
});

test('parseZgb: 空格 / 连字符容错', () => {
  assert.deepEqual(parseZgb('24 / 122'), { upCount: 24, downCount: 122 });
  assert.deepEqual(parseZgb('24-122'), { upCount: 24, downCount: 122 });
});

test('parseZgb: 缺失 / 非法返回双 null', () => {
  for (const bad of ['', '-', null, undefined, 'abc', '24', 24, {}, [], 'a/b']) {
    assert.deepEqual(parseZgb(bad), { upCount: null, downCount: null }, `应当双 null: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// 3. normalizeSector
// ---------------------------------------------------------------------------

test('normalizeSector: 带 pt 前缀原样返回', () => {
  assert.deepEqual(normalizeSector('pt01801120'), {
    code: 'pt01801120',
    secid: 'pt01801120',
    name: null,
  });
});

test('normalizeSector: 大小写不敏感', () => {
  assert.deepEqual(normalizeSector('PT01801120'), {
    code: 'pt01801120',
    secid: 'pt01801120',
    name: null,
  });
  assert.deepEqual(normalizeSector('PT02GN2287'), {
    code: 'pt02gn2287',
    secid: 'pt02gn2287',
    name: null,
  });
});

test('normalizeSector: 缺 pt 前缀自动补', () => {
  assert.deepEqual(normalizeSector('01801120'), {
    code: 'pt01801120',
    secid: 'pt01801120',
    name: null,
  });
  assert.deepEqual(normalizeSector('02GN2287'), {
    code: 'pt02gn2287',
    secid: 'pt02gn2287',
    name: null,
  });
});

test('normalizeSector: 中文名经列表索引解析', () => {
  // 先喂一次真实响应，让模块建立 name -> code 索引
  const list = parseSectorRank(RAW_HY_PAGE1, 'hy');
  assert.equal(list[0].name, '食品饮料');
  assert.deepEqual(normalizeSector('食品饮料'), {
    code: 'pt01801120',
    secid: 'pt01801120',
    name: '食品饮料',
  });
  // 代码反查名字也能拿到
  assert.equal(normalizeSector('pt01801120').name, '食品饮料');
});

test('normalizeSector: 非法输入返回 null', () => {
  for (const bad of ['', '   ', 'abc', 'pt0180112', 'pt018011200', 'ptxx', '600519', null, undefined, 123, {}, []]) {
    assert.equal(normalizeSector(bad), null, `应当 null: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// 4. parseSectorRank：真实响应字段断言
// ---------------------------------------------------------------------------

test('parseSectorRank: 食品饮料字段逐一断言（真实原文）', () => {
  const list = parseSectorRank(RAW_HY_PAGE1, 'hy');
  assert.equal(list.length, 2);

  const s = list[0];
  assert.equal(s.code, 'pt01801120');
  assert.equal(s.name, '食品饮料');
  assert.equal(s.boardType, 'hy');
  assert.equal(s.stockType, 'BK-HY-1');

  // 数值字段全部是字符串，必须转成 number
  assert.equal(s.price, 14898.96); // zxj 板块点位
  assert.equal(s.change, -33.36); // zd
  assert.equal(s.changePercent, -0.22); // zdf
  assert.equal(s.change5d, 3.89); // zdf_d5
  assert.equal(s.change20d, 8.71); // zdf_d20
  assert.equal(s.change60d, 5.65); // zdf_d60
  assert.equal(s.change52w, -11.71); // zdf_w52
  assert.equal(s.changeYtd, -8.13); // zdf_y
  assert.equal(s.turnoverRate, 1.83); // hsl
  assert.equal(s.volumeRatio, 0.73); // lb
  assert.equal(s.speed, 0.07);
  assert.equal(s.totalCap, 40092.99); // zsz 亿元
  assert.equal(s.floatCap, 38977.92); // ltsz 亿元
  assert.equal(s.capitalNet, -118309.84); // zljlr 万元
  assert.equal(s.capitalNet5d, -449986.25);
  assert.equal(s.capitalNet20d, -310669.85);

  // zgb 拆分
  assert.equal(s.upCount, 24);
  assert.equal(s.downCount, 122);

  // 领涨股
  assert.deepEqual(s.leader, {
    code: 'sh605339',
    name: '南侨食品',
    price: 15.8,
    change: 1.44,
    changePercent: 10.03,
  });
});

test('parseSectorRank: 第二条家用电器字段正确', () => {
  const list = parseSectorRank(RAW_HY_PAGE1, 'hy');
  const s = list[1];
  assert.equal(s.code, 'pt01801110');
  assert.equal(s.name, '家用电器');
  assert.equal(s.changePercent, 0.4);
  assert.equal(s.change5d, 2.47);
  assert.equal(s.change60d, -0.73);
  assert.equal(s.upCount, 21);
  assert.equal(s.downCount, 92);
  assert.equal(s.leader.name, '日出东方');
});

test('parseSectorRank: boardType 透传到每条（hy2 / gn）', () => {
  const hy2 = parseSectorRank(rankResponse([RAW_HY2_ITEM]), 'hy2');
  assert.equal(hy2.length, 1);
  assert.equal(hy2[0].boardType, 'hy2');
  assert.equal(hy2[0].stockType, 'BK-HY-2');
  assert.equal(hy2[0].name, '白酒Ⅱ');
  assert.equal(hy2[0].changePercent, -0.22);
  assert.equal(hy2[0].change20d, 13.11);
  assert.equal(hy2[0].capitalNet20d, 214837.18); // 正数也有
  assert.equal(hy2[0].upCount, 3);
  assert.equal(hy2[0].downCount, 19);

  const gn = parseSectorRank(rankResponse([RAW_GN_ITEM]), 'gn');
  assert.equal(gn[0].boardType, 'gn');
  assert.equal(gn[0].stockType, 'BK-GN');
  assert.equal(gn[0].name, '辅助生殖');
  assert.equal(gn[0].changePercent, -1.78);
  assert.equal(gn[0].leader.name, '*ST香雪');
});

test('parseSectorRank: 字段缺失/非法 -> null，不出现 NaN', () => {
  const broken = {
    code: 'pt01999999',
    name: '测试板块',
    stock_type: 'BK-HY-1',
    zxj: '',
    zd: '-',
    zdf: 'abc',
    zdf_d5: null,
    zgb: '-',
    lzg: null,
  };
  const list = parseSectorRank(rankResponse([broken]), 'hy');
  assert.equal(list.length, 1);
  const s = list[0];
  for (const k of [
    'price',
    'change',
    'changePercent',
    'change5d',
    'change20d',
    'change60d',
    'change52w',
    'changeYtd',
    'turnoverRate',
    'volumeRatio',
    'speed',
    'totalCap',
    'floatCap',
    'upCount',
    'downCount',
    'capitalNet',
    'capitalNet5d',
    'capitalNet20d',
  ]) {
    assert.equal(s[k], null, `${k} 应当 null`);
  }
  assert.equal(s.leader, null);
});

test('parseSectorRank: Sector 字段名与契约一致（不多不少核心字段）', () => {
  const s = parseSectorRank(RAW_HY_PAGE1, 'hy')[0];
  const required = [
    'code',
    'name',
    'boardType',
    'stockType',
    'price',
    'change',
    'changePercent',
    'change5d',
    'change20d',
    'change60d',
    'change52w',
    'changeYtd',
    'turnoverRate',
    'volumeRatio',
    'speed',
    'totalCap',
    'floatCap',
    'upCount',
    'downCount',
    'capitalNet',
    'capitalNet5d',
    'capitalNet20d',
    'leader',
  ];
  for (const k of required) assert.ok(k in s, `缺少契约字段 ${k}`);
});

test('parseSectorRank: 服务端报错原文（count too large）-> []', () => {
  assert.deepEqual(parseSectorRank(RAW_COUNT_TOO_LARGE, 'gn'), []);
});

test('parseSectorRank: 非法输入 -> []', () => {
  for (const bad of ['', '  ', 'not json', 'null', '[]', '{}', '{"code":0}', '{"code":0,"data":null}']) {
    assert.deepEqual(parseSectorRank(bad, 'hy'), [], `应当空数组: ${bad}`);
  }
  assert.deepEqual(parseSectorRank(null, 'hy'), []);
  assert.deepEqual(parseSectorRank(RAW_HY_PAGE1, 'wat'), parseSectorRank(RAW_HY_PAGE1, 'hy'));
});

test('parseSectorRank: 跳过缺 code 的脏条目', () => {
  const dirty = { ...RAW_HY2_ITEM };
  delete dirty.code;
  const list = parseSectorRank(rankResponse([dirty, RAW_HY2_ITEM]), 'hy2');
  assert.equal(list.length, 1);
  assert.equal(list[0].code, 'pt01801125');
});

// ---------------------------------------------------------------------------
// 5. mergeSectorPages：分页合并去重
// ---------------------------------------------------------------------------

test('mergeSectorPages: 按 code 去重且保留首次出现顺序', () => {
  const p1 = parseSectorRank(RAW_HY_PAGE1, 'hy');
  const p2 = parseSectorRank(rankResponse([RAW_HY2_ITEM]), 'hy2');
  const merged = mergeSectorPages([p1, p2]);
  assert.deepEqual(
    merged.map((x) => x.code),
    ['pt01801120', 'pt01801110', 'pt01801125'],
  );
});

test('mergeSectorPages: 跨页重复只保留首条', () => {
  const a = parseSectorRank(RAW_HY_PAGE1, 'hy');
  const dup = parseSectorRank(RAW_HY_PAGE1, 'hy');
  const merged = mergeSectorPages([a, dup]);
  assert.equal(merged.length, 2, '重复整页应被去重');
});

test('mergeSectorPages: 空页 / 非法页容错', () => {
  assert.deepEqual(mergeSectorPages([]), []);
  assert.deepEqual(mergeSectorPages([[], [], []]), []);
  assert.deepEqual(mergeSectorPages(null), []);
  assert.deepEqual(mergeSectorPages([null, undefined, []]), []);
  const a = parseSectorRank(RAW_HY_PAGE1, 'hy');
  assert.equal(mergeSectorPages([a, null, [], undefined]).length, 2);
});

test('mergeSectorPages: 跳过没有 code 的条目', () => {
  const merged = mergeSectorPages([[{ name: 'no code' }, { code: 'pt01801120', name: 'x' }]]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].code, 'pt01801120');
});

// ---------------------------------------------------------------------------
// 6. parseSectorQuoteLine：板块实时行情（GBK qt）
// ---------------------------------------------------------------------------

test('parseSectorQuoteLine: 食品饮料真实行', () => {
  const q = parseSectorQuoteLine(RAW_SECTOR_QT_PT01801120);
  assert.ok(q, '应当解析成功');
  assert.equal(q.code, 'pt01801120');
  assert.equal(q.name, '食品饮料');
  assert.equal(q.price, 14898.96);
  assert.equal(q.prevClose, 14932.32);
  assert.equal(q.open, 14876.42);
  assert.equal(q.change, -33.36);
  assert.equal(q.changePercent, -0.22);
  assert.equal(q.high, 14933.14);
  assert.equal(q.low, 14801.54);
  assert.equal(q.turnoverRate, 1.83);
  assert.equal(q.volumeRatio, 0.73);
  assert.equal(q.speed, 0.07);
  assert.equal(q.stockType, 'BK-HY-1');
  assert.equal(q.time, '20261106150258');
  assert.equal(q.changeYtd, -8.13);
  assert.equal(q.change5d, 3.89);
  assert.equal(q.change20d, 8.71);
  assert.equal(q.change52w, -11.71);
});

test('parseSectorQuoteLine: 概念板块 AIPC（代码含字母）', () => {
  const q = parseSectorQuoteLine(RAW_SECTOR_QT_GN);
  assert.ok(q);
  // 板块代码大小写敏感：真实代码就是 pt02GN2287，小写化后 qt 接口会返回
  // v_pv_none_match，因此解析必须保留原样。
  assert.equal(q.code, 'pt02GN2287');
  assert.equal(q.name, 'AIPC');
  assert.equal(q.price, 2372.53);
  assert.equal(q.changePercent, -3.6);
  assert.equal(q.stockType, 'BK-GN');
});

test('GBK 解码路径：同一份原始字节用 utf-8 解码会乱码，用 gbk 才正确', () => {
  const bytes = Buffer.from(QT_B64, 'base64');
  const bad = new TextDecoder('utf-8').decode(bytes);
  assert.ok(!bad.includes('食品饮料'), 'UTF-8 解码不应得到正确中文（证明原始字节确实是 GBK）');
  assert.ok(RAW_SECTOR_QT_GBK.includes('食品饮料'));
  assert.ok(RAW_SECTOR_QT_GBK.includes('AIPC'));
  // mock 拿到的是字节，解析前必须按 GBK 解
  const q = parseSectorQuoteLine(RAW_SECTOR_QT_GBK.split(';')[0] + ';');
  assert.equal(q.name, '食品饮料');
});

test('parseSectorQuoteLine: 代码不存在（v_pv_none_match）-> null', () => {
  assert.equal(parseSectorQuoteLine(RAW_SECTOR_QT_NONE), null);
  assert.equal(parseSectorQuoteLine('v_pv_none_match="1"'), null);
});

test('parseSectorQuoteLine: 个股行不被当成板块', () => {
  const stockLine =
    'v_sh600519="1~贵州茅台~600519~1453.00~1452.00~1450.00~42848~23139~19709~1452.00~2~1451.60~1~1451.33~1~1451.01~1~1451.00~5~1453.00~2~1453.01~2~1453.06~1~1453.07~8~1453.19~1~~20261106161458~1.00~0.07~1457.72~1436.00~1453.00/42848/6199528289~42848~619953~0.34~22.11~~1457.72~1436.00~1.50~18163.69~18163.69~6.70~1597.20~1306.80~0.65~-4~1446.87~21.13~22.06";';
  assert.equal(parseSectorQuoteLine(stockLine), null);
});

test('parseSectorQuoteLine: 字段太少 / 非法输入 -> null', () => {
  for (const bad of ['', '   ', 'v_pt01801120="2~食品饮料~01801120";', 'garbage', null, undefined, 1]) {
    assert.equal(parseSectorQuoteLine(bad), null, `应当 null: ${JSON.stringify(bad)}`);
  }
});

test('parseSectorQuoteLine: 任意输入都不抛异常', () => {
  const weird = [
    'v_pt01801120=""',
    `v_pt01801120="${'~'.repeat(40)}"`,
    'v_pt01801120="2~~~";',
    '=;;;',
  ];
  for (const w of weird) {
    assert.doesNotThrow(() => parseSectorQuoteLine(w));
  }
});

// ---------------------------------------------------------------------------
// 7. 网络层（mock 全局 fetch）
// ---------------------------------------------------------------------------

/**
 * 用假的 fetch 替换全局 fetch，跑完恢复。
 * routes: (url:string) => { ok?, status?, body?:string, hang?:boolean, text?:string }
 *   hang=true 时返回一个永不 resolve 的 promise，只在 abort 时 reject（模拟超时）。
 *
 * 注意：mock 期间同步执行，不 await 任何真实 IO 之外的东西；恢复放在 finally 里，
 * 避免残留的 pending promise 让测试进程提前退出。
 */
let mockLock = Promise.resolve();

async function withMockFetch(routes, fn) {
  // 全局 fetch 是共享的，mock 必须串行，否则并发测试会互相踩
  const prev = mockLock;
  let release;
  mockLock = new Promise((r) => {
    release = r;
  });
  await prev;

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const r = routes(u);
    if (r === undefined) {
      return Promise.reject(new Error(`unexpected url ${u}`));
    }
    if (r && r.hang) {
      // 永不 resolve 的 promise 本身不占事件循环句柄；如果此时没有别的活跃句柄，
      // Node 会认为事件循环已空直接退出（exit 13）。用一个**不 unref** 的长定时器挂住进程，
      // abort 时连同定时器一起清掉。
      return new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 60000);
        const sig = init && init.signal;
        const fail = () => {
          clearTimeout(keepAlive);
          reject(new Error('aborted'));
        };
        if (!sig) return; // 永不 resolve，由调用方超时兜底
        if (sig.aborted) return fail();
        sig.addEventListener('abort', fail, { once: true });
      });
    }
    // body 可以是字符串（UTF-8 文本，排行 JSON）或 Uint8Array（GBK 原始字节，qt 接口）
    const raw = typeof r === 'string' ? r : r.body ?? '';
    const status = typeof r === 'string' ? 200 : r.status ?? 200;
    const ok = typeof r === 'string' ? true : r.ok ?? status === 200;
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    return Promise.resolve({
      ok,
      status,
      // 注意必须给真实字节长度：httpGetText 会用 buf.length === 0 判空响应
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
    clearSectorCache();
    release();
  }
}

function rankRoute(pageMap) {
  return (url) => {
    if (!url.includes('/rank/pt/getRank')) return undefined;
    const q = new URL(url).searchParams;
    const bt = q.get('board_type');
    const offset = Number(q.get('offset'));
    const count = Number(q.get('count'));
    const page = pageMap[bt]?.[offset];
    if (page === undefined) return rankResponse([]);
    // 真接口 count>100 直接报错（模拟这个坑）
    if (count > 100) return RAW_COUNT_TOO_LARGE;
    // page 可以是原始 JSON 文本（优先），否则按数组包成 rank 响应。
    // 注意：不要在这里返回"已解析对象"，真实接口返回的是文本，
    // 而且事先调用 parseSectorRank 会提前污染模块级名字索引，掩盖真实行为。
    if (typeof page === 'string') return page;
    return rankResponse(page);
  };
}

/** 造 N 条假板块（code 位数与真实一致：pt02 + 6 位） */
function fakeItems(n, prefix = '01') {
  return Array.from({ length: n }, (_, i) => ({
    ...RAW_HY2_ITEM,
    code: `pt02${prefix}${String(i).padStart(4, '0')}`,
    name: `假板块${i}`,
  }));
}

test('fetchSectors: 自动分页翻到末页（124 条 = 100 + 24）', async () => {
  const p0 = fakeItems(100, '11');
  const p1 = fakeItems(24, '22');
  await withMockFetch(rankRoute({ hy2: { 0: p0, 100: p1 } }), async (calls) => {
    const list = await fetchSectors({ boardType: 'hy2' });
    assert.equal(list.length, 124);
    assert.equal(list[0].code, 'pt02110000');
    assert.equal(list[99].code, 'pt02110099');
    assert.equal(list[100].code, 'pt02220000');
    // 恰好 2 次请求：offset=0 和 offset=100，count 必须是 100
    assert.equal(calls.length, 2);
    for (const c of calls) {
      const q = new URL(c).searchParams;
      assert.equal(q.get('count'), '100', 'count 不能超过 100');
      assert.equal(q.get('board_type'), 'hy2');
    }
    assert.deepEqual(
      calls.map((c) => new URL(c).searchParams.get('offset')),
      ['0', '100'],
    );
  });
});

test('fetchSectors: 首页不足 100 条时只发一次请求（hy=31）', async () => {
  await withMockFetch(rankRoute({ hy: { 0: fakeItems(31, '11') } }), async (calls) => {
    const list = await fetchSectors({ boardType: 'hy' });
    assert.equal(list.length, 31);
    assert.equal(calls.length, 1);
  });
});

test('fetchSectors: 正合 100 条会再探一页，遇到空页停止', async () => {
  await withMockFetch(rankRoute({ gn: { 0: fakeItems(100, '11'), 100: [] } }), async (calls) => {
    const list = await fetchSectors({ boardType: 'gn' });
    assert.equal(list.length, 100);
    assert.equal(calls.length, 2, '第二页空即停，不会继续翻');
  });
});

test('fetchSectors: 跨页重复被去重（顺序稳定）', async () => {
  const p0 = fakeItems(100, '11');
  // 第二页故意重复第一页的后 4 条 + 5 条新的
  const p1 = [p0[96], p0[97], p0[98], p0[99], ...fakeItems(5, '22')];
  await withMockFetch(rankRoute({ gn: { 0: p0, 100: p1, 200: [] } }), async () => {
    const list = await fetchSectors({ boardType: 'gn' });
    assert.equal(list.length, 105);
    const codes = list.map((x) => x.code);
    assert.equal(new Set(codes).size, 105, '不能有重复 code');
    // 顺序稳定：首次出现的顺序
    assert.deepEqual(codes.slice(0, 3), ['pt02110000', 'pt02110001', 'pt02110002']);
    assert.equal(codes[100], 'pt02220000');
  });
});

test('fetchSectors: 默认 boardType = hy', async () => {
  await withMockFetch(rankRoute({ hy: { 0: fakeItems(3, '11') } }), async (calls) => {
    const list = await fetchSectors();
    assert.equal(list.length, 3);
    assert.equal(new URL(calls[0]).searchParams.get('board_type'), 'hy');
  });
});

test('fetchSectors: 非法 boardType 抛 astock 前缀错误', async () => {
  await assert.rejects(() => fetchSectors({ boardType: 'xx' }), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /^astock: /, 'message 必须以 astock: 开头');
    return true;
  });
});

test('fetchSectors: 首页空 -> 抛错而不是静默返回 []', async () => {
  await withMockFetch(rankRoute({ hy: {} }), async () => {
    await assert.rejects(() => fetchSectors({ boardType: 'hy' }), /^Error: astock: /);
  });
});

test('fetchSectors: HTTP 非 200 抛 astock 前缀错误', async () => {
  await withMockFetch(() => ({ status: 500, ok: false, body: 'boom' }), async () => {
    await assert.rejects(() => fetchSectors({ boardType: 'hy', timeoutMs: 3000 }), /astock: 接口返回 HTTP 500/);
  });
});

test('fetchSectors: 30 秒缓存（第二次不再请求）', async () => {
  await withMockFetch(rankRoute({ hy: { 0: fakeItems(5, '11') } }), async (calls) => {
    await fetchSectors({ boardType: 'hy' });
    const n1 = calls.length;
    await fetchSectors({ boardType: 'hy' });
    assert.equal(calls.length, n1, '缓存命中不应再请求');
    // noCache 强刷会重新请求
    await fetchSectors({ boardType: 'hy', noCache: true });
    assert.equal(calls.length, n1 + 1, 'noCache 应当绕缓存');
  });
});

test('fetchSectors: 外部 signal 已 abort 时立即抛错', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => fetchSectors({ boardType: 'hy', signal: ac.signal }), /astock: 请求已被外部取消/);
});

test('fetchSectors: 超时抛 astock 前缀错误', async () => {
  await withMockFetch(() => ({ hang: true }), async () => {
    await assert.rejects(
      () => fetchSectors({ boardType: 'hy', timeoutMs: 50 }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^astock: 请求超时/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 8. fetchSectorQuotes（mock）
// ---------------------------------------------------------------------------

test('fetchSectorQuotes: 与入参同序，查不到的为 null', async () => {
  await withMockFetch(
    (url) => {
      assert.ok(url.startsWith('https://qt.gtimg.cn/q='), `应走 qt 接口: ${url}`);
      return { ok: true, status: 200, body: Buffer.from(QT_B64, 'base64') };
    },
    async (calls) => {
      const res = await fetchSectorQuotes(['pt01801120', 'pt02GN2287', 'pt99999999']);
      assert.equal(res.length, 3);
      assert.equal(res[0].name, '食品饮料');
      assert.equal(res[1].name, 'AIPC');
      assert.equal(res[2], null, '查不到应为 null');
      // 只请求一次（同一批）
      assert.equal(calls.length, 1);
      // 板块代码原样传，不能被个股 normalizeCode 改掉
      assert.match(calls[0], /pt01801120/, '板块代码必须原样传');
      assert.match(calls[0], /pt02GN2287/);
    },
  );
});

test('fetchSectorQuotes: 非法输入与空数组不联网', async () => {
  await withMockFetch(() => undefined, async (calls) => {
    assert.deepEqual(await fetchSectorQuotes([]), []);
    assert.deepEqual(await fetchSectorQuotes(['600519', null, '']), [null, null, null]);
    assert.equal(calls.length, 0, '非法代码不应发起请求');
  });
});

test('fetchSectorQuotes: 单字符串入参也接受', async () => {
  await withMockFetch(
    () => ({ ok: true, status: 200, body: Buffer.from(QT_B64, 'base64') }),
    async () => {
    const res = await fetchSectorQuotes('pt01801120');
    assert.equal(res.length, 1);
    assert.equal(res[0].code, 'pt01801120');
  });
});

// ---------------------------------------------------------------------------
// 9. fetchSector（mock）
// ---------------------------------------------------------------------------

test('fetchSector: 按代码在列表中找到单条', async () => {
  await withMockFetch(rankRoute({ hy: { 0: RAW_HY_PAGE1 } }), async () => {
    const s = await fetchSector('pt01801120', { boardType: 'hy' });
    assert.ok(s);
    assert.equal(s.name, '食品饮料');
    assert.equal(s.changePercent, -0.22);
  });
});

test('fetchSector: 按中文名找到（需先加载过列表）', async () => {
  await withMockFetch(rankRoute({ hy: { 0: RAW_HY_PAGE1 } }), async () => {
    await fetchSectors({ boardType: 'hy' }); // 建立名字索引
    const s = await fetchSector('食品饮料', { boardType: 'hy' });
    assert.ok(s);
    assert.equal(s.code, 'pt01801120');
  });
});

test('fetchSector: 查不到返回 null', async () => {
  await withMockFetch(rankRoute({ hy: { 0: RAW_HY_PAGE1 } }), async () => {
    const s = await fetchSector('pt02999999', { boardType: 'hy' });
    assert.equal(s, null);
  });
});

test('fetchSector: 非法输入返回 null，不联网', async () => {
  await withMockFetch(() => undefined, async (calls) => {
    assert.equal(await fetchSector('abc'), null);
    assert.equal(await fetchSector(null), null);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 10. 导出常量
// ---------------------------------------------------------------------------

test('导出常量：支持的类型与分页上限', () => {
  assert.deepEqual([...SECTOR_BOARD_TYPES], ['hy', 'hy2', 'gn']);
  assert.equal(SECTOR_PAGE_SIZE, 100, 'count 上限必须是 100');
});

// ---------------------------------------------------------------------------
// 11. 联网冒烟测试（失败则 skip，不算 fail）
// ---------------------------------------------------------------------------

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

test('联网: fetchSectors hy 取到 31 条一级行业', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearSectorCache();
  const list = await fetchSectors({ boardType: 'hy' });
  assert.equal(list.length, 31);
  assert.ok(list.every((s) => s.boardType === 'hy' && s.code.startsWith('pt')));
  assert.ok(list.every((s) => Number.isFinite(s.price) || s.price === null));
});

test('联网: fetchSectors hy2 分页取到 124 条二级行业', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearSectorCache();
  const list = await fetchSectors({ boardType: 'hy2' });
  assert.equal(list.length, 124);
  assert.equal(new Set(list.map((s) => s.code)).size, 124, '分页合并后不能有重复');
});

test('联网: fetchSectors gn 分页取到 805 条概念板块', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearSectorCache();
  const list = await fetchSectors({ boardType: 'gn' });
  assert.equal(list.length, 805);
  assert.equal(new Set(list.map((s) => s.code)).size, 805);
  // 列表顺序稳定：两次调用结果一致（走缓存也一样）
  const again = await fetchSectors({ boardType: 'gn' });
  assert.deepEqual(
    again.map((s) => s.code),
    list.map((s) => s.code),
  );
});

test('联网: fetchSector 按代码取食品饮料', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  clearSectorCache();
  const s = await fetchSector('pt01801120', { boardType: 'hy' });
  assert.ok(s, '应当取到食品饮料');
  assert.equal(s.name, '食品饮料');
  assert.equal(typeof s.changePercent, 'number');
});

test('联网: fetchSectorQuotes 板块实时行情（GBK）', async (t) => {
  if (!(await isOnline())) return t.skip('网络不可达腾讯接口，跳过联网测试');
  const res = await fetchSectorQuotes(['pt01801120', 'pt02GN2287']);
  assert.equal(res.length, 2);
  const q = res[0];
  assert.ok(q, '板块行情应可解析');
  assert.equal(q.name, '食品饮料');
  assert.ok(Number.isFinite(q.price));
  assert.equal(typeof q.stockType, 'string');
});
