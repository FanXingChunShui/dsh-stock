/**
 * Model-facing tools for dsh-stock-surf.
 *
 * Three deliberately small tools: evaluate one or more codes, read realtime
 * snapshots, and resolve a code from a name. Every tool returns the plain
 * evaluation object so the model can reason over the numbers, and renders a
 * compact Chinese summary for the conversation.
 *
 * @module dsh-stock-surf/tools
 */
import { fetchQuotes, searchSymbols, loadStockData, normalizeCode } from './quote.js';
import { fetchCompanyProfile, fetchAnnouncements } from './stock-detail.js';
import { evaluateStock } from './score.js';

/** A JSON object output declaration reused by every tool here. */
const OBJECT_OUTPUT = { type: 'object', additionalProperties: true };

/** Render any value as one text content block. */
const text = (value) => [{
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
}];

/** One `NN.N` percentage with an explicit sign, or `--` when unknown. */
function percent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/** One unsigned percentage (turnover, amplitude): these have no direction. */
function percentAbs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return `${value.toFixed(2)}%`;
}

/** One ratio, or `--` when absent or a meaningless zero placeholder. */
function ratio(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return '--';
  return String(value);
}

/** One price, or `--` when unknown. */
function price(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return value.toFixed(2);
}

/** A compact one-screen Chinese rendering of one evaluation. */
function renderEvaluation(item) {
  const lines = [];
  const change = percent(item.changePercent);
  lines.push(`${item.name ?? '未知'}（${item.code}）  现价 ${price(item.price)}  ${change}`);
  lines.push(`综合评分 ${item.score}/100  →  ${item.verdictLabel}`);
  if (typeof item.summary === 'string' && item.summary.length > 0) lines.push(item.summary);
  lines.push('');
  lines.push('因子拆解：');
  for (const factor of item.factors ?? []) {
    const weight = typeof factor.weight === 'number' ? `${(factor.weight * 100).toFixed(0)}%` : '--';
    lines.push(`  ${factor.label}  ${String(factor.score).padStart(3)}/100（权重 ${weight}）`);
    for (const signal of factor.signals ?? []) lines.push(`    · ${signal}`);
  }
  const support = (item.levels?.support ?? []).map(price).join(' / ');
  const resistance = (item.levels?.resistance ?? []).map(price).join(' / ');
  if (support.length > 0 || resistance.length > 0) {
    lines.push('');
    lines.push(`支撑位：${support || '--'}    压力位：${resistance || '--'}`);
  }
  if (Array.isArray(item.risks) && item.risks.length > 0) {
    lines.push('');
    lines.push('风险提示：');
    for (const risk of item.risks) lines.push(`  · ${risk}`);
  }
  const warnings = item.dataQuality?.warnings ?? [];
  if (warnings.length > 0) {
    lines.push('');
    lines.push('数据质量：');
    for (const warning of warnings) lines.push(`  · ${warning}`);
  }
  lines.push('');
  lines.push(`数据时间：${item.asOf ?? '--'}　K线根数：${item.dataQuality?.bars ?? 0}`);
  if (typeof item.disclaimer === 'string') lines.push(item.disclaimer);
  return lines.join('\n');
}

/**
 * Register the three tools.
 *
 * @param {object} ctx - owning Cordis plugin context (needs `tools`).
 * @param {object} deps - assembled Host dependencies.
 * @param {object} deps.config - resolved plugin config.
 * @param {(code: string, days?: number, signal?: AbortSignal) => Promise<object>} deps.evaluate - one code end to end.
 * @param {object} [deps.sectors] - the sector feature; when absent its tools are skipped.
 * @param {(boardType?: string, signal?: AbortSignal, options?: object) => Promise<object[]>} [deps.sectors.list]
 * @param {(sectors: object[], options?: object) => { items: object[], total: number }} [deps.sectors.rank]
 * @returns {Array<() => void>} the disposers, in registration order.
 */
export function registerTools(ctx, { config, evaluate, sectors }) {
  const timeoutMs = config?.timeoutMs ?? 8000;

  /** @type {Array<() => void>} */
  const disposers = [];

  /** Register one tool and remember its disposer. */
  const define = (definition) => {
    const dispose = ctx.tools.register(definition);
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  define({
    name: 'astock_evaluate',
    description:
      '评估个股涨跌倾向（支持 A 股 / 港股 / 美股）：拉取腾讯免费公开行情（实时快照 + 前复权日K），本地计算均线、RSI、MACD、BOLL、ATR、量能、位置与风险共 6 个因子，输出 0-100 综合评分、多空判定、支撑压力位与风险提示。代码写法：A 股 600519 / sh600519，港股 hk00700，美股 usAAPL。支持一次传多个代码。评分为技术面启发式，不是投资建议。',
    parameters: {
      type: 'object',
      properties: {
        codes: {
          type: 'array',
          items: { type: 'string' },
          description: '股票代码列表，如 ["600519","hk00700","usAAPL"]。支持 600519 / sh600519 / hk00700 / usAAPL 等写法，最多 10 个。',
        },
        days: {
          type: 'number',
          description: '拉取的日K线根数，默认 320（约一年半），范围 30-1200。',
        },
      },
      required: ['codes'],
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => {
        const items = Array.isArray(value?.items) ? value.items : [];
        const errors = Array.isArray(value?.errors) ? value.errors : [];
        const parts = items.map(renderEvaluation);
        for (const failure of errors) parts.push(`${failure.code}：${failure.message}`);
        return text(parts.length > 0 ? parts.join('\n\n────────\n\n') : '没有可评估的结果。');
      },
    },
    execute: async (args, exec) => {
      const raw = Array.isArray(args?.codes) ? args.codes : [];
      const codes = [];
      const seen = new Set();
      for (const value of raw) {
        const normalized = normalizeCode(value);
        if (normalized === null || seen.has(normalized.secid)) continue;
        seen.add(normalized.secid);
        codes.push(normalized.secid);
        if (codes.length >= 10) break;
      }
      if (codes.length === 0) throw new Error('astock: 请提供至少一个有效的 A 股代码，例如 600519');
      const days = Number.isFinite(Number(args?.days)) ? Number(args.days) : undefined;
      const items = [];
      const errors = [];
      for (const code of codes) {
        try {
          items.push(await evaluate(code, days, exec.signal));
        } catch (error) {
          errors.push({ code, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return { items, errors, asOf: new Date().toISOString() };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '评估 A 股涨跌倾向',
      kind: 'fetch',
      rawInput: Array.isArray(args?.codes) ? args.codes.join(', ') : undefined,
    }),
    presentResult: (args, result) => ({
      card: 'generic',
      title: `A 股评估完成：${Array.isArray(args?.codes) ? args.codes.length : 0} 只`,
    }),
  });

  define({
    name: 'astock_quote',
    description:
      '读取 A 股实时快照（现价、涨跌额、涨跌幅、今开、最高、最低、成交量、成交额、换手率、市盈率、市净率、量比、振幅、流通市值、总市值、涨跌停价）。支持个股与指数，如 sh000001。',
    parameters: {
      type: 'object',
      properties: {
        codes: {
          type: 'array',
          items: { type: 'string' },
          description: '股票或指数代码列表，如 ["600519","sh000001"]，最多 30 个。',
        },
      },
      required: ['codes'],
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => {
        const quotes = Array.isArray(value?.quotes) ? value.quotes : [];
        const lines = quotes.map((quote) => {
          if (quote === null) return '（取不到该代码的行情）';
          return `${quote.name}（${quote.secid}）  ${price(quote.price)}  ${percent(quote.changePercent)}  `
            + `量比 ${ratio(quote.volumeRatio)}  换手 ${percentAbs(quote.turnoverRate)}  `
            + `PE ${ratio(quote.peTtm)}  PB ${ratio(quote.pb)}  ${quote.timestamp ?? '--'}`;
        });
        return text(lines.length > 0 ? lines.join('\n') : '没有可用的行情。');
      },
    },
    execute: async (args, exec) => {
      const raw = Array.isArray(args?.codes) ? args.codes : [];
      const codes = [];
      const seen = new Set();
      for (const value of raw) {
        const normalized = normalizeCode(value);
        if (normalized === null || seen.has(normalized.secid)) continue;
        seen.add(normalized.secid);
        codes.push(normalized.secid);
        if (codes.length >= 30) break;
      }
      if (codes.length === 0) throw new Error('astock: 请提供至少一个有效的代码');
      const quotes = await fetchQuotes(codes, { timeoutMs, signal: exec.signal });
      return { quotes, asOf: new Date().toISOString() };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '读取 A 股实时行情',
      kind: 'fetch',
      rawInput: Array.isArray(args?.codes) ? args.codes.join(', ') : undefined,
    }),
    presentResult: () => ({ card: 'generic', title: '行情已就绪' }),
  });

  define({
    name: 'astock_search',
    description: '按股票代码或中文名称检索 A 股标的，返回可用的代码、名称与拼音缩写。用于把「茅台」这类名称解析成代码。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '代码片段或名称片段，如 "600519"、"茅台"、"宁德"。' },
      },
      required: ['keyword'],
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => {
        const results = Array.isArray(value?.results) ? value.results : [];
        if (results.length === 0) return text('没有匹配的标的。');
        return text(results.map((item) => `${item.secid}  ${item.name}  (${item.pinyin || '--'})`).join('\n'));
      },
    },
    execute: async (args, exec) => {
      const keyword = typeof args?.keyword === 'string' ? args.keyword.trim() : '';
      if (keyword.length === 0) throw new Error('astock: 请提供检索关键词');
      const results = await searchSymbols(keyword, { timeoutMs, signal: exec.signal });
      return { results };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '检索 A 股标的',
      kind: 'search',
      rawInput: typeof args?.keyword === 'string' ? args.keyword : undefined,
    }),
    presentResult: () => ({ card: 'generic', title: '检索完成' }),
  });

  // ── sector tools ───────────────────────────────────────────────────────
  // Registered only when the sector module is present: a build without it
  // still serves the individual-stock tools rather than failing to mount.
  if (sectors !== undefined && sectors !== null
    && typeof sectors.list === 'function' && typeof sectors.rank === 'function') {
    define({
      name: 'astock_sectors',
      description:
        '查看 A 股板块（行业/概念）排行与涨跌评估。拉取腾讯免费公开板块行情，用截面数据（多周期涨跌幅、量比、换手、主力资金流、涨跌家数）做 5 因子评分，输出 0-100 综合分与多空判定。支持一级行业、二级行业、概念板块。板块评分基于截面数据，不含 K 线技术指标，不是投资建议。',
      parameters: {
        type: 'object',
        properties: {
          boardType: {
            type: 'string',
            enum: ['hy', 'hy2', 'gn'],
            description: '板块类型：hy 一级行业（约 31 个）、hy2 二级行业（约 124 个）、gn 概念板块（约 500 个）。默认 hy。',
          },
          sortBy: {
            type: 'string',
            enum: ['score', 'changePercent', 'change5d', 'change20d', 'capitalNet', 'name'],
            description: '排序字段，默认 score（综合评分）。',
          },
          order: { type: 'string', enum: ['desc', 'asc'], description: '排序方向，默认 desc（从高到低）。' },
          limit: { type: 'number', description: '返回条数，默认 20，最多 100。传 0 表示全部。' },
        },
      },
      output: {
        schema: OBJECT_OUTPUT,
        render: (_args, value) => {
          const items = Array.isArray(value?.items) ? value.items : [];
          const lines = items.map((item) => {
            const up = item.breadth?.up;
            const down = item.breadth?.down;
            const breadthText = up !== null && up !== undefined && down !== null && down !== undefined
              ? `涨跌 ${up}/${down}`
              : '涨跌 --';
            const capitalText = typeof item.capital?.net === 'number'
              ? `主力 ${(item.capital.net / 10000).toFixed(2)} 亿`
              : '主力 --';
            return `${String(item.name ?? '').padEnd(8, '　')}  ${percent(item.changePercent)}  `
              + `评分 ${String(item.score).padStart(3)}  ${item.verdictLabel}  ${breadthText}  ${capitalText}`;
          });
          const header = `板块排行（${value?.boardType ?? '---'}，共 ${value?.total ?? 0} 个，显示 ${items.length} 个）`;
          return text([header, '', ...lines].join('\n'));
        },
      },
      execute: async (args, exec) => {
        const boardType = args?.boardType === 'hy2' || args?.boardType === 'gn' ? args.boardType : 'hy';
        const list = await sectors.list(boardType, exec.signal, { timeoutMs });
        const ranked = await sectors.rank(list, {
          sortBy: typeof args?.sortBy === 'string' ? args.sortBy : 'score',
          order: args?.order === 'asc' ? 'asc' : 'desc',
        });
        const raw = Number(args?.limit);
        const limit = !Number.isFinite(raw) ? 20 : raw <= 0 ? 0 : Math.min(100, Math.floor(raw));
        return {
          boardType,
          total: ranked.total,
          items: limit === 0 ? ranked.items : ranked.items.slice(0, limit),
          asOf: new Date().toISOString(),
        };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '查看板块排行',
        kind: 'search',
        rawInput: typeof args?.boardType === 'string' ? args.boardType : undefined,
      }),
      presentResult: () => ({ card: 'generic', title: '板块排行已就绪' }),
    });
  }

  define({
    name: 'astock_detail',
    description:
      '读取个股基本面与最新公告：公司业务介绍（所属行业、经营范围、公司简介、员工数、官网）、最新公告标题与日期。仅 A 股有完整公司资料，港美股只返回公告。用于回答「这家公司做什么的」「最近有什么公告」。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '股票代码，如 600519 / sh600519 / hk00700 / usAAPL。' },
        announcementLimit: { type: 'number', description: '返回公告条数，默认 8，最多 30。' },
      },
      required: ['code'],
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => {
        const lines = [];
        const profile = value?.profile;
        if (profile) {
          lines.push(`【${profile.name}】${profile.industry ? ' 行业：' + profile.industry : ''}`);
          if (profile.businessScope) lines.push(`经营范围：${profile.businessScope}`);
          if (profile.profile) lines.push(`公司简介：${profile.profile}`);
          const facts = [];
          if (profile.employees) facts.push(`员工 ${profile.employees} 人`);
          if (profile.chairman) facts.push(`董事长 ${profile.chairman}`);
          if (profile.website) facts.push(`官网 ${profile.website}`);
          if (profile.address) facts.push(`地址 ${profile.address}`);
          if (facts.length > 0) lines.push(facts.join('　|　'));
        } else {
          lines.push('（该公司暂无公司资料，港美股不提供 F10 数据）');
        }
        const list = Array.isArray(value?.announcements) ? value.announcements : [];
        lines.push('');
        lines.push(`最新公告（${list.length} 条）：`);
        if (list.length === 0) lines.push('  （无）');
        for (const item of list) lines.push(`  ${item.date ?? '--'}  ${item.title}`);
        return text(lines.join('\n'));
      },
    },
    execute: async (args, exec) => {
      const normalized = normalizeCode(args?.code);
      if (normalized === null) throw new Error(`astock: 无法识别的股票代码「${String(args?.code ?? '')}」`);
      const rawLimit = Number(args?.announcementLimit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(30, Math.floor(rawLimit)) : 8;
      const [profile, announcements] = await Promise.all([
        fetchCompanyProfile(normalized.secid, { timeoutMs, signal: exec.signal }).catch(() => null),
        fetchAnnouncements(normalized.secid, { limit, timeoutMs, signal: exec.signal }).catch(() => []),
      ]);
      return { secid: normalized.secid, market: normalized.market, profile, announcements, hasProfile: profile !== null };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '读取公司资料与公告',
      kind: 'fetch',
      rawInput: typeof args?.code === 'string' ? args.code : undefined,
    }),
    presentResult: () => ({ card: 'generic', title: '公司资料已就绪' }),
  });

  return disposers;
}

export { loadStockData, evaluateStock };
