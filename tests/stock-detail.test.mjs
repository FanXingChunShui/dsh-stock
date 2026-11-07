/**
 * lib/stock-detail.js 单元测试。
 *
 * 解析类用例使用实测抓到的真实响应结构；联网冒烟失败时 skip 而非 fail。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toEastmoneyCode,
  toF10Code,
  parseCompanyProfile,
  parseAnnouncements,
  fetchCompanyProfile,
  fetchAnnouncements,
  findEastmoneyBoardCode,
  fetchBoardConstituents,
  clearDetailCache,
} from '../lib/stock-detail.js';

/* ════════════════════════════════════════════════════════════════
 * 1. 代码格式转换
 * ════════════════════════════════════════════════════════════════ */

test('toEastmoneyCode: A 股转东财格式，港美股返回 null', () => {
  assert.equal(toEastmoneyCode('sh600519'), '600519.SH');
  assert.equal(toEastmoneyCode('sz000001'), '000001.SZ');
  assert.equal(toEastmoneyCode('bj430047'), '430047.BJ');
  assert.equal(toEastmoneyCode('hk00700'), null);
  assert.equal(toEastmoneyCode('usAAPL'), null);
  assert.equal(toEastmoneyCode(''), null);
});

test('toF10Code: 转 F10 要求的前缀格式', () => {
  // F10 只认 SH600519 / sh600519，不认 600519 与 SH.600519（实测）
  assert.equal(toF10Code('600519.SH'), 'SH600519');
  assert.equal(toF10Code('000001.SZ'), 'SZ000001');
  assert.equal(toF10Code('430047.BJ'), 'BJ430047');
});

/* ════════════════════════════════════════════════════════════════
 * 2. 公司概况解析
 * ════════════════════════════════════════════════════════════════ */

const PROFILE_PAYLOAD = {
  jbzl: [{
    SECUCODE: '600519.SH',
    SECURITY_CODE: '600519',
    SECURITY_NAME_ABBR: '贵州茅台',
    ORG_NAME: '贵州茅台酒股份有限公司',
    ORG_NAME_EN: 'Kweichow Moutai Co.,Ltd.',
    ORG_PROFILE: '贵州茅台酒股份有限公司成立于1999年11月20日，\n主营茅台酒及系列酒。',
    BUSINESS_SCOPE: '茅台酒及系列酒的生产与销售;饮料、食品的生产、销售',
    INDUSTRYCSRC1: '制造业-酒、饮料和精制茶制造业',
    CHAIRMAN: '陈华',
    ORG_WEB: 'www.moutaichina.com',
    REG_ADDRESS: '贵州省仁怀市茅台镇',
    ORG_TEL: '0851-22386002',
    REG_CAPITAL: '125008.1601',
    // 注意：这个字段在真实响应里是数字，不是字符串
    EMP_NUM: 34992,
  }],
};

test('parseCompanyProfile: 字段全部正确，数字字段不丢', () => {
  const p = parseCompanyProfile(PROFILE_PAYLOAD);
  assert.ok(p);
  assert.equal(p.code, '600519');
  assert.equal(p.name, '贵州茅台酒股份有限公司');
  assert.equal(p.industry, '制造业-酒、饮料和精制茶制造业');
  assert.equal(p.chairman, '陈华');
  assert.equal(p.website, 'www.moutaichina.com');
  // 数字类型字段必须转成字符串而不是空串
  assert.equal(p.employees, '34992');
  assert.equal(p.regCapital, '125008.1601');
  // 换行被压成一行
  assert.ok(!p.profile.includes('\n'), '简介里的换行应被压平');
  assert.ok(p.profile.length > 0);
  assert.ok(p.businessScope.length > 0);
});

test('parseCompanyProfile: 空响应返回 null', () => {
  assert.equal(parseCompanyProfile(null), null);
  assert.equal(parseCompanyProfile({}), null);
  assert.equal(parseCompanyProfile({ jbzl: [] }), null);
  // F10 传错 code 时会返回 { status, message }，没有 jbzl
  assert.equal(parseCompanyProfile({ status: 1, message: 'error' }), null);
});

/* ════════════════════════════════════════════════════════════════
 * 3. 公告解析
 * ════════════════════════════════════════════════════════════════ */

test('parseAnnouncements: 解析真实公告结构', () => {
  const payload = {
    data: {
      list: [
        { title: '贵州茅台2026年第三季度报告', notice_date: '2026-10-31 00:00:00', art_code: 'AN123', codes: [{ stock_code: '600519' }], columns: [{ column_name: '定期报告' }] },
        { title: '关于召开业绩说明会的公告', notice_date: '2026-11-03 00:00:00', art_code: 'AN456', codes: [{ stock_code: '600519' }], columns: [] },
      ],
    },
  };
  const list = parseAnnouncements(payload);
  assert.equal(list.length, 2);
  assert.equal(list[0].title, '贵州茅台2026年第三季度报告');
  assert.equal(list[0].date, '2026-10-31');
  assert.equal(list[0].type, '定期报告');
  assert.ok(list[0].url.includes('AN123'));
});

test('parseAnnouncements: 异常输入返回空数组', () => {
  assert.deepEqual(parseAnnouncements(null), []);
  assert.deepEqual(parseAnnouncements({}), []);
  assert.deepEqual(parseAnnouncements({ data: null }), []);
  assert.deepEqual(parseAnnouncements({ data: { list: [null, {}, { title: '' }] } }), []);
});

/* ════════════════════════════════════════════════════════════════
 * 4. 港美股不调用 F10
 * ════════════════════════════════════════════════════════════════ */

test('fetchCompanyProfile: 港美股直接返回 null，不发请求', async () => {
  assert.equal(await fetchCompanyProfile('hk00700'), null);
  assert.equal(await fetchCompanyProfile('usAAPL'), null);
});

test('fetchAnnouncements: 港美股返回空数组', async () => {
  assert.deepEqual(await fetchAnnouncements('hk00700'), []);
  assert.deepEqual(await fetchAnnouncements('usAAPL'), []);
});

/* ════════════════════════════════════════════════════════════════
 * 5. 联网冒烟（失败 skip）
 * ════════════════════════════════════════════════════════════════ */

test('联网：取茅台公司资料', async (t) => {
  clearDetailCache();
  let profile;
  try {
    profile = await fetchCompanyProfile('sh600519', { noCache: true, timeoutMs: 20000 });
  } catch (error) {
    t.skip(`网络不可用：${error.message}`);
    return;
  }
  if (profile === null) {
    t.skip('F10 接口返回空（可能被限流）');
    return;
  }
  assert.equal(profile.code, '600519');
  assert.ok(profile.name.includes('茅台'), `公司名应含茅台，实际 ${profile.name}`);
  assert.ok(profile.profile.length > 20, '公司简介应有实际内容');
});

test('联网：取茅台最新公告', async (t) => {
  let list;
  try {
    list = await fetchAnnouncements('sh600519', { limit: 5, noCache: true, timeoutMs: 20000 });
  } catch (error) {
    t.skip(`网络不可用：${error.message}`);
    return;
  }
  if (list.length === 0) {
    t.skip('公告接口返回空（可能被限流）');
    return;
  }
  assert.ok(list.length <= 5);
  assert.ok(list[0].title.length > 0);
});

test('联网：白酒板块成分股', async (t) => {
  let cons;
  try {
    const boardCode = await findEastmoneyBoardCode('白酒', { timeoutMs: 20000 });
    if (boardCode === null) {
      t.skip('未找到白酒板块码');
      return;
    }
    cons = await fetchBoardConstituents(boardCode, { noCache: true, timeoutMs: 20000 });
  } catch (error) {
    t.skip(`网络不可用：${error.message}`);
    return;
  }
  assert.ok(cons.length > 10, `白酒成分股应超过 10 只，实际 ${cons.length}`);
  assert.ok(cons.every((c) => typeof c.code === 'string' && c.code.length === 6));
  assert.ok(cons.some((c) => c.secid && c.secid.startsWith('sh') || c.secid && c.secid.startsWith('sz')));
});
