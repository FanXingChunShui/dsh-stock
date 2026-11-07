window.__ModuleLoader__.load({
  id: 'dsh-astock',
  factory(require) {
    'use strict';

    var React = require('react');
    var h = React.createElement;

    /** UI primitives 是可选的：精简部署拿不到时降级为原生元素。 */
    var P = null;
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives') || null;
    } catch (error) {
      P = null;
    }

    /** 快照 store 是可选的：拿不到时用本文件内的最小实现。 */
    var storeLib = null;
    try {
      storeLib = require('@deepseek-ai/dsh-client-store') || null;
    } catch (error) {
      storeLib = null;
    }

    var NS = 'astock';
    var CHANNEL = '/astock';
    var PANEL_ID = 'astock';
    var STYLE_SELECTOR = 'style[data-plugin="dsh-astock"]';
    var LAST_CODE_KEY = 'dsh-astock.last-code';
    var SEARCH_DEBOUNCE_MS = 240;
    var TOAST_MS = 3200;
    var FACTOR_ORDER = ['trend', 'momentum', 'volume', 'position', 'volatility', 'risk'];

    /* ------------------------------------------------------------------ *
     * 文案字典（内置一份，避免 locale 文件加载顺序问题）
     * ------------------------------------------------------------------ */

    var en = {
      /* 与 locale/en.json 对齐的 key（lead 维护），值保持一致避免两套字典打架。 */
      panel: 'Stock Surf',
      title: 'Stock Surf',
      subtitle: 'Free public quotes plus a local multi-factor technical score. Not investment advice.',
      searchPlaceholder: 'Enter a code or name, e.g. 600519 / 茅台',
      searching: 'Searching…',
      noResults: 'No matching symbol',
      evaluate: 'Evaluate',
      evaluating: 'Evaluating…',
      refresh: 'Refresh',
      error: 'Failed: {message}',
      retry: 'Retry',
      empty: 'Enter a code or pick one from the watchlist to start',
      score: 'Composite score',
      verdict: 'Verdict',
      price: 'Price',
      change: 'Change',
      factors: 'Factor breakdown',
      weight: 'weight {value}',
      signals: 'Evidence',
      levels: 'Key levels',
      support: 'Support',
      resistance: 'Resistance',
      risks: 'Risks',
      noRisks: 'No notable risk signal',
      watchlist: 'Watchlist',
      watchlistEmpty: 'Watchlist is empty — evaluate one, then add it',
      addToWatchlist: 'Add to watchlist',
      watchlistAddTitle: 'Save this stock to your watchlist',
      watchlistRemoveTitle: 'Click to remove from watchlist',
      remove: 'Remove',
      disclaimer: 'Disclaimer',
      dataQuality: 'Data quality',
      asOf: 'As of',
      bars: 'Bars',
      upProbability: 'Upside bias',
      strongBull: 'Strong bullish',
      bull: 'Bullish',
      neutral: 'Neutral',
      bear: 'Bearish',
      strongBear: 'Strong bearish',
      trend: 'Trend',
      momentum: 'Momentum',
      volume: 'Volume',
      position: 'Position',
      volatility: 'Volatility',
      risk: 'Risk',

      /* 本面板额外使用的 key。 */
      searchHint: 'Type a 6-digit code or a name, then pick a suggestion',
      searchFailed: 'Search failed: {error}',
      refreshing: 'Refreshing…',
      emptyTitle: 'Pick a stock to evaluate',
      emptyHint: 'Enter a code or pick one from the watchlist to start',
      evalFailed: 'Evaluation failed: {error}',
      loadingEval: 'Evaluating {name}…',
      loadingEvalHint: 'Fetching live quote and daily bars, then scoring six factors.',
      scoreUnit: '/ 100',
      upProbabilityValue: 'Heuristic upside bias {value}',
      heuristicNote: 'Heuristic estimate, not a probability model output.',
      factorsHint: 'Select a factor to read its signals',
      factorsEmpty: 'No factor detail returned',
      levelsEmpty: 'Not enough history for key levels',
      qualityBars: '{count} daily bars',
      qualityNoQuote: 'no live quote',
      qualityStale: 'quote may be stale',
      metricsTitle: 'Quote detail',
      metricVolumeRatio: 'Volume ratio',
      metricTurnover: 'Turnover',
      metricAmplitude: 'Amplitude',
      metricAmount: 'Amount',
      metricPe: 'P/E (TTM)',
      metricPb: 'P/B',
      metricFloatCap: 'Float cap',
      metricTotalCap: 'Total cap',
      metricOpen: 'Open',
      metricPrevClose: 'Prev close',
      metricHigh: 'High',
      metricLow: 'Low',
      isolated: 'as of {time}',
      indicesTitle: 'Indices',
      indicesLoading: 'Loading indices…',
      indicesFailed: 'Could not load indices: {error}',
      indicesEmpty: 'No index data',
      watchlistAdded: 'In list',
      watchlistEmptyHint: 'Evaluate a stock, then add it here.',
      watchlistRemove: 'Remove {name} from the watchlist',
      watchlistUntitled: 'Untitled',
      watchBasis: 'Why',
      watchBasisTitle: 'Why it moves',
      watchBasisEmpty: 'No evaluation yet — click the row to evaluate',
      watchBasisStrongest: 'Strongest',
      watchBasisWeakest: 'Weakest',
      watchBasisRisks: 'Risks',
      watchBasisExpand: 'Show rationale',
      watchBasisCollapse: 'Hide rationale',
      watchBasisHint: 'Why this stock moved, from the six factors',
      companyTitle: 'Business',
      companyIndustry: 'Industry',
      companyScope: 'Business scope',
      companyProfile: 'Company profile',
      companyFacts: 'Key facts',
      companyNone: 'No company profile available (HK/US not covered)',
      announceTitle: 'Latest announcements',
      announceNone: 'No announcements',
      announceOpen: 'Open',
      analyzeOneClick: 'Analyze',
      analyzeRunning: 'Analyzing…',
      analyzeDone: 'Analysis ready',
      analyzeFailed: 'Analysis failed: {error}',
      constituentsTitle: 'Constituents',
      constituentsLoading: 'Loading constituents…',
      constituentsFailed: 'Could not load constituents: {error}',
      constituentsEmpty: 'No constituent data for this sector',
      constituentsTotal: '{count} stocks',
      expandMore: 'Read more',
      expandLess: 'Show less',
      toastAdded: 'Added {name} to the watchlist.',
      toastRemoved: 'Removed {name} from the watchlist.',
      toastWatchFailed: 'Could not update the watchlist: {error}',
      toastRefreshFailed: 'Refresh failed: {error}',
      errorNoRpc: 'RPC connection is unavailable',
      errorRpc: 'Request failed',
      unknown: 'Unknown',
      dash: '—',
      expand: 'Expand',
      collapse: 'Collapse',
      tabStock: 'Stock',
      tabSector: 'Sectors',
      tabList: 'List',
      marketCn: 'CN',
      marketHk: 'HK',
      marketUs: 'US',
      listLoading: 'Loading list…',
      listEmpty: 'No symbols',
      listFailed: 'Could not load list: {error}',
      listColName: 'Symbol',
      listColChange: 'Change',
      listColScore: 'Score',
      listAddShort: '＋',
      listRemoveShort: '✓',
      listSearchPlaceholder: 'Search code or name',
      listSortChange: 'By change',
      listSortAmount: 'By turnover',
      listSortCap: 'By market cap',
      listSortCode: 'By code',
      listTotal: '{count} symbols',
      listShowing: 'Showing {from}-{to}',
      listPrev: 'Prev',
      listNext: 'Next',
      listIncomplete: 'Source limit: {note}',
      listPartialNote: 'partial',
      listSearchPlaceholder: '搜索代码或名称',
      listSortChange: '按涨跌幅',
      listSortAmount: '按成交额',
      listSortCap: '按市值',
      listSortCode: '按代码',
      listTotal: '共 {count} 只',
      listShowing: '显示 {from}-{to}',
      listPrev: '上一页',
      listNext: '下一页',
      listIncomplete: '数据源限制：{note}',
      listPartialNote: '非全量',
      sectorTitle: 'Sector heat & evaluation',
      sectorSubtitle: 'Cross-sectional scoring over multi-period returns, volume, capital flow and breadth. No K-line technicals.',
      boardHy: 'Industries',
      boardHy2: 'Sub-industries',
      boardGn: 'Concepts',
      sectorLoading: 'Loading sectors…',
      sectorEmpty: 'No sector data',
      sectorFailed: 'Could not load sectors: {error}',
      sectorColName: 'Sector',
      sectorColChange: 'Change',
      sectorColScore: 'Score',
      sectorColBreadth: 'Up / Down',
      sectorColCapital: 'Net inflow',
      sectorTotal: '{count} sectors',
      sectorSortScore: 'Sort by score',
      sectorSortChange: 'Sort by change',
      sectorLeader: 'Leader {name} {change}',
      sectorDetail: 'Sector detail',
      sectorBack: 'Back to list',
      sectorNoKline: 'Sector K-line history is unavailable from the data source, so no support/resistance levels are produced.',
      breadth: 'Breadth',
      capitalNet: 'Main net inflow',
      capital5d: '5-day net inflow',
      capital20d: '20-day net inflow',
      capitalUnitYi: '{value} 亿',
      change5dShort: '5D',
      change20dShort: '20D',
    };

    var zh = {
      /* 与 locale/zh.json 对齐的 key（lead 维护），值保持一致避免两套字典打架。 */
      panel: '股票冲浪',
      title: '股票冲浪',
      subtitle: '基于免费公开行情与本地多因子技术评分，不构成投资建议',
      searchPlaceholder: '输入代码或名称，如 600519 / 茅台',
      searching: '检索中…',
      noResults: '没有匹配的标的',
      evaluate: '评估',
      evaluating: '评估中…',
      refresh: '刷新',
      error: '出错了：{message}',
      retry: '重试',
      empty: '输入一个代码或从自选股里选一只开始评估',
      score: '综合评分',
      verdict: '多空判定',
      price: '现价',
      change: '涨跌幅',
      factors: '因子拆解',
      weight: '权重 {value}',
      signals: '依据',
      levels: '关键位',
      support: '支撑位',
      resistance: '压力位',
      risks: '风险提示',
      noRisks: '暂无显著风险信号',
      watchlist: '自选股',
      watchlistEmpty: '自选股为空，评估一只后点「加入自选」',
      addToWatchlist: '加入自选',
      watchlistAddTitle: '把当前标的存入自选股',
      watchlistRemoveTitle: '点击从自选股移除',
      remove: '移除',
      disclaimer: '免责声明',
      dataQuality: '数据质量',
      asOf: '数据时间',
      bars: 'K线根数',
      upProbability: '上行倾向',
      strongBull: '强烈看多',
      bull: '偏多',
      neutral: '中性',
      bear: '偏空',
      strongBear: '强烈看空',
      trend: '趋势',
      momentum: '动量',
      volume: '量能',
      position: '位置',
      volatility: '波动',
      risk: '风险',

      /* 本面板额外使用的 key。 */
      searchHint: '输入 6 位代码或股票名称，然后从候选中选择',
      searchFailed: '搜索失败：{error}',
      refreshing: '刷新中…',
      emptyTitle: '选择一只股票开始评估',
      emptyHint: '输入一个代码或从自选股里选一只开始评估',
      evalFailed: '评估失败：{error}',
      loadingEval: '正在评估 {name}…',
      loadingEvalHint: '拉取实时行情与日K线，随后计算六因子评分。',
      scoreUnit: '/ 100',
      upProbabilityValue: '启发式上行倾向 {value}',
      heuristicNote: '启发式估计，非概率模型输出。',
      factorsHint: '点击因子查看依据',
      factorsEmpty: '未返回因子明细',
      levelsEmpty: '历史数据不足，无法给出关键位',
      qualityBars: '{count} 根日K',
      qualityNoQuote: '无实时行情',
      qualityStale: '行情可能延迟',
      metricsTitle: '行情明细',
      metricVolumeRatio: '量比',
      metricTurnover: '换手率',
      metricAmplitude: '振幅',
      metricAmount: '成交额',
      metricPe: '市盈率(TTM)',
      metricPb: '市净率',
      metricFloatCap: '流通市值',
      metricTotalCap: '总市值',
      metricOpen: '今开',
      metricPrevClose: '昨收',
      metricHigh: '最高',
      metricLow: '最低',
      isolated: '数据时间 {time}',
      indicesTitle: '大盘指数',
      indicesLoading: '正在加载指数…',
      indicesFailed: '指数加载失败：{error}',
      indicesEmpty: '暂无指数数据',
      watchlistAdded: '已在自选',
      watchlistEmptyHint: '评估一只股票后，可以把它加入自选。',
      watchlistRemove: '将 {name} 移出自选',
      watchlistUntitled: '未命名',
      watchBasis: '依据',
      watchBasisTitle: '涨跌依据',
      watchBasisEmpty: '尚无评估，点击该行即可评估',
      watchBasisStrongest: '最强项',
      watchBasisWeakest: '最弱项',
      watchBasisRisks: '风险',
      watchBasisExpand: '展开依据',
      watchBasisCollapse: '收起依据',
      watchBasisHint: '来自六因子评分的涨跌归因',
      companyTitle: '公司业务',
      companyIndustry: '所属行业',
      companyScope: '经营范围',
      companyProfile: '公司简介',
      companyFacts: '基本信息',
      companyNone: '该公司暂无公司资料（港美股不提供 F10 数据）',
      announceTitle: '最新公告',
      announceNone: '暂无公告',
      announceOpen: '查看',
      analyzeOneClick: '一键分析',
      analyzeRunning: '分析中…',
      analyzeDone: '分析完成',
      analyzeFailed: '分析失败：{error}',
      constituentsTitle: '成分股',
      constituentsLoading: '正在加载成分股…',
      constituentsFailed: '加载成分股失败：{error}',
      constituentsEmpty: '该板块暂无成分股数据',
      constituentsTotal: '共 {count} 只',
      expandMore: '展开全文',
      expandLess: '收起',
      toastAdded: '已将 {name} 加入自选。',
      toastRemoved: '已将 {name} 移出自选。',
      toastWatchFailed: '自选股更新失败：{error}',
      toastRefreshFailed: '刷新失败：{error}',
      errorNoRpc: 'RPC 连接不可用',
      errorRpc: '请求失败',
      unknown: '未知',
      dash: '—',
      expand: '展开',
      collapse: '收起',
      tabStock: '个股',
      tabSector: '板块',
      tabList: '列表',
      marketCn: 'A股',
      marketHk: '港股',
      marketUs: '美股',
      listLoading: '正在加载列表…',
      listEmpty: '没有标的',
      listFailed: '加载列表失败：{error}',
      listColName: '标的',
      listColChange: '涨跌幅',
      listColScore: '评分',
      listAddShort: '＋',
      listRemoveShort: '✓',
      listSearchPlaceholder: 'Search code or name',
      listSortChange: 'By change',
      listSortAmount: 'By turnover',
      listSortCap: 'By market cap',
      listSortCode: 'By code',
      listTotal: '{count} symbols',
      listShowing: 'Showing {from}-{to}',
      listPrev: 'Prev',
      listNext: 'Next',
      listIncomplete: 'Source limit: {note}',
      listPartialNote: 'partial',
      listSearchPlaceholder: '搜索代码或名称',
      listSortChange: '按涨跌幅',
      listSortAmount: '按成交额',
      listSortCap: '按市值',
      listSortCode: '按代码',
      listTotal: '共 {count} 只',
      listShowing: '显示 {from}-{to}',
      listPrev: '上一页',
      listNext: '下一页',
      listIncomplete: '数据源限制：{note}',
      listPartialNote: '非全量',
      sectorTitle: '板块热度与涨跌评估',
      sectorSubtitle: '基于多周期涨跌、量能、主力资金流与涨跌家数的截面评分，不含 K 线技术指标。',
      boardHy: '一级行业',
      boardHy2: '二级行业',
      boardGn: '概念板块',
      sectorLoading: '正在加载板块…',
      sectorEmpty: '没有板块数据',
      sectorFailed: '加载板块失败：{error}',
      sectorColName: '板块',
      sectorColChange: '涨跌幅',
      sectorColScore: '评分',
      sectorColBreadth: '涨/跌',
      sectorColCapital: '主力净流入',
      sectorTotal: '共 {count} 个板块',
      sectorSortScore: '按评分排序',
      sectorSortChange: '按涨跌排序',
      sectorLeader: '领涨 {name} {change}',
      sectorDetail: '板块详情',
      sectorBack: '返回列表',
      sectorNoKline: '数据源不提供板块历史 K 线，因此不计算支撑位与压力位。',
      breadth: '涨跌家数',
      capitalNet: '主力净流入',
      capital5d: '5 日净流入',
      capital20d: '20 日净流入',
      capitalUnitYi: '{value} 亿',
      change5dShort: '5日',
      change20dShort: '20日',
    };

    /* ------------------------------------------------------------------ *
     * 样式：全部走主题变量并带 fallback，深浅色主题都可读
     * ------------------------------------------------------------------ */

    var CSS = [
      '.astock-root{',
      '  --astock-text:var(--dsh-color-text-primary,var(--dsw-alias-label-primary,currentColor));',
      '  --astock-text-2:var(--dsh-color-text-secondary,var(--dsw-alias-label-secondary,rgba(128,128,128,.92)));',
      '  --astock-text-3:var(--dsh-color-text-tertiary,var(--dsw-alias-label-tertiary,rgba(128,128,128,.78)));',
      '  --astock-bg:var(--dsh-color-bg-elevated,var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06)));',
      '  --astock-bg-soft:var(--dsh-color-bg-sunken,var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04)));',
      '  --astock-border:var(--dsh-color-border,var(--dsw-alias-border-l3,rgba(128,128,128,.26)));',
      '  --astock-border-strong:var(--dsh-color-border-strong,var(--dsw-alias-border-l2,rgba(128,128,128,.4)));',
      '  --astock-hover:var(--dsh-color-bg-hover,var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12)));',
      '  --astock-accent:var(--dsh-color-accent,var(--dsw-alias-state-business-primary,#3f7ff5));',
      '  --astock-danger:var(--dsh-color-danger,var(--dsw-alias-state-error-primary,#d93a2b));',
      '  --astock-track:var(--dsh-color-fill-quaternary,var(--dsw-alias-border-l3,rgba(128,128,128,.22)));',
      '  --astock-radius:var(--dsw-radius-md,10px);',
      '  --astock-radius-sm:var(--dsw-radius-sm,6px);',
      '  --astock-up:#e33a34;',
      '  --astock-up-soft:#e8736f;',
      '  --astock-down:#18a058;',
      '  --astock-down-soft:#4fba85;',
      '  --astock-flat:var(--astock-text-3);',
      '  display:flex;flex-direction:column;gap:12px;box-sizing:border-box;',
      '  padding:16px 18px 28px;min-height:100%;overflow:auto;',
      '  color:var(--astock-text);font-size:13px;line-height:20px;',
      '  font-variant-numeric:tabular-nums;',
      '}',
      '.astock-root *, .astock-root *::before, .astock-root *::after{box-sizing:border-box}',
      '.astock-header{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}',
      '.astock-header-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.astock-title{margin:0;font-size:17px;font-weight:600;line-height:24px;letter-spacing:.01em}',
      '.astock-subtitle{margin:0;color:var(--astock-text-3);font-size:12px;line-height:18px}',
      '.astock-header-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
      '.astock-btn{appearance:none;font:inherit;font-size:12px;line-height:18px;padding:4px 10px;cursor:pointer;',
      '  border-radius:var(--astock-radius-sm);border:.5px solid var(--astock-border-strong);',
      '  background:transparent;color:var(--astock-text);white-space:nowrap}',
      '.astock-btn:hover:not(:disabled){background:var(--astock-hover)}',
      '.astock-btn:disabled{opacity:.55;cursor:default}',
      '.astock-btn:focus-visible{outline:2px solid var(--astock-accent);outline-offset:1px}',
      '.astock-btn-primary{border-color:transparent;background:var(--astock-accent);color:#fff}',
      '.astock-btn-primary:hover:not(:disabled){background:var(--astock-accent);filter:brightness(1.08)}',
      '.astock-btn-sm{font-size:11px;line-height:16px;padding:2px 8px}',
      '.astock-btn-quiet{border-color:transparent;color:var(--astock-text-3)}',
      '.astock-indices{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}',
      '.astock-index{display:flex;flex-direction:column;gap:1px;padding:8px 11px;',
      '  border:.5px solid var(--astock-border);border-radius:var(--astock-radius);background:var(--astock-bg-soft)}',
      '.astock-index-name{font-size:11px;line-height:16px;color:var(--astock-text-3);',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.astock-index-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.astock-index-price{font-size:15px;font-weight:600;line-height:22px}',
      '.astock-index-change{font-size:12px;font-weight:600;line-height:18px}',
      '.astock-search{position:relative;display:flex;flex-direction:column;gap:6px}',
      '.astock-search-box{display:flex;align-items:center;gap:8px;padding:0 10px;',
      '  border:.5px solid var(--astock-border-strong);border-radius:var(--astock-radius);background:var(--astock-bg)}',
      '.astock-search-box:focus-within{border-color:var(--astock-accent)}',
      '.astock-search-glyph{flex:0 0 auto;color:var(--astock-text-3);display:flex}',
      '.astock-search-input{flex:1 1 auto;min-width:0;appearance:none;border:0;outline:none;background:transparent;',
      '  font:inherit;font-size:13px;line-height:20px;padding:7px 0;color:var(--astock-text)}',
      '.astock-search-input::placeholder{color:var(--astock-text-3)}',
      '.astock-search-hint{font-size:11px;line-height:16px;color:var(--astock-text-3)}',
      '.astock-search-field{position:relative;display:flex;flex-direction:column;gap:6px}',
      '.astock-suggest{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:20;display:flex;flex-direction:column;',
      '  max-height:260px;overflow:auto;padding:4px;border:.5px solid var(--astock-border-strong);',
      '  border-radius:var(--astock-radius);background:var(--astock-bg);',
      '  box-shadow:0 8px 24px rgba(0,0,0,.16)}',
      '.astock-suggest-item{display:flex;align-items:baseline;gap:8px;width:100%;text-align:left;appearance:none;',
      '  font:inherit;font-size:12px;line-height:18px;padding:5px 8px;border:0;border-radius:var(--astock-radius-sm);',
      '  background:transparent;color:var(--astock-text);cursor:pointer}',
      '.astock-suggest-item:hover,.astock-suggest-item[data-active="true"]{background:var(--astock-hover)}',
      '.astock-suggest-code{font-weight:600;color:var(--astock-text)}',
      '.astock-suggest-name{color:var(--astock-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.astock-suggest-tag{margin-left:auto;font-size:10px;line-height:14px;color:var(--astock-text-3);text-transform:uppercase}',
      '.astock-suggest-note{padding:6px 8px;font-size:12px;color:var(--astock-text-3)}',
      '.astock-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(230px,290px);gap:14px;align-items:start}',
      '.astock-col{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.astock-card{display:flex;flex-direction:column;gap:10px;padding:12px 13px;',
      '  border:.5px solid var(--astock-border);border-radius:var(--astock-radius);background:var(--astock-bg)}',
      '.astock-card-title{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--astock-text-2);',
      '  letter-spacing:.02em}',
      '.astock-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
      '.astock-card-note{font-size:11px;line-height:16px;color:var(--astock-text-3)}',
      '.astock-quote-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}',
      '.astock-quote-ident{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.astock-quote-name{font-size:16px;font-weight:600;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.astock-quote-meta{font-size:11px;line-height:16px;color:var(--astock-text-3)}',
      '.astock-quote-price{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.astock-price-value{font-size:24px;font-weight:600;line-height:30px;letter-spacing:-.01em}',
      '.astock-price-change{font-size:13px;font-weight:600;line-height:20px}',
      '.astock-score-block{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:2px}',
      '.astock-ring{position:relative;width:88px;height:88px;border-radius:50%;flex:0 0 auto;',
      '  display:flex;align-items:center;justify-content:center}',
      '.astock-ring-inner{width:70px;height:70px;border-radius:50%;background:var(--astock-bg);',
      '  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0}',
      '.astock-ring-number{font-size:22px;font-weight:600;line-height:26px}',
      '.astock-ring-unit{font-size:10px;line-height:13px;color:var(--astock-text-3)}',
      '.astock-score-side{flex:1 1 180px;min-width:0;display:flex;flex-direction:column;gap:6px}',
      '.astock-badge{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;padding:1px 9px;',
      '  border-radius:999px;border:.5px solid currentColor;font-size:12px;font-weight:600;line-height:18px}',
      '.astock-summary{margin:0;font-size:13px;line-height:21px;color:var(--astock-text-2)}',
      '.astock-prob{font-size:11px;line-height:16px;color:var(--astock-text-3)}',
      '.astock-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:8px}',
      '.astock-metric{display:flex;flex-direction:column;gap:1px;padding:6px 8px;border-radius:var(--astock-radius-sm);',
      '  background:var(--astock-bg-soft)}',
      '.astock-metric-label{font-size:10px;line-height:14px;color:var(--astock-text-3);white-space:nowrap;',
      '  overflow:hidden;text-overflow:ellipsis}',
      '.astock-metric-value{font-size:12px;font-weight:600;line-height:18px}',
      '.astock-factors{display:flex;flex-direction:column;gap:2px}',
      '.astock-factor{border-radius:var(--astock-radius-sm)}',
      '.astock-factor-head{display:flex;align-items:center;gap:8px;width:100%;appearance:none;border:0;',
      '  background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--astock-text);',
      '  padding:4px 6px;border-radius:var(--astock-radius-sm);cursor:pointer;text-align:left}',
      '.astock-factor-head:hover{background:var(--astock-hover)}',
      '.astock-factor-head:focus-visible{outline:2px solid var(--astock-accent);outline-offset:-1px}',
      '.astock-factor-label{font-weight:600;min-width:52px}',
      '.astock-factor-weight{font-size:10px;line-height:14px;color:var(--astock-text-3)}',
      '.astock-factor-score{margin-left:auto;font-weight:600}',
      '.astock-factor-caret{width:12px;text-align:center;color:var(--astock-text-3);font-size:12px}',
      '.astock-factor-track{height:6px;margin:0 6px 4px;border-radius:999px;background:var(--astock-track);overflow:hidden}',
      '.astock-factor-fill{height:100%;border-radius:999px;transition:width .28s ease}',
      '.astock-factor-signals{list-style:none;margin:0 0 6px;padding:0 6px 0 18px;display:flex;flex-direction:column;gap:2px}',
      '.astock-signal{position:relative;font-size:12px;line-height:19px;color:var(--astock-text-2)}',
      '.astock-signal::before{content:"";position:absolute;left:-11px;top:8px;width:4px;height:4px;border-radius:50%;',
      '  background:var(--astock-text-3)}',
      '.astock-levels{display:flex;flex-direction:column;gap:8px}',
      '.astock-level-group{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.astock-level-label{flex:0 0 auto;font-size:11px;line-height:16px;color:var(--astock-text-3);min-width:32px}',
      '.astock-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.astock-chip{padding:0 8px;border-radius:999px;font-size:12px;font-weight:600;line-height:20px;',
      '  border:.5px solid var(--astock-border-strong);background:var(--astock-bg-soft)}',
      '.astock-chips[data-tone="sup"] .astock-chip{border-color:var(--astock-down-soft);color:var(--astock-down)}',
      '.astock-chips[data-tone="res"] .astock-chip{border-color:var(--astock-up-soft);color:var(--astock-up)}',
      '.astock-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px}',
      '.astock-item{position:relative;padding-left:13px;font-size:12px;line-height:19px;color:var(--astock-text-2)}',
      '.astock-item::before{content:"";position:absolute;left:1px;top:8px;width:4px;height:4px;border-radius:50%;',
      '  background:var(--astock-text-3)}',
      '.astock-item[data-tone="risk"]::before{background:var(--astock-up)}',
      '.astock-item[data-tone="warn"]::before{background:var(--astock-down)}',
      '.astock-disclaimer{margin:0;padding-top:8px;border-top:.5px solid var(--astock-border);',
      '  font-size:11px;line-height:17px;color:var(--astock-text-3)}',
      '.astock-watch{display:flex;flex-direction:column;gap:8px}',
      '.astock-watch-head{display:flex;align-items:center;gap:8px}',
      '.astock-watch-title{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--astock-text-2);flex:1 1 auto}',
      '.astock-watch-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}',
      '.astock-watch-row{display:flex;flex-direction:column;gap:0;border-radius:var(--astock-radius-sm)}',
      '.astock-watch-line{display:flex;align-items:center;gap:6px}',
      '.astock-watch-row:hover{background:var(--astock-hover)}',
      '.astock-watch-row[data-active="true"]{background:var(--astock-hover);box-shadow:inset 2px 0 0 var(--astock-accent)}',
      '.astock-watch-open{display:flex;align-items:baseline;gap:7px;flex:1 1 auto;min-width:0;appearance:none;border:0;',
      '  background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--astock-text);',
      '  padding:6px 4px 6px 8px;cursor:pointer;text-align:left}',
      '.astock-watch-open:focus-visible{outline:2px solid var(--astock-accent);outline-offset:-1px}',
      '.astock-watch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:96px}',
      '.astock-watch-code{font-size:10px;line-height:14px;color:var(--astock-text-3);flex:0 0 auto}',
      '.astock-watch-change{margin-left:auto;font-size:12px;font-weight:600;flex:0 0 auto}',
      '.astock-watch-score{flex:0 0 auto;min-width:30px;text-align:right;font-size:12px;font-weight:600;',
      '  padding:1px 5px;border-radius:var(--astock-radius-sm);background:var(--astock-bg-soft)}',
      '.astock-watch-remove{flex:0 0 auto;appearance:none;border:0;background:transparent;color:var(--astock-text-3);',
      '  font:inherit;font-size:14px;line-height:18px;padding:2px 6px;border-radius:var(--astock-radius-sm);cursor:pointer}',
      '.astock-watch-remove:hover{background:var(--astock-hover);color:var(--astock-danger)}',
      '.astock-watch-remove:focus-visible{outline:2px solid var(--astock-accent);outline-offset:-1px}',
      '.astock-state{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 16px;text-align:center;',
      '  border:.5px dashed var(--astock-border);border-radius:var(--astock-radius);color:var(--astock-text-3)}',
      '.astock-state-title{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--astock-text-2)}',
      '.astock-state-text{margin:0;font-size:12px;line-height:18px}',
      '.astock-error{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:var(--astock-radius);',
      '  border:.5px solid var(--astock-danger);background:var(--astock-bg-soft);color:var(--astock-danger);',
      '  font-size:12px;line-height:18px}',
      '.astock-error-text{margin:0;word-break:break-word}',
      '.astock-loading{display:flex;align-items:center;gap:9px;padding:18px 14px;border-radius:var(--astock-radius);',
      '  border:.5px solid var(--astock-border);background:var(--astock-bg-soft)}',
      '.astock-spinner{width:14px;height:14px;flex:0 0 auto;border-radius:50%;',
      '  border:2px solid var(--astock-track);border-top-color:var(--astock-accent);animation:astock-spin .8s linear infinite}',
      '@keyframes astock-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.astock-spinner{animation-duration:2.4s}',
      '  .astock-factor-fill{transition:none}}',
      '.astock-loading-text{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.astock-loading-title{font-size:12px;font-weight:600;line-height:18px;color:var(--astock-text-2)}',
      '.astock-loading-hint{font-size:11px;line-height:16px;color:var(--astock-text-3)}',
      '.astock-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:70;',
      '  max-width:min(460px,calc(100vw - 40px));padding:7px 14px;border-radius:999px;',
      '  background:var(--astock-text);color:var(--astock-bg);font-size:12px;line-height:18px;',
      '  box-shadow:0 6px 24px rgba(0,0,0,.22)}',
      '.astock-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;',
      '  clip:rect(0 0 0 0);white-space:nowrap;border:0}',
      '.astock-tabs{display:flex;align-items:center;gap:2px;border-bottom:.5px solid var(--astock-border);',
      '  padding-bottom:0;flex-wrap:wrap}',
      '.astock-tab{appearance:none;font:inherit;font-size:13px;line-height:20px;padding:7px 12px;cursor:pointer;',
      '  background:transparent;border:0;border-bottom:2px solid transparent;color:var(--astock-text-3);',
      '  margin-bottom:-.5px;white-space:nowrap}',
      '.astock-tab:hover{color:var(--astock-text)}',
      '.astock-tab:focus-visible{outline:2px solid var(--astock-accent);outline-offset:-2px}',
      '.astock-tab[data-active="true"]{color:var(--astock-text);font-weight:600;border-bottom-color:var(--astock-accent)}',
      '.astock-tab-count{font-size:11px;color:var(--astock-text-3);margin-left:4px;font-weight:400}',
      '.astock-seg{display:inline-flex;align-items:center;gap:0;border:.5px solid var(--astock-border-strong);',
      '  border-radius:var(--astock-radius-sm);overflow:hidden}',
      '.astock-seg button{appearance:none;font:inherit;font-size:12px;line-height:18px;padding:4px 10px;cursor:pointer;',
      '  background:transparent;border:0;color:var(--astock-text-2);white-space:nowrap}',
      '.astock-seg button+button{border-left:.5px solid var(--astock-border)}',
      '.astock-seg button[data-active="true"]{background:var(--astock-hover);color:var(--astock-text);font-weight:600}',
      '.astock-seg button:focus-visible{outline:2px solid var(--astock-accent);outline-offset:-2px}',
      '.astock-sector-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.astock-body-single{display:block}',
      '.astock-mlist{display:flex;flex-direction:column;border:.5px solid var(--astock-border);',
      '  border-radius:var(--astock-radius);overflow:hidden}',
      '.astock-mlist-row{display:grid;grid-template-columns:minmax(0,1.6fr) 70px 76px 44px;align-items:center;',
      '  gap:8px;padding:8px 11px;border-bottom:.5px solid var(--astock-border);width:100%;',
      '  background:transparent;border-left:0;border-right:0;border-top:0;font:inherit;text-align:left;',
      '  color:inherit;cursor:pointer}',
      '.astock-mlist-row:last-child{border-bottom:0}',
      '.astock-mlist-row:hover{background:var(--astock-hover)}',
      '.astock-mlist-row:focus-visible{outline:2px solid var(--astock-accent);outline-offset:-2px}',
      '.astock-mlist-name{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.astock-mlist-name b{font-weight:600;font-size:13px;line-height:19px;overflow:hidden;',
      '  text-overflow:ellipsis;white-space:nowrap}',
      '.astock-mlist-name span{font-size:11px;line-height:16px;color:var(--astock-text-3)}',
      '.astock-mlist-num{font-variant-numeric:tabular-nums;font-size:13px;text-align:right}',
      '.astock-mlist-add{appearance:none;font:inherit;font-size:15px;line-height:20px;width:28px;height:28px;',
      '  border-radius:var(--astock-radius-sm);border:.5px solid var(--astock-border-strong);cursor:pointer;',
      '  background:transparent;color:var(--astock-text-2);padding:0}',
      '.astock-mlist-add[data-in="true"]{background:var(--astock-accent);border-color:transparent;color:#fff}',
      '.astock-mlist-add:hover{background:var(--astock-hover)}',
      '.astock-mlist-add[data-in="true"]:hover{filter:brightness(.92)}',
      '.astock-mlist-add:focus-visible{outline:2px solid var(--astock-accent);outline-offset:1px}',
      '.astock-basis-line{display:grid;grid-template-columns:64px 78px minmax(0,1fr);gap:8px;',
      '  align-items:baseline;padding:5px 0;border-bottom:.5px solid var(--astock-border);font-size:12.5px;line-height:19px}',
      '.astock-basis-line:last-of-type{border-bottom:0}',
      '.astock-basis-tag{font-size:11px;line-height:17px;font-weight:600;white-space:nowrap}',
      '.astock-basis-factor{font-variant-numeric:tabular-nums;color:var(--astock-text-3);font-size:12px;white-space:nowrap}',
      '.astock-basis-text{color:var(--astock-text-2);min-width:0}',
      '.astock-basis-signals{margin:6px 0 0 0;padding:0 0 0 14px;list-style:none;',
      '  display:flex;flex-direction:column;gap:3px;border-top:.5px dashed var(--astock-border);padding-top:7px}',
      '.astock-basis-signals li{font-size:12px;line-height:18px;color:var(--astock-text-2)}',
      '.astock-basis-signals li::before{content:"· ";color:var(--astock-text-3)}',
      '.astock-basis-toggle{appearance:none;font:inherit;font-size:11px;line-height:16px;padding:2px 8px;',
      '  cursor:pointer;border:.5px solid var(--astock-border-strong);border-radius:999px;background:transparent;',
      '  color:var(--astock-text-3);white-space:nowrap}',
      '.astock-basis-toggle:hover{background:var(--astock-hover);color:var(--astock-text)}',
      '.astock-basis-toggle:focus-visible{outline:2px solid var(--astock-accent);outline-offset:1px}',
      '.astock-company-text{font-size:12.5px;line-height:20px;color:var(--astock-text-2);margin:0;',
      '  white-space:pre-wrap;word-break:break-word}',
      '.astock-company-text[data-clamped="true"]{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;',
      '  overflow:hidden}',
      '.astock-company-more{appearance:none;font:inherit;font-size:11px;line-height:16px;padding:0;',
      '  background:transparent;border:0;color:var(--astock-accent);cursor:pointer;text-align:left}',
      '.astock-company-more:hover{text-decoration:underline}',
      '.astock-company-row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;align-items:baseline;',
      '  font-size:12.5px;line-height:19px;padding:3px 0}',
      '.astock-company-label{color:var(--astock-text-3);font-size:11.5px;white-space:nowrap}',
      '.astock-company-value{color:var(--astock-text-2);min-width:0;word-break:break-word}',
      '.astock-announce{display:flex;flex-direction:column;gap:0}',
      '.astock-announce-item{display:grid;grid-template-columns:74px minmax(0,1fr);gap:8px;align-items:baseline;',
      '  padding:6px 0;border-bottom:.5px solid var(--astock-border);font-size:12.5px;line-height:19px}',
      '.astock-announce-item:last-child{border-bottom:0}',
      '.astock-announce-date{color:var(--astock-text-3);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.astock-announce-title{color:var(--astock-text);text-decoration:none;min-width:0;word-break:break-word}',
      'a.astock-announce-title:hover{color:var(--astock-accent);text-decoration:underline}',
      '.astock-constituents{display:flex;flex-direction:column;border:.5px solid var(--astock-border);',
      '  border-radius:var(--astock-radius);overflow:hidden;max-height:420px;overflow-y:auto}',
      '.astock-list-search{display:flex}',
      '.astock-list-search-input{flex:1 1 auto;font:inherit;font-size:12px;line-height:18px;padding:5px 10px;',
      '  border-radius:var(--astock-radius-sm);border:.5px solid var(--astock-border-strong);',
      '  background:var(--astock-bg-soft);color:var(--astock-text);min-width:0}',
      '.astock-list-search-input:focus{outline:2px solid var(--astock-accent);outline-offset:-1px}',
      '.astock-list-pager{display:flex;align-items:center;gap:8px;justify-content:flex-end;padding-top:2px}',
      '.astock-list-pager .astock-card-note{margin-right:auto}',
      '.astock-sector-list{display:flex;flex-direction:column;gap:0;border:.5px solid var(--astock-border);',
      '  border-radius:var(--astock-radius);overflow:hidden}',
      '.astock-sector-row{display:grid;grid-template-columns:minmax(0,1.5fr) 72px 56px 1fr 86px;align-items:center;',
      '  gap:8px;padding:8px 11px;border-bottom:.5px solid var(--astock-border);cursor:pointer;',
      '  background:transparent;font:inherit;text-align:left;width:100%;color:inherit}',
      '.astock-sector-row:last-child{border-bottom:0}',
      '.astock-sector-row:hover{background:var(--astock-hover)}',
      '.astock-sector-row:focus-visible{outline:2px solid var(--astock-accent);outline-offset:-2px}',
      '.astock-sector-row[data-active="true"]{background:var(--astock-hover);box-shadow:inset 2px 0 0 var(--astock-accent)}',
      '.astock-sector-name{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.astock-sector-name b{font-weight:600;font-size:13px;line-height:19px;overflow:hidden;',
      '  text-overflow:ellipsis;white-space:nowrap}',
      '.astock-sector-name span{font-size:11px;line-height:16px;color:var(--astock-text-3);overflow:hidden;',
      '  text-overflow:ellipsis;white-space:nowrap}',
      '.astock-sector-num{font-variant-numeric:tabular-nums;font-size:13px;line-height:19px;text-align:right}',
      '.astock-sector-score{display:flex;align-items:center;gap:6px;justify-content:flex-end}',
      '.astock-sector-bar{flex:1 1 auto;height:5px;border-radius:999px;background:var(--astock-track);overflow:hidden}',
      '.astock-sector-bar i{display:block;height:100%;border-radius:999px;background:var(--astock-accent)}',
      '.astock-sector-head{display:grid;grid-template-columns:minmax(0,1.5fr) 72px 56px 1fr 86px;gap:8px;',
      '  padding:6px 11px;font-size:11px;line-height:16px;color:var(--astock-text-3);',
      '  border-bottom:.5px solid var(--astock-border);background:var(--astock-bg-soft)}',
      '.astock-sector-head span:nth-child(n+2){text-align:right}',
      '.astock-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}',
      '.astock-fact{display:flex;flex-direction:column;gap:1px;padding:7px 10px;',
      '  border:.5px solid var(--astock-border);border-radius:var(--astock-radius-sm);background:var(--astock-bg-soft)}',
      '.astock-fact-label{font-size:11px;line-height:16px;color:var(--astock-text-3)}',
      '.astock-fact-value{font-size:13px;line-height:19px;font-variant-numeric:tabular-nums;font-weight:600}',
      '@media (max-width:900px){.astock-body{grid-template-columns:minmax(0,1fr)}}',
      '@media (max-width:520px){.astock-root{padding:12px 12px 24px}',
      '  .astock-price-value{font-size:21px;line-height:27px}',
      '  .astock-sector-row,.astock-sector-head{grid-template-columns:minmax(0,1fr) 58px 48px;gap:6px}',
      '  .astock-sector-row .astock-sector-hide-sm,.astock-sector-head .astock-sector-hide-sm{display:none}}',
    ].join('\n');

    /* ------------------------------------------------------------------ *
     * 基础工具
     * ------------------------------------------------------------------ */

    /** 极简快照 store，供 store 模块缺失时降级。 */
    function createLocalStore(initial) {
      var value = initial;
      var listeners = new Set();
      function emit() {
        listeners.forEach(function (listener) {
          try {
            listener();
          } catch (error) {
            /* 单个订阅者出错不能影响页面 */
          }
        });
      }
      return {
        getSnapshot: function () {
          return value;
        },
        set: function (next) {
          value = next;
          emit();
        },
        update: function (updater) {
          value = updater(value);
          emit();
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () {
            listeners.delete(listener);
          };
        },
      };
    }

    var createSnapshotStore = storeLib !== null && typeof storeLib.createSnapshotStore === 'function'
      ? storeLib.createSnapshotStore
      : createLocalStore;

    /** 跨挂载保留的界面记忆（切到别的面板再回来不丢内容）。 */
    var MEMO = { code: '', label: '', view: null, watch: null, fetchedAt: 0, tab: 'stock', sector: null, marketList: null };

    /** 缓存结果超过该时长后，重新挂载时静默刷新一次。 */
    var MEMO_FRESH_MS = 60000;

    /** 内置字典翻译器。 */
    function translate(locale) {
      var table = locale === 'zh' ? zh : en;
      var other = locale === 'zh' ? en : zh;
      return function (key, params) {
        var text = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
        if (text === null) text = Object.prototype.hasOwnProperty.call(other, key) ? other[key] : key;
        if (params !== undefined && params !== null) {
          Object.keys(params).forEach(function (name) {
            text = text.split('{' + name + '}').join(String(params[name]));
          });
        }
        return text;
      };
    }

    function detectLocale() {
      try {
        var nav = typeof navigator !== 'undefined' ? navigator : null;
        var lang = nav !== null && typeof nav.language === 'string' ? nav.language : '';
        return /^zh/i.test(lang) ? 'zh' : 'en';
      } catch (error) {
        return 'en';
      }
    }

    var fallbackT = translate(detectLocale());

    /** 组合外部 locale.bind 与内置字典：外部优先，缺失时回退。 */
    function bindTranslator(locale) {
      var external = null;
      if (locale !== null && locale !== undefined && typeof locale.bind === 'function') {
        try {
          external = locale.bind(NS);
        } catch (error) {
          external = null;
        }
      }
      var builtin = translate(detectLocale());
      if (typeof external !== 'function') return builtin;
      return function (key, params) {
        var text = null;
        try {
          text = external(key, params);
        } catch (error) {
          text = null;
        }
        if (typeof text === 'string' && text.length > 0 && text !== key) return text;
        return builtin(key, params);
      };
    }

    function errorMessage(error, t) {
      if (error === null || error === undefined) return t('unknown');
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string' && error.message.length > 0) return error.message;
      return String(error);
    }

    /** RPC 调用包装：把 {ok,value} / {ok:false,error} 归一成 value / throw。 */
    function makeCaller(rpc, t) {
      return function call(endpoint, payload, signal) {
        if (rpc === null || rpc === undefined || typeof rpc.call !== 'function') {
          return Promise.reject(new Error(t('errorNoRpc')));
        }
        var pending;
        try {
          pending = rpc.call(CHANNEL, endpoint, payload || {}, signal);
        } catch (error) {
          return Promise.reject(error);
        }
        return Promise.resolve(pending).then(function (response) {
          if (response !== null && response !== undefined && response.ok === true) {
            return response.value;
          }
          var detail = response !== null && response !== undefined && response.error !== null && response.error !== undefined
            ? response.error.message
            : null;
          throw new Error(typeof detail === 'string' && detail.length > 0 ? detail : t('errorRpc'));
        });
      };
    }

    function asNumber(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim().length > 0) {
        var parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return null;
    }

    function clampScore(value) {
      var number = asNumber(value);
      if (number === null) return null;
      if (number < 0) return 0;
      if (number > 100) return 100;
      return number;
    }

    function fmtFixed(value, digits) {
      var number = asNumber(value);
      if (number === null) return '—';
      return number.toFixed(digits === undefined ? 2 : digits);
    }

    function fmtSigned(value, digits) {
      var number = asNumber(value);
      if (number === null) return '—';
      var text = number.toFixed(digits === undefined ? 2 : digits);
      return number > 0 ? '+' + text : text;
    }

    function fmtPercent(value) {
      var number = asNumber(value);
      if (number === null) return '—';
      return fmtSigned(number, 2) + '%';
    }

    function trendTone(value) {
      var number = asNumber(value);
      if (number === null || number === 0) return 'flat';
      return number > 0 ? 'up' : 'down';
    }

    /** 成交额（元）→ 中文可读单位。 */
    function fmtAmount(value) {
      var number = asNumber(value);
      if (number === null) return '—';
      var abs = Math.abs(number);
      if (abs >= 1e8) return (number / 1e8).toFixed(2) + ' 亿';
      if (abs >= 1e4) return (number / 1e4).toFixed(2) + ' 万';
      return number.toFixed(0);
    }

    /** 市值/量级字段（亿）→ 文本。 */
    function fmtYi(value) {
      var number = asNumber(value);
      if (number === null) return '—';
      return number.toFixed(2) + ' 亿';
    }

    /** 去掉市场前缀，得到纯代码小写，用作列表 key。 */
    function bareCode(input) {
      var text = String(input === null || input === undefined ? '' : input).toLowerCase().trim();
      var digits = /(\d{5,6})$/.exec(text);
      return digits !== null ? digits[1] : text;
    }

    function looksLikeCode(text) {
      return /^(sh|sz|bj)?\d{6}$/i.test(String(text || '').trim());
    }

    function marketLabel(market) {
      var text = String(market || '').toLowerCase();
      if (text === 'sh') return '沪';
      if (text === 'sz') return '深';
      if (text === 'bj') return '京';
      if (text === 'hk') return '港';
      if (text === 'us') return '美';
      return text.toUpperCase();
    }

    /** 分数 → 语义色（A股习惯：偏多=红，偏空=绿）。 */
    function scoreTone(score) {
      var number = clampScore(score);
      if (number === null) return 'flat';
      if (number >= 75) return 'up';
      if (number >= 58) return 'up-soft';
      if (number <= 25) return 'down';
      if (number <= 42) return 'down-soft';
      return 'flat';
    }

    function toneColor(tone) {
      if (tone === 'up') return 'var(--astock-up)';
      if (tone === 'up-soft') return 'var(--astock-up-soft)';
      if (tone === 'down') return 'var(--astock-down)';
      if (tone === 'down-soft') return 'var(--astock-down-soft)';
      return 'var(--astock-flat)';
    }

    /** verdict → tone，用于标签配色。 */
    function verdictTone(verdict) {
      var key = String(verdict || '');
      if (key === 'strong-bull') return 'up';
      if (key === 'bull') return 'up-soft';
      if (key === 'bear') return 'down-soft';
      if (key === 'strong-bear') return 'down';
      return 'flat';
    }

    function verdictText(t, evaluation) {
      var verdict = String(evaluation !== null && evaluation !== undefined && evaluation.verdict !== undefined
        ? evaluation.verdict
        : 'neutral');
      var VERDICT_KEY = {
        'strong-bull': 'strongBull',
        'bull': 'bull',
        'neutral': 'neutral',
        'bear': 'bear',
        'strong-bear': 'strongBear',
      };
      var key = VERDICT_KEY[verdict];
      if (key !== undefined) return t(key);
      /* 未知 verdict 时才回退后端 verdictLabel，避免中英文混用。 */
      if (typeof evaluation.verdictLabel === 'string' && evaluation.verdictLabel.length > 0) {
        return evaluation.verdictLabel;
      }
      return t('neutral');
    }

    function factorText(t, factor) {
      var key = String(factor !== null && factor !== undefined && typeof factor.key === 'string' ? factor.key : '');
      var text = t(key);
      if (text !== key) return text;
      if (factor !== null && factor !== undefined && typeof factor.label === 'string' && factor.label.length > 0) {
        return factor.label;
      }
      return key;
    }

    function readStoredCode() {
      try {
        var value = window.localStorage.getItem(LAST_CODE_KEY);
        return typeof value === 'string' ? value : '';
      } catch (error) {
        return '';
      }
    }

    function storeLastCode(code) {
      try {
        if (typeof code === 'string' && code.length > 0) window.localStorage.setItem(LAST_CODE_KEY, code);
        else window.localStorage.removeItem(LAST_CODE_KEY);
      } catch (error) {
        /* 隐私模式下 localStorage 可能不可用 */
      }
    }

    /** 上传一次侧栏热状态：最近查看的代码。 */
    var SESSION = createSnapshotStore({ lastCode: readStoredCode() });

    function ensureStyles() {
      if (typeof document === 'undefined' || document.head === null) return;
      if (document.querySelector(STYLE_SELECTOR) !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-astock';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------ *
     * 原子展示组件（primitives 可用则复用，否则原生降级）
     * ------------------------------------------------------------------ */

    /**
     * 按钮工厂。
     *
     * 支持两种调用形态：
     *   uiButton({ variant, size, onClick, children })
     *   uiButton({ variant, size, onClick }, label)   ← 第二个参数是按钮文字
     *
     * 第二种形态必须支持：本文件里多处按 `uiButton({...}, t('...'))` 调用，
     * 早先的实现只接 `props` 一个参数，第二个参数被静默丢弃，导致「加入自选」
     * 「返回」「上一页」这些按钮渲染成完全空白的按钮。
     *
     * @param {object} props - 按钮配置
     * @param {*} [label] - 按钮内容，优先于 props.children
     * @returns {object} React 元素
     */
    function uiButton(props, label) {
      var config = props !== null && props !== undefined ? props : {};
      var content = label !== undefined ? label : config.children;
      if (P !== null && P.Button !== undefined) {
        try {
          /* 只传 primitives 明确支持的字段，variant 归一为 primary/outline。 */
          return h(P.Button, {
            variant: config.variant === 'primary' ? 'primary' : 'outline',
            size: config.size,
            disabled: config.disabled,
            title: config.title,
            'aria-label': config['aria-label'],
            onClick: config.onClick,
          }, content);
        } catch (error) {
          /* 降级到原生按钮 */
        }
      }
      var className = 'astock-btn';
      if (config.variant === 'primary') className += ' astock-btn-primary';
      if (config.variant === 'quiet') className += ' astock-btn-quiet';
      if (config.size === 'sm') className += ' astock-btn-sm';
      if (typeof config.className === 'string' && config.className.length > 0) className += ' ' + config.className;
      return h('button', {
        type: 'button',
        className: className,
        disabled: config.disabled,
        title: config.title,
        'aria-label': config['aria-label'],
        onClick: config.onClick,
      }, content);
    }

    function Spinner() {
      return h('span', { className: 'astock-spinner', 'aria-hidden': 'true' });
    }

    function EmptyState(props) {
      return h('div', { className: 'astock-state' },
        h('p', { className: 'astock-state-title' }, props.title),
        props.text !== undefined && props.text !== null && props.text.length > 0
          ? h('p', { className: 'astock-state-text' }, props.text)
          : null,
        props.action === undefined || props.action === null ? null : props.action);
    }

    function LoadingState(props) {
      return h('div', { className: 'astock-loading', role: 'status', 'aria-live': 'polite' },
        Spinner(),
        h('div', { className: 'astock-loading-text' },
          h('span', { className: 'astock-loading-title' }, props.title),
          props.hint !== undefined && props.hint !== null && props.hint.length > 0
            ? h('span', { className: 'astock-loading-hint' }, props.hint)
            : null));
    }

    function ErrorState(props) {
      return h('div', { className: 'astock-error', role: 'alert' },
        h('p', { className: 'astock-error-text' }, props.message),
        props.onRetry === undefined || props.onRetry === null
          ? null
          : h('div', null, uiButton({ variant: 'quiet', size: 'sm', onClick: props.onRetry }, props.retryLabel)));
    }

    /* ------------------------------------------------------------------ *
     * 侧栏图标
     * ------------------------------------------------------------------ */

    /** 侧栏图标：上涨折线 + 箭头，props 为 { size, active }。 */
    function PanelIcon(props) {
      var size = asNumber(props !== null && props !== undefined ? props.size : null);
      if (size === null || size <= 0) size = 20;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { d: 'M3 16.5l5-5 3.5 3.5L21 5.5' }),
        h('path', { d: 'M21 10.5V5.5h-5' }),
        h('path', { d: 'M3 20.5h18' }));
    }

    /* ------------------------------------------------------------------ *
     * 指数条
     * ------------------------------------------------------------------ */

    function IndicesBar(props) {
      var t = props.t;
      var state = props.state;
      if (state.status === 'error') {
        return h('div', { className: 'astock-indices' },
          h('div', { className: 'astock-index' },
            h('span', { className: 'astock-index-name' }, t('indicesTitle')),
            h('div', { className: 'astock-index-row' },
              h('span', { className: 'astock-index-change', style: { color: 'var(--astock-flat)' } },
                t('indicesFailed', { error: state.error || t('unknown') })))));
      }
      if (state.status === 'idle' || state.status === 'loading') {
        return h('div', { className: 'astock-indices' },
          h('div', { className: 'astock-index' },
            h('span', { className: 'astock-index-name' }, t('indicesTitle')),
            h('div', { className: 'astock-index-row' },
              Spinner(),
              h('span', { className: 'astock-index-change', style: { color: 'var(--astock-text-3)' } }, t('indicesLoading')))));
      }
      var items = Array.isArray(state.items) ? state.items : [];
      if (items.length === 0) {
        return h('div', { className: 'astock-indices' },
          h('div', { className: 'astock-index' },
            h('span', { className: 'astock-index-name' }, t('indicesTitle')),
            h('div', { className: 'astock-index-row' },
              h('span', { className: 'astock-index-change', style: { color: 'var(--astock-text-3)' } }, t('indicesEmpty')))));
      }
      return h('div', { className: 'astock-indices' }, items.map(function (quote, index) {
        var key = quote !== null && quote !== undefined && quote.secid ? String(quote.secid) : 'index-' + String(index);
        var tone = trendTone(quote !== null && quote !== undefined ? quote.changePercent : null);
        var name = quote !== null && quote !== undefined && typeof quote.name === 'string' ? quote.name : t('unknown');
        return h('div', { key: key, className: 'astock-index' },
          h('span', { className: 'astock-index-name', title: name }, name),
          h('div', { className: 'astock-index-row' },
            h('span', { className: 'astock-index-price', style: { color: toneColor(tone) } },
              fmtFixed(quote !== null && quote !== undefined ? quote.price : null, 2)),
            h('span', { className: 'astock-index-change', style: { color: toneColor(tone) } },
              fmtFixed(quote !== null && quote !== undefined ? quote.change : null, 2) + ' / ' +
              fmtPercent(quote !== null && quote !== undefined ? quote.changePercent : null))));
      }));
    }

    /* ------------------------------------------------------------------ *
     * 搜索框 + 候选下拉
     * ------------------------------------------------------------------ */

    function SearchBar(props) {
      var t = props.t;
      var keyword = props.keyword;
      var state = props.state;
      var open = props.open;
      var onChange = props.onChange;
      var onSubmit = props.onSubmit;
      var onPick = props.onPick;
      var onFocus = props.onFocus;
      var onBlur = props.onBlur;

      var results = Array.isArray(state.results) ? state.results : [];
      var showSuggest = open === true && keyword.trim().length > 0;

      var body = null;
      if (showSuggest) {
        if (state.status === 'loading') {
          body = h('div', { className: 'astock-suggest-note' }, t('searching'));
        } else if (state.status === 'error') {
          body = h('div', { className: 'astock-suggest-note' }, t('searchFailed', { error: state.error || t('unknown') }));
        } else if (results.length === 0) {
          body = h('div', { className: 'astock-suggest-note' },
            state.queried === true ? t('noResults') : t('searchHint'));
        } else {
          body = results.map(function (item, index) {
            var secid = item !== null && item !== undefined && typeof item.secid === 'string' ? item.secid : '';
            var code = item !== null && item !== undefined && typeof item.code === 'string' ? item.code : bareCode(secid);
            var name = item !== null && item !== undefined && typeof item.name === 'string' ? item.name : '';
            return h('button', {
              key: secid.length > 0 ? secid : 'suggest-' + String(index),
              type: 'button',
              className: 'astock-suggest-item',
              onMouseDown: function (event) {
                event.preventDefault();
                onPick(item);
              },
            },
              h('span', { className: 'astock-suggest-code' }, code),
              h('span', { className: 'astock-suggest-name' }, name),
              h('span', { className: 'astock-suggest-tag' },
                marketLabel(item !== null && item !== undefined ? item.market : '')));
          });
        }
      }

      return h('div', { className: 'astock-search' },
        h('div', { className: 'astock-search-field' },
        h('div', { className: 'astock-search-box' },
          h('span', { className: 'astock-search-glyph' },
            h('svg', {
              width: 14,
              height: 14,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              'aria-hidden': 'true',
            },
              h('circle', { cx: 11, cy: 11, r: 7 }),
              h('path', { d: 'M20 20l-3.6-3.6' }))),
          h('input', {
            className: 'astock-search-input',
            type: 'text',
            value: keyword,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchPlaceholder'),
            autoComplete: 'off',
            spellCheck: false,
            onChange: function (event) {
              onChange(event.target.value);
            },
            onFocus: onFocus,
            onBlur: onBlur,
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                event.preventDefault();
                onSubmit();
              } else if (event.key === 'Escape') {
                onBlur();
              }
            },
          }),
          state.status === 'loading' ? Spinner() : null),
        showSuggest
          ? h('div', { className: 'astock-suggest', role: 'listbox' }, body)
          : null),
        keyword.trim().length === 0 ? h('span', { className: 'astock-search-hint' }, t('searchHint')) : null);
    }

    /* ------------------------------------------------------------------ *
     * 主结果卡
     * ------------------------------------------------------------------ */

    function ScoreRing(props) {
      var t = props.t;
      var score = clampScore(props.score);
      var tone = scoreTone(score);
      var color = toneColor(tone);
      var percent = score === null ? 0 : score;
      return h('div', {
        className: 'astock-ring',
        style: {
          background: 'conic-gradient(' + color + ' 0 ' + percent.toFixed(1) + '%, var(--astock-track) ' +
            percent.toFixed(1) + '% 100%)',
        },
        role: 'img',
        'aria-label': t('score') + ' ' + (score === null ? '—' : score.toFixed(0)) + t('scoreUnit'),
      },
        h('div', { className: 'astock-ring-inner' },
          h('span', { className: 'astock-ring-number', style: { color: color } },
            score === null ? '—' : score.toFixed(0)),
          h('span', { className: 'astock-ring-unit' }, t('scoreUnit'))));
    }

    function MetricsGrid(props) {
      var t = props.t;
      var quote = props.quote;
      if (quote === null || quote === undefined) return null;
      var cells = [
        { label: t('metricVolumeRatio'), value: fmtFixed(quote.volumeRatio, 2) },
        { label: t('metricTurnover'), value: quote.turnoverRate === null || quote.turnoverRate === undefined
          ? '—' : fmtFixed(quote.turnoverRate, 2) + '%' },
        { label: t('metricAmplitude'), value: quote.amplitude === null || quote.amplitude === undefined
          ? '—' : fmtFixed(quote.amplitude, 2) + '%' },
        { label: t('metricAmount'), value: fmtAmount(quote.amount) },
        { label: t('metricPe'), value: fmtFixed(quote.peTtm, 2) },
        { label: t('metricPb'), value: fmtFixed(quote.pb, 2) },
        { label: t('metricFloatCap'), value: fmtYi(quote.floatCap) },
        { label: t('metricTotalCap'), value: fmtYi(quote.totalCap) },
        {
          label: t('metricOpen'),
          value: fmtFixed(quote.open, 2),
          tone: asNumber(quote.open) !== null && asNumber(quote.prevClose) !== null
            ? trendTone(quote.open - quote.prevClose)
            : undefined,
        },
        { label: t('metricPrevClose'), value: fmtFixed(quote.prevClose, 2) },
        { label: t('metricHigh'), value: fmtFixed(quote.high, 2), tone: 'up' },
        { label: t('metricLow'), value: fmtFixed(quote.low, 2), tone: 'down' },
      ];
      return h('div', { className: 'astock-metrics' }, cells.map(function (cell, index) {
        return h('div', { key: 'metric-' + String(index), className: 'astock-metric' },
          h('span', { className: 'astock-metric-label', title: cell.label }, cell.label),
          h('span', {
            className: 'astock-metric-value',
            style: cell.tone === undefined ? null : { color: toneColor(cell.tone) },
          }, cell.value));
      }));
    }

    function ResultCard(props) {
      var t = props.t;
      var evaluation = props.evaluation;
      var quote = props.quote;
      var detailOpen = props.detailOpen;
      var onToggleDetail = props.onToggleDetail;

      var name = typeof evaluation.name === 'string' && evaluation.name.length > 0
        ? evaluation.name
        : (quote !== null && quote !== undefined && typeof quote.name === 'string' ? quote.name : t('unknown'));
      var code = typeof evaluation.code === 'string' ? evaluation.code : bareCode(evaluation.secid);
      var market = typeof evaluation.secid === 'string' && evaluation.secid.length > 2
        ? evaluation.secid.slice(0, 2)
        : (quote !== null && quote !== undefined ? quote.market : '');
      var price = asNumber(evaluation.price) !== null
        ? evaluation.price
        : (quote !== null && quote !== undefined ? quote.price : null);
      var changePercent = asNumber(evaluation.changePercent) !== null
        ? evaluation.changePercent
        : (quote !== null && quote !== undefined ? quote.changePercent : null);
      var change = quote !== null && quote !== undefined ? quote.change : null;
      var tone = trendTone(changePercent);
      var verdict = verdictText(t, evaluation);
      var vtone = verdictTone(evaluation.verdict);
      var probability = asNumber(evaluation.upProbability);
      var metrics = quote !== null && quote !== undefined
        ? h(MetricsGrid, { t: t, quote: quote })
        : null;
      var quality = evaluation.dataQuality !== null && evaluation.dataQuality !== undefined
        ? evaluation.dataQuality
        : null;

      return h('section', { className: 'astock-card', 'aria-label': name },
        h('div', { className: 'astock-quote-head' },
          h('div', { className: 'astock-quote-ident' },
            h('span', { className: 'astock-quote-name', title: name }, name),
            h('span', { className: 'astock-quote-meta' },
              [code, market.length > 0 ? marketLabel(market) : '', typeof evaluation.asOf === 'string' ? evaluation.asOf : '']
                .filter(function (part) { return part.length > 0; })
                .join(' · '))),
          h('div', { className: 'astock-header-actions' },
            props.addButton)),
        h('div', { className: 'astock-quote-price' },
          h('span', { className: 'astock-price-value', style: { color: toneColor(tone) } }, fmtFixed(price, 2)),
          h('span', { className: 'astock-price-change', style: { color: toneColor(tone) } },
            asNumber(change) === null
              ? fmtPercent(changePercent)
              : fmtSigned(change, 2) + '  ' + fmtPercent(changePercent))),
        h('div', { className: 'astock-score-block' },
          h(ScoreRing, { t: t, score: evaluation.score }),
          h('div', { className: 'astock-score-side' },
            h('span', { className: 'astock-badge', style: { color: toneColor(vtone) } }, verdict),
            h('p', { className: 'astock-summary' }, typeof evaluation.summary === 'string' ? evaluation.summary : ''),
            probability === null
              ? null
              : h('span', { className: 'astock-prob' },
                t('upProbabilityValue', { value: Math.round(probability * 100) + '%' }) + ' · ' + t('heuristicNote')))),
        metrics !== null
          ? h('div', null,
            h('div', { className: 'astock-card-head' },
              h('h3', { className: 'astock-card-title' }, t('metricsTitle')),
              h('button', {
                type: 'button',
                className: 'astock-btn astock-btn-quiet astock-btn-sm',
                onClick: onToggleDetail,
                'aria-expanded': detailOpen === true ? 'true' : 'false',
              }, detailOpen === true ? t('collapse') : t('expand'))),
            detailOpen === true ? metrics : null)
          : null,
        quality !== null && Array.isArray(quality.warnings) && quality.warnings.length > 0
          ? h('div', null,
            h('h3', { className: 'astock-card-title' }, t('dataQuality')),
            h('ul', { className: 'astock-list' },
              h('li', { className: 'astock-item', 'data-tone': 'warn' },
                [
                  typeof quality.bars === 'number' ? t('qualityBars', { count: String(quality.bars) }) : '',
                  quality.hasQuote === false ? t('qualityNoQuote') : '',
                  quality.stale === true ? t('qualityStale') : '',
                ].filter(function (part) { return part.length > 0; }).join(' · ')),
              quality.warnings.map(function (warning, index) {
                return h('li', { key: 'warning-' + String(index), className: 'astock-item', 'data-tone': 'warn' },
                  String(warning));
              })) )
          : null);
    }

    /* ------------------------------------------------------------------ *
     * 因子拆解
     * ------------------------------------------------------------------ */

    function FactorBars(props) {
      var t = props.t;
      var factors = Array.isArray(props.factors) ? props.factors : [];
      var expanded = props.expanded;
      var onToggle = props.onToggle;

      if (factors.length === 0) {
        return h('section', { className: 'astock-card' },
          h('h3', { className: 'astock-card-title' }, t('factors')),
          h('p', { className: 'astock-card-note' }, t('factorsEmpty')));
      }

      var ordered = factors.slice().sort(function (a, b) {
        var leftRaw = a !== null && a !== undefined ? a.weight : null;
        var rightRaw = b !== null && b !== undefined ? b.weight : null;
        var left = asNumber(leftRaw);
        var right = asNumber(rightRaw);
        if (left === null && right === null) return 0;
        if (left === null) return 1;
        if (right === null) return -1;
        return right - left;
      });

      return h('section', { className: 'astock-card' },
        h('div', { className: 'astock-card-head' },
          h('h3', { className: 'astock-card-title' }, t('factors')),
          h('span', { className: 'astock-card-note' }, t('factorsHint'))),
        h('div', { className: 'astock-factors' }, ordered.map(function (factor, index) {
          var key = factor !== null && factor !== undefined && typeof factor.key === 'string'
            ? factor.key
            : 'factor-' + String(index);
          var open = expanded !== null && expanded !== undefined && expanded[key] === true;
          var score = clampScore(factor !== null && factor !== undefined ? factor.score : null);
          var weight = asNumber(factor !== null && factor !== undefined ? factor.weight : null);
          var percent = score === null ? 0 : score;
          var tone = scoreTone(score);
          var signals = factor !== null && factor !== undefined && Array.isArray(factor.signals) ? factor.signals : [];
          var label = factorText(t, factor);
          return h('div', { key: key, className: 'astock-factor', 'data-open': open ? 'true' : 'false' },
            h('button', {
              type: 'button',
              className: 'astock-factor-head',
              'aria-expanded': open ? 'true' : 'false',
              title: open ? t('collapse') : t('expand'),
              onClick: function () {
                onToggle(key);
              },
            },
              h('span', { className: 'astock-factor-label' }, label),
              h('span', { className: 'astock-factor-weight' },
                weight === null ? '' : t('weight', { value: (weight * 100).toFixed(0) + '%' })),
              h('span', { className: 'astock-factor-score', style: { color: toneColor(tone) } },
                score === null ? '—' : score.toFixed(0)),
              h('span', { className: 'astock-factor-caret', 'aria-hidden': 'true' }, open ? '−' : '+')),
            h('div', { className: 'astock-factor-track' },
              h('div', {
                className: 'astock-factor-fill',
                style: { width: percent + '%', background: toneColor(tone) },
              })),
            open
              ? h('ul', { className: 'astock-factor-signals' }, signals.map(function (signal, signalIndex) {
                return h('li', { key: 'signal-' + String(signalIndex), className: 'astock-signal' },
                  String(signal));
              }))
              : null);
        })));
    }

    /* ------------------------------------------------------------------ *
     * 关键位 / 风险 / 免责声明
     * ------------------------------------------------------------------ */

    function LevelsCard(props) {
      var t = props.t;
      var levels = props.levels;
      var support = levels !== null && levels !== undefined && Array.isArray(levels.support) ? levels.support : [];
      var resistance = levels !== null && levels !== undefined && Array.isArray(levels.resistance) ? levels.resistance : [];
      if (support.length === 0 && resistance.length === 0) {
        return h('section', { className: 'astock-card' },
          h('h3', { className: 'astock-card-title' }, t('levels')),
          h('p', { className: 'astock-card-note' }, t('levelsEmpty')));
      }
      function chips(list, tone) {
        if (list.length === 0) return h('span', { className: 'astock-card-note' }, t('dash'));
        return h('div', { className: 'astock-chips', 'data-tone': tone }, list.map(function (value, index) {
          return h('span', { key: 'level-' + tone + '-' + String(index), className: 'astock-chip' },
            fmtFixed(value, 2));
        }));
      }
      return h('section', { className: 'astock-card' },
        h('h3', { className: 'astock-card-title' }, t('levels')),
        h('div', { className: 'astock-levels' },
          h('div', { className: 'astock-level-group' },
            h('span', { className: 'astock-level-label' }, t('support')),
            chips(support, 'sup')),
          h('div', { className: 'astock-level-group' },
            h('span', { className: 'astock-level-label' }, t('resistance')),
            chips(resistance, 'res'))));
    }

    function RisksCard(props) {
      var t = props.t;
      var risks = Array.isArray(props.risks) ? props.risks : [];
      return h('section', { className: 'astock-card' },
        h('h3', { className: 'astock-card-title' }, t('risks')),
        risks.length === 0
          ? h('p', { className: 'astock-card-note' }, t('noRisks'))
          : h('ul', { className: 'astock-list' }, risks.map(function (risk, index) {
            return h('li', { key: 'risk-' + String(index), className: 'astock-item', 'data-tone': 'risk' },
              String(risk));
          })));
    }

    function DisclaimerNote(props) {
      var t = props.t;
      var text = typeof props.text === 'string' && props.text.length > 0 ? props.text : '';
      return h('div', { className: 'astock-card' },
        h('h3', { className: 'astock-card-title' }, t('disclaimer')),
        h('p', { className: 'astock-disclaimer' }, text.length > 0 ? text : t('dash')));
    }

    /* ------------------------------------------------------------------ *
     * 自选股
     * ------------------------------------------------------------------ */

    /**
     * 涨跌依据卡片：放在个股详情页，回答「这只股票为什么涨/跌」。
     *
     * 数据直接来自当前 Evaluation，不额外请求。默认展示最强/最弱因子各一条
     * 关键信号 + 首要风险，展开后列出这两个因子的全部信号。
     */
    function BasisCard(props) {
      var t = props.t;
      var evaluation = props.evaluation;
      var expanded = props.expanded === true;

      if (evaluation === null || evaluation === undefined) return null;

      var factors = Array.isArray(evaluation.factors) ? evaluation.factors.filter(function (f) {
        return f !== null && f !== undefined && asNumber(f.score) !== null;
      }) : [];
      if (factors.length === 0) return null;

      var sorted = factors.slice().sort(function (a, b) { return asNumber(b.score) - asNumber(a.score); });
      var strongest = sorted[0];
      var weakest = sorted.length > 1 ? sorted[sorted.length - 1] : null;
      var risks = Array.isArray(evaluation.risks) ? evaluation.risks : [];

      function signalsOf(factor) {
        if (factor === null || factor === undefined) return [];
        return (Array.isArray(factor.signals) ? factor.signals : []).map(String);
      }

      /** 一条「标签 + 因子分 + 首条信号」。 */
      function basisLine(tag, factor, tone) {
        if (factor === null || factor === undefined) return null;
        var list = signalsOf(factor);
        return h('div', { className: 'astock-basis-line' },
          h('span', { className: 'astock-basis-tag', style: { color: toneColor(tone) } }, tag),
          h('span', { className: 'astock-basis-factor' },
            String(factor.label || '') + ' ' + asNumber(factor.score).toFixed(0)),
          h('span', { className: 'astock-basis-text' }, list.length > 0 ? list[0] : t('dash')));
      }

      /* 展开区：最强/最弱因子的全部信号 */
      var detail = null;
      if (expanded) {
        var items = [];
        function pushAll(prefix, factor) {
          if (factor === null || factor === undefined) return;
          for (const signal of signalsOf(factor)) {
            items.push(h('li', { key: prefix + '-' + items.length }, signal));
          }
        }
        pushAll('strong', strongest);
        if (weakest !== null && weakest !== strongest) pushAll('weak', weakest);
        if (items.length > 0) detail = h('ul', { className: 'astock-basis-signals' }, items);
      }

      return h('section', { className: 'astock-card', 'aria-label': t('watchBasisTitle') },
        h('div', { className: 'astock-card-head' },
          h('div', null,
            h('h3', { className: 'astock-card-title' }, t('watchBasisTitle')),
            h('p', { className: 'astock-card-note' }, t('watchBasisHint'))),
          h('button', {
            type: 'button',
            className: 'astock-basis-toggle',
            onClick: function () { props.onToggle(); },
          }, expanded ? t('watchBasisCollapse') : t('watchBasisExpand'))),
        basisLine(t('watchBasisStrongest'), strongest, 'up'),
        weakest !== null ? basisLine(t('watchBasisWeakest'), weakest, 'down') : null,
        risks.length > 0
          ? h('div', { className: 'astock-basis-line' },
            h('span', { className: 'astock-basis-tag', style: { color: 'var(--astock-danger)' } }, t('watchBasisRisks')),
            h('span', { className: 'astock-basis-factor' }, ''),
            h('span', { className: 'astock-basis-text' }, String(risks[0])))
          : null,
        detail);
    }

    /**
     * 公司业务介绍卡片（A 股专有）。
     *
     * 数据来自东财 F10：ORG_PROFILE（简介）与 BUSINESS_SCOPE（经营范围）。
     * 简介默认折叠 4 行，点击展开全文——简介动辄上千字，直接铺开会把
     * 下面的因子拆解挤出首屏。
     */
    function CompanyCard(props) {
      var t = props.t;
      var profile = props.profile;
      var open = props.open === true;
      if (profile === null || profile === undefined) {
        return h('section', { className: 'astock-card' },
          h('h3', { className: 'astock-card-title' }, t('companyTitle')),
          h('p', { className: 'astock-card-note' }, t('companyNone')));
      }
      var rows = [];
      if (profile.industry) {
        rows.push(h('div', { className: 'astock-company-row', key: 'ind' },
          h('span', { className: 'astock-company-label' }, t('companyIndustry')),
          h('span', { className: 'astock-company-value' }, profile.industry)));
      }
      var facts = [];
      if (profile.employees) facts.push('员工 ' + profile.employees + ' 人');
      if (profile.chairman) facts.push('董事长 ' + profile.chairman);
      if (profile.regCapital) facts.push('注册资本 ' + profile.regCapital + ' 万');
      if (profile.website) facts.push(profile.website);
      if (profile.address) facts.push(profile.address);
      if (facts.length > 0) {
        rows.push(h('div', { className: 'astock-company-row', key: 'facts' },
          h('span', { className: 'astock-company-label' }, t('companyFacts')),
          h('span', { className: 'astock-company-value' }, facts.join(' · '))));
      }
      if (profile.businessScope) {
        rows.push(h('div', { className: 'astock-company-row', key: 'scope' },
          h('span', { className: 'astock-company-label' }, t('companyScope')),
          h('span', { className: 'astock-company-value' }, profile.businessScope)));
      }
      return h('section', { className: 'astock-card', 'aria-label': t('companyTitle') },
        h('h3', { className: 'astock-card-title' }, t('companyTitle')),
        profile.profile
          ? h('div', null,
            h('p', { className: 'astock-company-text', 'data-clamped': open ? 'false' : 'true' }, profile.profile),
            h('button', {
              type: 'button',
              className: 'astock-company-more',
              onClick: function () { props.onToggle(); },
            }, open ? t('expandLess') : t('expandMore')))
          : null,
        rows);
    }

    /** 最新公告列表。 */
    function AnnouncementsCard(props) {
      var t = props.t;
      var list = Array.isArray(props.items) ? props.items : [];
      return h('section', { className: 'astock-card', 'aria-label': t('announceTitle') },
        h('h3', { className: 'astock-card-title' }, t('announceTitle')),
        list.length === 0
          ? h('p', { className: 'astock-card-note' }, t('announceNone'))
          : h('div', { className: 'astock-announce' }, list.map(function (item, index) {
            var title = String(item.title || '');
            return h('div', { className: 'astock-announce-item', key: 'ann-' + index },
              h('span', { className: 'astock-announce-date' }, String(item.date || '--')),
              item.url
                ? h('a', {
                  className: 'astock-announce-title',
                  href: String(item.url),
                  target: '_blank',
                  rel: 'noreferrer',
                }, title)
                : h('span', { className: 'astock-announce-title' }, title));
          })));
    }

    /** 板块成分股列表（板块详情页内嵌）。 */
    function ConstituentsList(props) {
      var t = props.t;
      var state = props.state;
      var items = Array.isArray(state.items) ? state.items : [];
      if (state.status === 'loading' && items.length === 0) {
        return h('section', { className: 'astock-card' },
          h('h3', { className: 'astock-card-title' }, t('constituentsTitle')),
          h('p', { className: 'astock-card-note' }, t('constituentsLoading')));
      }
      if (state.status === 'error') {
        return h('section', { className: 'astock-card' },
          h('h3', { className: 'astock-card-title' }, t('constituentsTitle')),
          h('p', { className: 'astock-card-note', style: { color: 'var(--astock-danger)' } },
            t('constituentsFailed', { error: String(state.error || '') })));
      }
      if (items.length === 0) {
        return h('section', { className: 'astock-card' },
          h('h3', { className: 'astock-card-title' }, t('constituentsTitle')),
          h('p', { className: 'astock-card-note' }, t('constituentsEmpty')));
      }
      return h('section', { className: 'astock-card', 'aria-label': t('constituentsTitle') },
        h('div', { className: 'astock-card-head' },
          h('div', null,
            h('h3', { className: 'astock-card-title' }, t('constituentsTitle')),
            h('p', { className: 'astock-card-note' }, t('constituentsTotal', { count: items.length }))),
          state.status === 'loading' ? Spinner() : null),
        h('div', { className: 'astock-constituents' }, items.map(function (item) {
          var tone = trendTone(item.changePercent);
          return h('div', { className: 'astock-mlist-row', key: String(item.secid || item.code),
            role: 'button', tabIndex: 0,
            onClick: function () { props.onOpen(item); },
            onKeyDown: function (event) {
              if (event.key === 'Enter' || event.key === ' ') props.onOpen(item);
            },
          },
            h('span', { className: 'astock-mlist-name' },
              h('b', null, String(item.name || item.code || '')),
              h('span', null, String(item.code || '') + (item.market ? ' · ' + marketLabel(item.market) : ''))),
            h('span', { className: 'astock-mlist-num', style: { color: toneColor(tone) } },
              fmtPercent(item.changePercent)),
            h('span', { className: 'astock-mlist-num' },
              item.score === null || item.score === undefined
                ? t('dash')
                : h('span', { style: { color: toneColor(scoreTone(item.score)) } },
                  clampScore(item.score).toFixed(0))),
            h('span', { className: 'astock-mlist-num' }, ''));
        })));
    }

    function WatchlistPanel(props) {
      var t = props.t;
      var watch = props.state;
      var activeKey = props.activeKey;
      var onOpen = props.onOpen;
      var onRemove = props.onRemove;

      var codes = Array.isArray(watch.codes) ? watch.codes : [];
      var quotes = watch.quotes !== null && watch.quotes !== undefined ? watch.quotes : {};
      var evals = watch.evals !== null && watch.evals !== undefined ? watch.evals : {};

      var body = null;
      if (codes.length === 0) {
        body = h(EmptyState, { title: t('watchlistEmpty'), text: t('watchlistEmptyHint') });
      } else {
        body = h('ul', { className: 'astock-watch-list' }, codes.map(function (raw, index) {
          var key = bareCode(raw);
          var evaluation = evals[key] !== undefined ? evals[key] : null;
          var quote = quotes[key] !== undefined ? quotes[key] : null;
          var name = evaluation !== null && typeof evaluation.name === 'string' && evaluation.name.length > 0
            ? evaluation.name
            : (quote !== null && typeof quote.name === 'string' && quote.name.length > 0 ? quote.name : t('watchlistUntitled'));
          var changePercent = evaluation !== null && asNumber(evaluation.changePercent) !== null
            ? evaluation.changePercent
            : (quote !== null ? quote.changePercent : null);
          var score = evaluation !== null ? clampScore(evaluation.score) : null;
          var tone = trendTone(changePercent);
          var isActive = activeKey === key;
          return h('li', {
            key: 'watch-' + key + '-' + String(index),
            className: 'astock-watch-row',
            'data-active': isActive ? 'true' : 'false',
          },
            h('button', {
              type: 'button',
              className: 'astock-watch-open',
              onClick: function () {
                onOpen(raw);
              },
              title: name + ' ' + String(raw),
            },
              h('span', { className: 'astock-watch-name' }, name),
              h('span', { className: 'astock-watch-code' }, key),
              h('span', { className: 'astock-watch-change', style: { color: toneColor(tone) } },
                fmtPercent(changePercent)),
              h('span', {
                className: 'astock-watch-score',
                style: { color: score === null ? 'var(--astock-text-3)' : toneColor(scoreTone(score)) },
              }, score === null ? '—' : score.toFixed(0))),
            h('button', {
              type: 'button',
              className: 'astock-watch-remove',
              title: t('watchlistRemove', { name: name }),
              'aria-label': t('watchlistRemove', { name: name }),
              onClick: function (event) {
                event.stopPropagation();
                onRemove(raw, name);
              },
            }, '×'));
        }));
      }

      return h('section', { className: 'astock-watch' },
        h('div', { className: 'astock-watch-head' },
          h('h3', { className: 'astock-watch-title' }, t('watchlist')),
          watch.busy === true ? Spinner() : null),
        watch.error !== null && watch.error !== undefined
          ? h('p', { className: 'astock-card-note', style: { color: 'var(--astock-danger)' } },
            t('watchlistFailed', { error: String(watch.error) }))
          : null,
        body);
    }

    /* ------------------------------------------------------------------ *
     * 主页面
     * ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ *
     * 股票列表（多市场）
     * ------------------------------------------------------------------ */

    /** 一行标的。 */
    function MarketRow(props) {
      var t = props.t;
      var item = props.item;
      var tone = trendTone(item.changePercent);
      var inWatch = props.inWatchlist === true;
      var score = item.score === null || item.score === undefined ? null : clampScore(item.score);
      return h('div', { className: 'astock-mlist-row', role: 'button', tabIndex: 0,
        onClick: function () { props.onOpen(item); },
        onKeyDown: function (event) {
          if (event.key === 'Enter' || event.key === ' ') props.onOpen(item);
        },
      },
        h('span', { className: 'astock-mlist-name' },
          h('b', null, String(item.name || item.code || '')),
          h('span', null,
            [String(item.code || ''), marketLabel(item.market) + (item.currency ? '·' + item.currency : '')]
              .filter(function (part) { return part.length > 0; }).join(' · '))),
        h('span', { className: 'astock-mlist-num', style: { color: toneColor(tone) } }, fmtPercent(item.changePercent)),
        h('span', { className: 'astock-mlist-num' },
          score === null
            ? t('dash')
            : h('span', { style: { color: toneColor(scoreTone(score)) } }, score.toFixed(0))),
        h('button', {
          type: 'button',
          className: 'astock-mlist-add',
          'data-in': inWatch ? 'true' : 'false',
          title: inWatch ? t('watchlistRemoveTitle') : t('watchlistAddTitle'),
          'aria-label': inWatch ? t('watchlistRemoveTitle') : t('watchlistAddTitle'),
          onClick: function (event) {
            event.stopPropagation();
            props.onToggleWatch(item, inWatch);
          },
        }, inWatch ? '✓' : '＋'));
    }

    /** 全市场列表：市场切换 + 搜索 + 排序 + 分页 + 快捷加自选。 */
    function MarketList(props) {
      var t = props.t;
      var state = props.state;
      var markets = [
        { key: 'cn', label: t('marketCn') },
        { key: 'hk', label: t('marketHk') },
        { key: 'us', label: t('marketUs') },
      ];
      var sorts = [
        { key: 'changePercent', label: t('listSortChange') },
        { key: 'amount', label: t('listSortAmount') },
        { key: 'totalCap', label: t('listSortCap') },
        { key: 'code', label: t('listSortCode') },
      ];
      var items = Array.isArray(state.items) ? state.items : [];
      var total = asNumber(state.total) ?? 0;
      var offset = asNumber(state.offset) ?? 0;
      var limit = asNumber(state.limit) ?? 100;
      var from = total === 0 ? 0 : offset + 1;
      var to = Math.min(offset + items.length, total);
      var meta = state.meta !== null && state.meta !== undefined ? state.meta : null;
      var canPrev = offset > 0;
      var canNext = offset + limit < total;

      return h('div', { className: 'astock-card' },
        h('div', { className: 'astock-sector-toolbar' },
          h('div', { className: 'astock-seg' }, markets.map(function (market) {
            return h('button', {
              key: market.key,
              type: 'button',
              'data-active': state.market === market.key ? 'true' : 'false',
              onClick: function () { props.onMarket(market.key); },
            }, market.label);
          })),
          h('div', { className: 'astock-seg' }, sorts.map(function (sort) {
            return h('button', {
              key: sort.key,
              type: 'button',
              'data-active': state.sortBy === sort.key ? 'true' : 'false',
              onClick: function () { props.onSort(sort.key); },
            }, sort.label);
          })),
          state.status === 'loading' ? Spinner() : null,
          h('span', { className: 'astock-card-note', 'aria-live': 'polite' },
            total > 0 ? t('listTotal', { count: total }) : '')),
        h('div', { className: 'astock-list-search' },
          h('input', {
            type: 'search',
            className: 'astock-list-search-input',
            placeholder: t('listSearchPlaceholder'),
            value: state.keyword || '',
            onChange: function (event) { props.onKeyword(event.target.value); },
            'aria-label': t('listSearchPlaceholder'),
          })),
        meta !== null && meta.complete !== true && typeof meta.note === 'string' && meta.note.length > 0
          ? h('p', { className: 'astock-card-note', style: { color: 'var(--astock-warn, #b8860b)' } },
            t('listIncomplete', { note: meta.note }))
          : null,
        state.status === 'error'
          ? h('p', { className: 'astock-card-note', style: { color: 'var(--astock-danger)' } },
            t('listFailed', { error: String(state.error || '') }))
          : null,
        state.status === 'loading' && items.length === 0
          ? h('p', { className: 'astock-card-note' }, t('listLoading'))
          : null,
        state.status !== 'loading' && items.length === 0 && state.status !== 'error'
          ? h(EmptyState, { title: t('listEmpty') })
          : null,
        items.length > 0
          ? h('div', { className: 'astock-mlist' }, items.map(function (item) {
            return h(MarketRow, {
              key: String(item.secid || item.code),
              t: t,
              item: item,
              inWatchlist: props.isWatched(item),
              onOpen: props.onOpen,
              onToggleWatch: props.onToggleWatch,
            });
          }))
          : null,
        total > limit
          ? h('div', { className: 'astock-list-pager' },
            h('span', { className: 'astock-card-note' }, t('listShowing', { from: from, to: to })),
            uiButton({
              variant: 'outline', size: 'sm', disabled: !canPrev,
              onClick: function () { props.onPage(Math.max(0, offset - limit)); },
            }, t('listPrev')),
            uiButton({
              variant: 'outline', size: 'sm', disabled: !canNext,
              onClick: function () { props.onPage(offset + limit); },
            }, t('listNext')))
          : null);
    }

    /* ------------------------------------------------------------------ *
     * 板块（Sector）
     * ------------------------------------------------------------------ */

    /** 板块列表的一行。 */
    function SectorRow(props) {
      var t = props.t;
      var item = props.item;
      var tone = trendTone(item.changePercent);
      var score = clampScore(item.score);
      var up = item.breadth !== null && item.breadth !== undefined ? item.breadth.up : null;
      var down = item.breadth !== null && item.breadth !== undefined ? item.breadth.down : null;
      var capital = item.capital !== null && item.capital !== undefined ? item.capital.net : null;
      var leader = item.leader;
      var subtitle = leader !== null && leader !== undefined && typeof leader.name === 'string'
        ? t('sectorLeader', { name: leader.name, change: fmtPercent(leader.changePercent) })
        : (up !== null && down !== null ? up + '/' + down : t('dash'));
      return h('button', {
        type: 'button',
        className: 'astock-sector-row',
        'data-active': props.active === true ? 'true' : 'false',
        onClick: function () {
          props.onPick(item);
        },
      },
        h('span', { className: 'astock-sector-name' },
          h('b', null, String(item.name || item.code || '')),
          h('span', null, subtitle)),
        h('span', { className: 'astock-sector-num', style: { color: toneColor(tone) } },
          fmtPercent(item.changePercent)),
        h('span', { className: 'astock-sector-num astock-sector-hide-sm' },
          up !== null && down !== null ? up + '/' + down : t('dash')),
        h('span', { className: 'astock-sector-score astock-sector-hide-sm' },
          h('span', { className: 'astock-sector-bar' }, h('i', {
            style: { width: (score === null ? 0 : score) + '%', background: toneColor(scoreTone(score)) },
          })),
          h('span', { className: 'astock-sector-num', style: { minWidth: '34px' } },
            score === null ? t('dash') : score.toFixed(0))),
        h('span', { className: 'astock-sector-num' },
          capital === null || !Number.isFinite(capital)
            ? t('dash')
            : t('capitalUnitYi', { value: (capital / 10000).toFixed(2) })));
    }

    /** 板块列表：类型切换 + 排序 + 分页。 */
    function SectorList(props) {
      var t = props.t;
      var state = props.state;
      var boards = [
        { key: 'hy', label: t('boardHy') },
        { key: 'hy2', label: t('boardHy2') },
        { key: 'gn', label: t('boardGn') },
      ];
      var sorts = [
        { key: 'score', label: t('sectorSortScore') },
        { key: 'changePercent', label: t('sectorSortChange') },
      ];
      return h('div', { className: 'astock-card' },
        h('div', { className: 'astock-sector-toolbar' },
          h('div', { className: 'astock-seg' }, boards.map(function (board) {
            return h('button', {
              key: board.key,
              type: 'button',
              'data-active': state.boardType === board.key ? 'true' : 'false',
              onClick: function () {
                props.onBoard(board.key);
              },
            }, board.label);
          })),
          h('div', { className: 'astock-seg' }, sorts.map(function (sort) {
            return h('button', {
              key: sort.key,
              type: 'button',
              'data-active': state.sortBy === sort.key ? 'true' : 'false',
              onClick: function () {
                props.onSort(sort.key);
              },
            }, sort.label);
          })),
          state.status === 'loading' ? Spinner() : null,
          h('span', { className: 'astock-card-note', 'aria-live': 'polite' },
            state.total > 0 ? t('sectorTotal', { count: state.total }) : '')),
        state.status === 'error'
          ? h('p', { className: 'astock-card-note', style: { color: 'var(--astock-danger)' } },
            t('sectorFailed', { error: String(state.error || '') }))
          : null,
        state.status === 'loading' && state.items.length === 0
          ? h('p', { className: 'astock-card-note' }, t('sectorLoading'))
          : null,
        state.status !== 'loading' && state.items.length === 0 && state.status !== 'error'
          ? h(EmptyState, { title: t('sectorEmpty') })
          : null,
        state.items.length > 0
          ? h('div', { className: 'astock-sector-list' },
            h('div', { className: 'astock-sector-head' },
              h('span', null, t('sectorColName')),
              h('span', null, t('sectorColChange')),
              h('span', { className: 'astock-sector-hide-sm' }, t('sectorColBreadth')),
              h('span', { className: 'astock-sector-hide-sm' }, t('sectorColScore')),
              h('span', null, t('sectorColCapital'))),
            state.items.map(function (item) {
              return h(SectorRow, {
                key: String(item.code || item.name),
                t: t,
                item: item,
                active: props.activeCode === item.code,
                onPick: props.onPick,
              });
            }))
          : null);
    }

    /** 单个板块详情。 */
    function SectorDetail(props) {
      var t = props.t;
      var item = props.item;
      var tone = trendTone(item.changePercent);
      var score = clampScore(item.score);
      function fact(label, value, color) {
        return h('div', { className: 'astock-fact' },
          h('span', { className: 'astock-fact-label' }, label),
          h('span', { className: 'astock-fact-value', style: color ? { color: color } : undefined }, value));
      }
      function money(value) {
        if (value === null || value === undefined || !Number.isFinite(value)) return t('dash');
        var yi = value / 10000;
        return t('capitalUnitYi', { value: (yi >= 0 ? '+' : '') + yi.toFixed(2) });
      }
      return h('div', { className: 'astock-card' },
        h('div', { className: 'astock-card-head' },
          h('div', null,
            h('h3', { className: 'astock-card-title' }, String(item.name || item.code || '')),
            h('p', { className: 'astock-card-note' }, t('sectorDetail'))),
          h('div', { className: 'astock-score-block' },
            h('span', { className: 'astock-score-value', style: { color: toneColor(scoreTone(score)) } },
              score === null ? t('dash') : score.toFixed(0)),
            h('span', { className: 'astock-score-unit' }, '/ 100'),
            h('span', { className: 'astock-verdict' }, String(item.verdictLabel || '')))),
        h('div', { className: 'astock-price-row' },
          h('span', { className: 'astock-price-value', style: { color: toneColor(tone) } },
            fmtFixed(item.price, 2)),
          h('span', { className: 'astock-price-change', style: { color: toneColor(tone) } },
            fmtPercent(item.changePercent))),
        h('div', { className: 'astock-facts' },
          fact(t('change5dShort'), fmtPercent(item.change5d), toneColor(trendTone(item.change5d))),
          fact(t('change20dShort'), fmtPercent(item.change20d), toneColor(trendTone(item.change20d))),
          fact(t('sectorColBreadth'),
            (item.breadth && item.breadth.up !== null && item.breadth.down !== null)
              ? item.breadth.up + ' / ' + item.breadth.down
              : t('dash')),
          fact(t('capitalNet'), money(item.capital && item.capital.net),
            (item.capital && Number.isFinite(item.capital.net)) ? toneColor(trendTone(item.capital.net)) : undefined),
          fact(t('capital5d'), money(item.capital && item.capital.net5d)),
          fact(t('capital20d'), money(item.capital && item.capital.net20d))),
        item.summary
          ? h('p', { className: 'astock-summary' }, String(item.summary))
          : null,
        Array.isArray(item.factors) && item.factors.length > 0
          ? h(FactorBars, { t: t, factors: item.factors, expanded: {}, onToggle: function () {} })
          : null,
        Array.isArray(item.risks) && item.risks.length > 0
          ? h(RisksCard, { t: t, risks: item.risks })
          : null,
        h('p', { className: 'astock-card-note' }, t('sectorNoKline')),
        item.disclaimer
          ? h(DisclaimerNote, { t: t, text: String(item.disclaimer) })
          : null);
    }

    function AstockPage(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT;
      var rpc = props.rpc;
      var call = React.useMemo(function () {
        return makeCaller(rpc, t);
      }, [rpc, t]);

      /* --- 状态 --- */
      var indicesState = React.useState({ status: 'idle', items: [], error: null, updatedAt: 0 });
      var indices = indicesState[0];
      var setIndices = indicesState[1];

      var viewState = React.useState(MEMO.view !== null
        ? MEMO.view
        : { status: 'idle', data: null, detail: null, error: null });
      var view = viewState[0];
      var setView = viewState[1];

      /* 当前评估标的（跨重渲染稳定，MEMO 只负责跨挂载恢复）。 */
      var targetState = React.useState({ code: MEMO.code, label: MEMO.label });
      var target = targetState[0];
      var setTarget = targetState[1];

      var watchState = React.useState(MEMO.watch !== null
        ? MEMO.watch
        : { status: 'idle', codes: [], quotes: {}, evals: {}, busy: false, error: null });
      var watch = watchState[0];
      var setWatch = watchState[1];

      var searchState = React.useState({ keyword: '', status: 'idle', results: [], error: null, queried: false });
      var search = searchState[0];
      var setSearch = searchState[1];

      var openState = React.useState(false);
      var suggestOpen = openState[0];
      var setSuggestOpen = openState[1];

      var expandedState = React.useState({});
      var expandedFactors = expandedState[0];
      var setExpandedFactors = expandedState[1];

      var detailState = React.useState(false);
      var detailOpen = detailState[0];
      var setDetailOpen = detailState[1];

      /* 涨跌依据卡片的展开状态（详情页专用） */
      var basisState = React.useState(false);
      var basisOpen = basisState[0];
      var setBasisOpen = basisState[1];

      /* 公司资料 / 公告 / 一键分析 */
      var detailInfoState = React.useState({ status: 'idle', profile: null, announcements: [], error: null, code: '' });
      var detailInfo = detailInfoState[0];
      var setDetailInfo = detailInfoState[1];

      var companyOpenState = React.useState(false);
      var companyOpen = companyOpenState[0];
      var setCompanyOpen = companyOpenState[1];

      var detailToken = React.useRef(0);

      var toastState = React.useState(null);
      var toast = toastState[0];
      var setToast = toastState[1];

      /* --- 视图切换：个股 / 板块 --- */
      var tabState = React.useState(MEMO.tab === 'sector' ? 'sector' : 'stock');
      var tab = tabState[0];
      var setTab = tabState[1];

      var sectorState = React.useState(MEMO.sector !== null && MEMO.sector !== undefined
        ? MEMO.sector
        : { boardType: 'hy', sortBy: 'score', status: 'idle', items: [], total: 0, error: null });
      var sector = sectorState[0];
      var setSector = sectorState[1];

      var sectorPickState = React.useState(null);
      var sectorPick = sectorPickState[0];
      var setSectorPick = sectorPickState[1];

      var marketListState = React.useState(MEMO.marketList !== null && MEMO.marketList !== undefined
        ? MEMO.marketList
        : { market: 'cn', sortBy: 'changePercent', keyword: '', offset: 0, limit: 100, total: 0, meta: null, status: 'idle', items: [], error: null });
      var marketList = marketListState[0];
      var setMarketList = marketListState[1];

      var listToken = React.useRef(0);

      React.useEffect(function () {
        MEMO.marketList = marketList;
      }, [marketList]);

      var sectorToken = React.useRef(0);

      /* 板块成分股 */
      var constituentsState = React.useState({ status: 'idle', items: [], error: null, boardName: '' });
      var constituents = constituentsState[0];
      var setConstituents = constituentsState[1];
      var constituentsToken = React.useRef(0);

      var loadConstituents = React.useCallback(function (boardName) {
        var name = typeof boardName === 'string' ? boardName.trim() : '';
        if (name.length === 0) return Promise.resolve();
        var token = ++constituentsToken.current;
        setConstituents({ status: 'loading', items: [], error: null, boardName: name });
        return call('sectors/constituents', { name: name, withScore: true }).then(function (value) {
          if (token !== constituentsToken.current) return;
          setConstituents({
            status: 'ready',
            items: value && Array.isArray(value.items) ? value.items : [],
            error: null,
            boardName: name,
          });
        }).catch(function (error) {
          if (token !== constituentsToken.current) return;
          setConstituents({ status: 'error', items: [], error: errorMessage(error, t), boardName: name });
        });
      }, [call, t]);

      React.useEffect(function () {
        MEMO.tab = tab;
      }, [tab]);
      React.useEffect(function () {
        MEMO.sector = sector;
      }, [sector]);

      /* --- refs：竞态与最新值 --- */
      var evalToken = React.useRef(0);
      var watchToken = React.useRef(0);
      var searchToken = React.useRef(0);
      var searchTimer = React.useRef(null);
      var toastTimer = React.useRef(null);
      var watchRef = React.useRef(watch);
      var keywordRef = React.useRef('');

      /* 在提交阶段同步 ref，避免渲染期写 ref 带来的并发渲染问题。 */
      React.useEffect(function () {
        watchRef.current = watch;
      }, [watch]);
      React.useEffect(function () {
        keywordRef.current = search.keyword;
      }, [search.keyword]);

      function showToast(text) {
        setToast({ id: String(Date.now()), text: text });
      }

      React.useEffect(function () {
        if (toast === null) return undefined;
        var timer = window.setTimeout(function () {
          setToast(null);
        }, TOAST_MS);
        toastTimer.current = timer;
        return function () {
          window.clearTimeout(timer);
        };
      }, [toast]);

      /* --- 指数 --- */
      var loadIndices = React.useCallback(function () {
        setIndices(function (current) {
          return Object.assign({}, current, { status: current.items.length > 0 ? current.status : 'loading', error: null });
        });
        return call('indices', {}).then(function (value) {
          var items = value !== null && value !== undefined && Array.isArray(value.items) ? value.items : [];
          setIndices({ status: 'ready', items: items, error: null, updatedAt: Date.now() });
        }).catch(function (error) {
          setIndices(function (current) {
            return { status: 'error', items: current.items, error: errorMessage(error, t), updatedAt: Date.now() };
          });
        });
      }, [call, t]);

      /* --- 板块 --- */
      var loadSectors = React.useCallback(function (boardType, sortBy) {
        var token = ++sectorToken.current;
        setSector(function (current) {
          return {
            boardType: boardType,
            sortBy: sortBy,
            status: current.items.length > 0 ? current.status : 'loading',
            items: current.items,
            total: current.total,
            error: null,
          };
        });
        return call('sectors', { boardType: boardType, sortBy: sortBy, order: 'desc', limit: 0 })
          .then(function (value) {
            if (token !== sectorToken.current) return;
            var items = value !== null && value !== undefined && Array.isArray(value.items) ? value.items : [];
            var total = value !== null && value !== undefined && typeof value.total === 'number' ? value.total : items.length;
            setSector({ boardType: boardType, sortBy: sortBy, status: 'ready', items: items, total: total, error: null });
          })
          .catch(function (error) {
            if (token !== sectorToken.current) return;
            setSector(function (current) {
              return {
                boardType: current.boardType,
                sortBy: current.sortBy,
                status: 'error',
                items: current.items,
                total: current.total,
                error: errorMessage(error, t),
              };
            });
          });
      }, [call, t]);

      /* 首次切到板块 tab 时才拉取，避免打开面板就多打一次上游请求。 */
      React.useEffect(function () {
        if (tab !== 'sector') return;
        if (sector.status !== 'idle') return;
        loadSectors(sector.boardType, sector.sortBy);
      }, [tab, sector.status, sector.boardType, sector.sortBy, loadSectors]);

      /* --- 公司资料与公告（进入详情页时自动拉取） --- */
      var loadDetailInfo = React.useCallback(function (code) {
        if (typeof code !== 'string' || code.length === 0) return Promise.resolve();
        var token = ++detailToken.current;
        setDetailInfo(function (current) {
          return { status: current.code === code ? current.status : 'loading', profile: current.code === code ? current.profile : null,
            announcements: current.code === code ? current.announcements : [], error: null, code: code };
        });
        return call('detail', { code: code }).then(function (value) {
          if (token !== detailToken.current) return;
          setDetailInfo({
            status: 'ready',
            profile: value && value.profile ? value.profile : null,
            announcements: value && Array.isArray(value.announcements) ? value.announcements : [],
            error: null,
            code: code,
          });
        }).catch(function (error) {
          if (token !== detailToken.current) return;
          setDetailInfo({ status: 'error', profile: null, announcements: [], error: errorMessage(error, t), code: code });
        });
      }, [call, t]);

      /* 一键分析：一次拿齐技术面 + 公司资料 + 公告 */
      var runAnalyze = React.useCallback(function (code) {
        if (typeof code !== 'string' || code.length === 0) return Promise.resolve();
        var token = ++detailToken.current;
        setDetailInfo({ status: 'loading', profile: null, announcements: [], error: null, code: code });
        return call('analyze', { code: code }).then(function (value) {
          if (token !== detailToken.current) return;
          var evaluation = value && value.evaluation ? value.evaluation : null;
          if (evaluation !== null) {
            setView({ status: 'ready', data: evaluation, detail: value && value.quote ? value.quote : null, error: null });
          }
          setDetailInfo({
            status: 'ready',
            profile: value && value.profile ? value.profile : null,
            announcements: value && Array.isArray(value.announcements) ? value.announcements : [],
            error: null,
            code: code,
          });
          showToast(t('analyzeDone'));
        }).catch(function (error) {
          if (token !== detailToken.current) return;
          setDetailInfo({ status: 'error', profile: null, announcements: [], error: errorMessage(error, t), code: code });
          showToast(t('analyzeFailed', { error: errorMessage(error, t) }));
        });
      }, [call, t]);

      /* --- 全市场列表 --- */
      var loadStockList = React.useCallback(function (patch) {
        var token = ++listToken.current;
        var next = Object.assign({}, marketList, patch || {});
        setMarketList(function (current) {
          return Object.assign({}, current, patch || {}, {
            status: current.items.length > 0 ? current.status : 'loading',
            error: null,
          });
        });
        return call('stocks', {
          market: next.market,
          sortBy: next.sortBy,
          order: 'desc',
          keyword: next.keyword,
          offset: next.offset,
          limit: next.limit,
        }).then(function (value) {
          if (token !== listToken.current) return;
          setMarketList({
            market: next.market,
            sortBy: next.sortBy,
            keyword: next.keyword,
            offset: next.offset,
            limit: next.limit,
            total: asNumber(value && value.total) ?? 0,
            meta: value && value.meta ? value.meta : null,
            status: 'ready',
            items: value && Array.isArray(value.items) ? value.items : [],
            error: null,
          });
        }).catch(function (error) {
          if (token !== listToken.current) return;
          setMarketList(function (current) {
            return Object.assign({}, current, { status: 'error', error: errorMessage(error, t) });
          });
        });
      }, [call, t, marketList]);

      React.useEffect(function () {
        if (tab !== 'list') return;
        if (marketList.status !== 'idle') return;
        loadStockList({});
      }, [tab, marketList.status, loadStockList]);

      /* --- 自选股 --- */
      var applyWatch = React.useCallback(function (codes, options) {
        var opts = options || {};
        var list = Array.isArray(codes) ? codes.slice() : [];
        var token = ++watchToken.current;
        var patch = {
          codes: list,
          busy: list.length > 0,
          error: null,
          status: list.length > 0 ? 'loading' : 'ready',
        };
        if (opts.keepData !== true) {
          patch.quotes = {};
          patch.evals = {};
        }
        setWatch(function (current) {
          return Object.assign({}, current, patch);
        });
        if (list.length === 0) return Promise.resolve();

        var quoteTask = call('quote', { codes: list }).then(function (value) {
          if (token !== watchToken.current) return;
          var quotes = value !== null && value !== undefined && Array.isArray(value.quotes) ? value.quotes : [];
          var map = {};
          quotes.forEach(function (quote) {
            if (quote !== null && quote !== undefined && quote.secid !== undefined) {
              map[bareCode(quote.secid)] = quote;
            }
          });
          setWatch(function (current) {
            return Object.assign({}, current, { quotes: map });
          });
        }).catch(function () {
          /* 行情明细失败不阻塞评分 */
        });

        var evalTask = call('batch', { codes: list }).then(function (value) {
          if (token !== watchToken.current) return;
          var items = value !== null && value !== undefined && Array.isArray(value.items) ? value.items : [];
          var map = {};
          items.forEach(function (item) {
            if (item !== null && item !== undefined && item.code !== undefined) {
              map[bareCode(item.code)] = item;
            }
          });
          var errors = value !== null && value !== undefined && Array.isArray(value.errors) ? value.errors : [];
          setWatch(function (current) {
            var partial = errors.length > 0 && items.length === 0
              ? errors.map(function (entry) {
                return String(entry.code) + ': ' + String(entry.message);
              }).join('；')
              : null;
            return Object.assign({}, current, {
              evals: map,
              status: 'ready',
              busy: false,
              error: partial,
            });
          });
        }).catch(function (error) {
          if (token !== watchToken.current) return;
          setWatch(function (current) {
            return Object.assign({}, current, {
              status: 'error',
              busy: false,
              error: errorMessage(error, t),
            });
          });
        });

        return Promise.all([quoteTask, evalTask]);
      }, [call, t]);

      var loadWatchlist = React.useCallback(function () {
        return call('watchlist', {}).then(function (value) {
          var codes = value !== null && value !== undefined && Array.isArray(value.codes) ? value.codes : [];
          return applyWatch(codes);
        }).catch(function (error) {
          setWatch(function (current) {
            return Object.assign({}, current, {
              status: 'error',
              busy: false,
              error: errorMessage(error, t),
            });
          });
        });
      }, [applyWatch, call, t]);

      var writeWatchlist = React.useCallback(function (nextCodes, feedback) {
        var previous = watchRef.current.codes;
        setWatch(function (current) {
          return Object.assign({}, current, { codes: nextCodes, busy: true, error: null });
        });
        return call('watchlist/set', { codes: nextCodes }).then(function (value) {
          var saved = value !== null && value !== undefined && Array.isArray(value.codes) ? value.codes : nextCodes;
          if (feedback !== null && feedback !== undefined && typeof feedback === 'function') feedback(saved);
          return applyWatch(saved, { keepData: false });
        }).catch(function (error) {
          setWatch(function (current) {
            return Object.assign({}, current, { codes: previous, busy: false });
          });
          MEMO.watchCodes = previous;
          showToast(t('toastWatchFailed', { error: errorMessage(error, t) }));
        });
      }, [applyWatch, call, t]);

      /* --- 评估 --- */
      var runEvaluate = React.useCallback(function (rawCode, label) {
        var code = String(rawCode === null || rawCode === undefined ? '' : rawCode).trim();
        if (code.length === 0) return Promise.resolve();
        var token = ++evalToken.current;
        MEMO.code = code;
        MEMO.label = typeof label === 'string' ? label : '';
        setTarget({ code: code, label: MEMO.label });
        /* 重新评估时保留上一份结果作为骨架，避免整块闪烁。 */
        setView(function (current) {
          return {
            status: 'loading',
            data: current.data,
            detail: current.detail,
            error: null,
          };
        });
        storeLastCode(code);
        SESSION.set({ lastCode: code });

        // 公司资料与公告独立加载：失败不影响技术面评分
        loadDetailInfo(code);

        var evalTask = call('evaluate', { code: code }).then(function (value) {
          if (token !== evalToken.current) return null;
          var evaluation = value !== null && value !== undefined ? value : null;
          setExpandedFactors({});
          setView(function (current) {
            return { status: 'ready', data: evaluation, detail: current.detail, error: null };
          });
          return evaluation;
        }).catch(function (error) {
          if (token !== evalToken.current) return null;
          setView(function (current) {
            return { status: 'error', data: current.data, detail: current.detail, error: errorMessage(error, t) };
          });
          return null;
        });

        var quoteTask = call('quote', { codes: [code] }).then(function (value) {
          if (token !== evalToken.current) return;
          var quotes = value !== null && value !== undefined && Array.isArray(value.quotes) ? value.quotes : [];
          var first = quotes.length > 0 ? quotes[0] : null;
          setView(function (current) {
            return Object.assign({}, current, { detail: first !== null && first !== undefined ? first : null });
          });
        }).catch(function () {
          /* 行情明细是可选的，失败静默 */
        });

        return Promise.all([evalTask, quoteTask]);
      }, [call, t]);

      /* --- 搜索（防抖） --- */
      var runSearch = React.useCallback(function (keyword) {
        var text = String(keyword || '').trim();
        if (text.length === 0) {
          searchToken.current += 1;
          setSearch({ keyword: keyword, status: 'idle', results: [], error: null, queried: false });
          return;
        }
        var token = ++searchToken.current;
        setSearch(function (current) {
          return Object.assign({}, current, { keyword: keyword, status: 'loading', error: null });
        });
        call('search', { keyword: text }).then(function (value) {
          if (token !== searchToken.current) return;
          var results = value !== null && value !== undefined && Array.isArray(value.results) ? value.results : [];
          setSearch(function (current) {
            return Object.assign({}, current, {
              keyword: keyword,
              status: 'ready',
              results: results,
              error: null,
              queried: true,
            });
          });
        }).catch(function (error) {
          if (token !== searchToken.current) return;
          setSearch(function (current) {
            return Object.assign({}, current, {
              keyword: keyword,
              status: 'error',
              results: [],
              error: errorMessage(error, t),
              queried: true,
            });
          });
        });
      }, [call, t]);

      function onKeywordChange(value) {
        setSuggestOpen(true);
        setSearch(function (current) {
          return Object.assign({}, current, { keyword: value });
        });
        if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
        searchTimer.current = window.setTimeout(function () {
          runSearch(value);
        }, SEARCH_DEBOUNCE_MS);
      }

      function onSubmitKeyword() {
        var text = keywordRef.current.trim();
        if (text.length === 0) return;
        if (searchTimer.current !== null) {
          window.clearTimeout(searchTimer.current);
          searchTimer.current = null;
        }
        /* 回车优先理解成「精确代码」，命中说明能直接评估，不必等候选。 */
        if (looksLikeCode(text)) {
          pickSymbol({ secid: text, code: bareCode(text), name: '' });
          return;
        }
        var results = Array.isArray(search.results) ? search.results : [];
        if (results.length === 1) {
          pickSymbol(results[0]);
          return;
        }
        if (results.length > 1) {
          setSuggestOpen(true);
          return;
        }
        runSearch(text);
        setSuggestOpen(true);
      }

      function pickSymbol(item) {
        if (item === null || item === undefined) return;
        var secid = typeof item.secid === 'string' && item.secid.length > 0 ? item.secid : String(item.code || '');
        setSuggestOpen(false);
        setSearch({ keyword: '', status: 'idle', results: [], error: null, queried: false });
        if (searchTimer.current !== null) {
          window.clearTimeout(searchTimer.current);
          searchTimer.current = null;
        }
        runEvaluate(secid, typeof item.name === 'string' ? item.name : '');
      }

      /* --- 把最近结果写进模块级记忆，切换面板回来不丢 --- */
      React.useEffect(function () {
        if (view.status === 'ready' || view.status === 'error') {
          MEMO.view = view;
          MEMO.fetchedAt = Date.now();
        }
      }, [view]);

      React.useEffect(function () {
        if (watch.status !== 'idle') MEMO.watch = watch;
      }, [watch]);

      /* --- 首次挂载 --- */
      React.useEffect(function () {
        loadIndices();
        var restored = MEMO.code;
        var cached = MEMO.view;
        var hasCache = cached !== null && cached !== undefined && cached.status === 'ready';
        if (hasCache && watch.status !== 'idle') {
          /* 已有缓存：不重置界面，仅按需静默刷新 */
          if (Date.now() - MEMO.fetchedAt > MEMO_FRESH_MS && restored.length > 0) {
            runEvaluate(restored, MEMO.label);
          }
          loadWatchlist();
        } else {
          loadWatchlist();
          var initialCode = restored.length > 0 ? restored : SESSION.getSnapshot().lastCode;
          if (typeof initialCode === 'string' && initialCode.length > 0) runEvaluate(initialCode, MEMO.label);
        }
        return function () {
          if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
        };
      }, []);

      /* --- 交互 --- */
      function onRefresh() {
        loadIndices();
        if (watchRef.current.codes.length > 0) {
          applyWatch(watchRef.current.codes, { keepData: true });
        }
        if (target.code.length > 0) {
          runEvaluate(target.code, target.label);
        }
      }

      function currentKey() {
        if (view.data !== null && view.data !== undefined) {
          if (view.data.secid !== undefined) return bareCode(view.data.secid);
          if (view.data.code !== undefined) return bareCode(view.data.code);
        }
        if (target.code.length > 0) return bareCode(target.code);
        return '';
      }

      function toggleFactor(key) {
        setExpandedFactors(function (current) {
          var next = Object.assign({}, current);
          if (next[key] === true) delete next[key];
          else next[key] = true;
          return next;
        });
      }

      function addCurrentToWatchlist() {
        var data = view.data;
        if (data === null || data === undefined) return;
        var raw = typeof data.secid === 'string' && data.secid.length > 0
          ? data.secid
          : String(data.code || target.code);
        if (raw.length === 0) return;
        var currentCodes = watchRef.current.codes;
        var key = bareCode(raw);
        var exists = currentCodes.some(function (item) {
          return bareCode(item) === key;
        });
        var name = typeof data.name === 'string' ? data.name : key;
        if (exists) {
          var kept = currentCodes.filter(function (item) {
            return bareCode(item) !== key;
          });
          writeWatchlist(kept, function () {
            showToast(t('toastRemoved', { name: name }));
          });
          return;
        }
        var next = currentCodes.concat([raw]);
        writeWatchlist(next, function () {
          showToast(t('toastAdded', { name: name }));
        });
      }

      function removeFromWatchlist(raw, name) {
        var key = bareCode(raw);
        var next = watchRef.current.codes.filter(function (item) {
          return bareCode(item) !== key;
        });
        writeWatchlist(next, function () {
          showToast(t('toastRemoved', { name: name }));
        });
      }

      /* --- 渲染 --- */
      var evaluation = view.data;
      var ready = view.status === 'ready' && evaluation !== null && evaluation !== undefined;
      var activeKey = currentKey();
      var inWatchlist = activeKey.length > 0 && (Array.isArray(watch.codes) ? watch.codes : []).some(function (item) {
        return bareCode(item) === activeKey;
      });

      /* v3.1 反馈修复：加自选按钮要显眼。已在自选时用 primary 实心态，
         点击可移除；未加时用 outline 但带 + 号前缀，位置固定在卡片头右上。 */
      var addButton = ready
        ? uiButton({
          variant: inWatchlist ? 'primary' : 'outline',
          size: 'sm',
          onClick: addCurrentToWatchlist,
          title: inWatchlist ? t('watchlistRemoveTitle') : t('watchlistAddTitle'),
        }, (inWatchlist ? '✓ ' : '+ ') + (inWatchlist ? t('watchlistAdded') : t('addToWatchlist')))
        : null;

      var resultArea = null;
      if (view.status === 'error' && (evaluation === null || evaluation === undefined)) {
        resultArea = h(ErrorState, {
          message: t('evalFailed', { error: view.error || t('unknown') }),
          onRetry: target.code.length > 0
            ? function () {
              runEvaluate(target.code, target.label);
            }
            : null,
          retryLabel: t('retry'),
        });
      } else if (view.status === 'loading' && (evaluation === null || evaluation === undefined)) {
        resultArea = h(LoadingState, {
          title: t('loadingEval', { name: target.label.length > 0 ? target.label : (target.code.length > 0 ? target.code : t('unknown')) }),
          hint: t('loadingEvalHint'),
        });
      } else if (!ready) {
        resultArea = h(EmptyState, { title: t('emptyTitle'), text: t('emptyHint') });
      } else {
        resultArea = h(React.Fragment, null,
          view.status === 'loading'
            ? h(LoadingState, {
              title: t('loadingEval', { name: target.label.length > 0 ? target.label : activeKey }),
              hint: t('loadingEvalHint'),
            })
            : null,
          view.status === 'error'
            ? h(ErrorState, {
              message: t('evalFailed', { error: view.error || t('unknown') }),
              onRetry: function () {
                runEvaluate(target.code, target.label);
              },
              retryLabel: t('retry'),
            })
            : null,
          h(ResultCard, {
            t: t,
            evaluation: evaluation,
            quote: view.detail,
            detailOpen: detailOpen,
            onToggleDetail: function () {
              setDetailOpen(!detailOpen);
            },
            addButton: addButton,
          }),
          h(BasisCard, {
            t: t,
            evaluation: evaluation,
            expanded: basisOpen,
            onToggle: function () {
              setBasisOpen(!basisOpen);
            },
          }),
          detailInfo.status === 'ready' || detailInfo.status === 'loading'
            ? h(CompanyCard, {
              t: t,
              profile: detailInfo.profile,
              open: companyOpen,
              onToggle: function () { setCompanyOpen(!companyOpen); },
            })
            : null,
          detailInfo.status === 'ready'
            ? h(AnnouncementsCard, { t: t, items: detailInfo.announcements })
            : null,
          h(FactorBars, {
            t: t,
            factors: evaluation.factors,
            expanded: expandedFactors,
            onToggle: toggleFactor,
          }),
          h(LevelsCard, { t: t, levels: evaluation.levels }),
          h(RisksCard, { t: t, risks: evaluation.risks }),
          h(DisclaimerNote, { t: t, text: evaluation.disclaimer }));
      }

      /* --- 股票列表视图 --- */
      var watchedKeys = null;
      var buildWatchedKeys = function () {
        if (watchedKeys !== null) return watchedKeys;
        var keys = {};
        var codes = Array.isArray(watch.codes) ? watch.codes : [];
        for (var i = 0; i < codes.length; i += 1) keys[bareCode(codes[i])] = true;
        watchedKeys = keys;
        return keys;
      };
      var isWatched = function (item) {
        var key = bareCode(item.secid || item.code || '');
        return key.length > 0 && buildWatchedKeys()[key] === true;
      };
      var toggleWatchOnItem = React.useCallback(function (item, currentlyIn) {
        var codes = Array.isArray(watch.codes) ? watch.codes.slice() : [];
        var key = bareCode(item.secid || item.code || '');
        if (key.length === 0) return;
        var next;
        if (currentlyIn) {
          next = codes.filter(function (existing) { return bareCode(existing) !== key; });
        } else {
          // 存 secid（含市场前缀），否则港美股在 watchlist 里会丢市场信息
          next = codes.concat([item.secid || item.code]);
        }
        // 必须走 writeWatchlist 才落盘；applyWatch 只改本地状态，重启就丢。
        var label = String(item.name || item.code || '');
        writeWatchlist(next, function () {
          showToast(currentlyIn
            ? t('toastRemoved', { name: label })
            : t('toastAdded', { name: label }));
        });
      }, [watch.codes, writeWatchlist, t]);

      var listView = null;
      if (tab === 'list') {
        listView = h('div', { className: 'astock-body-single' },
          h('div', { className: 'astock-col' },
            h(MarketList, {
              t: t,
              state: marketList,
              isWatched: isWatched,
              onMarket: function (market) {
                loadStockList({ market: market, offset: 0, keyword: '' });
              },
              onSort: function (sortBy) {
                loadStockList({ sortBy: sortBy, offset: 0 });
              },
              onKeyword: function (keyword) {
                loadStockList({ keyword: keyword, offset: 0 });
              },
              onPage: function (offset) {
                loadStockList({ offset: offset });
              },
              onOpen: function (item) {
                setTab('stock');
                runEvaluate(item.secid || item.code, String(item.name || ''));
              },
              onToggleWatch: toggleWatchOnItem,
            })));
      }

      /* --- 板块视图 --- */
      var sectorView = null;
      if (tab === 'sector') {
        sectorView = h('div', { className: 'astock-body-single' },
          sectorPick !== null && sectorPick !== undefined
            ? h('div', { className: 'astock-col' },
              uiButton({
                variant: 'outline',
                size: 'sm',
                onClick: function () {
                  setSectorPick(null);
                },
              }, t('sectorBack')),
              h(SectorDetail, {
                t: t,
                item: sectorPick,
                onOpenStock: function (row) {
                  setTab('stock');
                  setSectorPick(null);
                  runEvaluate(row.secid || row.code, String(row.name || ''));
                },
              }),
              h(ConstituentsList, {
                t: t,
                state: constituents,
                onOpen: function (row) {
                  setTab('stock');
                  setSectorPick(null);
                  runEvaluate(row.secid || row.code, String(row.name || ''));
                },
              }))
            : h('div', { className: 'astock-col' },
              h(SectorList, {
                t: t,
                state: sector,
                activeCode: null,
                onBoard: function (boardType) {
                  setSectorPick(null);
                  loadSectors(boardType, sector.sortBy);
                },
                onSort: function (sortBy) {
                  setSectorPick(null);
                  loadSectors(sector.boardType, sortBy);
                },
                onPick: function (item) {
                  setSectorPick(item);
                  loadConstituents(item && item.name ? String(item.name) : '');
                },
              })));
      }

      return h('div', { className: 'astock-root' },
        h('div', { className: 'astock-header' },
          h('div', { className: 'astock-header-main' },
            h('h2', { className: 'astock-title' }, t('title')),
            h('p', { className: 'astock-subtitle' },
              tab === 'sector' ? t('sectorSubtitle') : t('subtitle'))),
          h('div', { className: 'astock-header-actions' },
            h('span', { className: 'astock-card-note', 'aria-live': 'polite' },
              tab === 'stock' && view.status === 'loading' ? t('refreshing') : ''),
            tab === 'stock'
              ? uiButton({
                variant: 'primary',
                size: 'sm',
                disabled: detailInfo.status === 'loading' || target.code.length === 0,
                onClick: function () { runAnalyze(target.code); },
              }, detailInfo.status === 'loading' ? t('analyzeRunning') : t('analyzeOneClick'))
              : null,
            tab === 'stock'
              ? uiButton({ variant: 'outline', size: 'sm', onClick: onRefresh },
                view.status === 'loading' ? t('refreshing') : t('refresh'))
              : uiButton({
                variant: 'outline',
                size: 'sm',
                onClick: function () {
                  setSectorPick(null);
                  loadSectors(sector.boardType, sector.sortBy);
                },
              }, sector.status === 'loading' ? t('refreshing') : t('refresh')))),
        h('div', { className: 'astock-tabs', role: 'tablist' },
          h('button', {
            type: 'button',
            role: 'tab',
            className: 'astock-tab',
            'data-active': tab === 'stock' ? 'true' : 'false',
            'aria-selected': tab === 'stock' ? 'true' : 'false',
            onClick: function () {
              setTab('stock');
            },
          }, t('tabStock')),
          h('button', {
            type: 'button',
            role: 'tab',
            className: 'astock-tab',
            'data-active': tab === 'sector' ? 'true' : 'false',
            'aria-selected': tab === 'sector' ? 'true' : 'false',
            onClick: function () {
              setTab('sector');
            },
          }, t('tabSector'),
            sector.total > 0
              ? h('span', { className: 'astock-tab-count' }, String(sector.total))
              : null),
          h('button', {
            type: 'button',
            role: 'tab',
            className: 'astock-tab',
            'data-active': tab === 'list' ? 'true' : 'false',
            'aria-selected': tab === 'list' ? 'true' : 'false',
            onClick: function () {
              setTab('list');
            },
          }, t('tabList'))),
        h(IndicesBar, { t: t, state: indices }),
        tab === 'sector' ? sectorView : null,
        tab === 'list' ? listView : null,
        tab === 'stock' ? h('div', null, h(SearchBar, {
          t: t,
          keyword: search.keyword,
          state: search,
          open: suggestOpen,
          onChange: onKeywordChange,
          onSubmit: onSubmitKeyword,
          onPick: pickSymbol,
          onFocus: function () {
            setSuggestOpen(true);
          },
          onBlur: function () {
            window.setTimeout(function () {
              setSuggestOpen(false);
            }, 160);
          },
        })) : null,
        tab === 'stock' ? h('div', { className: 'astock-body' },
          h('div', { className: 'astock-col' }, resultArea),
          h('div', { className: 'astock-col' },
            h(WatchlistPanel, {
              t: t,
              state: watch,
              activeKey: activeKey,
              onOpen: function (raw) {
                runEvaluate(raw, '');
              },
              onRemove: removeFromWatchlist,
            }))) : null,
        toast === null
          ? null
          : h('div', { className: 'astock-toast', role: 'status' }, toast.text));
    }

    /* ------------------------------------------------------------------ *
     * 模块出口
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale', 'connection'],
      apply: function apply(ctx) {
        var connection = typeof ctx.get === 'function' ? ctx.get('connection') : null;
        var locale = typeof ctx.get === 'function' ? ctx.get('locale') : null;
        var t = bindTranslator(locale);

        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        }, 'astock: dictionaries');

        /* 只注入一次样式；重复挂载不产生重复 <style>。 */
        ctx.effect(function () {
          ensureStyles();
          return undefined;
        }, 'astock: styles');

        ctx.slots.inject('main', function () {
          return ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: function () {
              return { rpc: connection !== null && connection !== undefined ? connection.rpc : null, t: t };
            },
          }, AstockPage);
        });

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: function () {
              return t('panel');
            },
            locale: NS,
          }, PanelIcon);
        });
      },
    };
  },
});
