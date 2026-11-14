/**
 * dsh-astock / tests/ui-css.test.mjs
 * client.js 的样式完整性自测。
 *
 * 为什么需要这个测试：
 *   client.js 是浏览器脚本（通过 window.__ModuleLoader__ 注册），Node 无法
 *   import，只能当文本读。而它的 CSS 是一个字符串数组——这类结构有两类
 *   静默事故，光看代码看不出来：
 *
 *   1) **写了类名却没写样式**。组件里 className: 'astock-quant-stats'
 *      拼错一个字母、或新增组件时忘了加 CSS，结果就是「布局塌成一行文字」。
 *      浏览器不会报错，jsdom 也不会。量化模块第一版就是这样：22 个类名
 *      全部裸奔，面板能打开、数据也对，但视觉上完全是坏的。
 *
 *   2) **拆行写 url()**。CSS 数组用 '\n' join，把 data URI 拆成多个数组
 *      元素会在 url() 内部插入换行，导致该规则**连同其后所有规则**一起
 *      被浏览器丢弃。这个坑真实踩过：整块量化样式集体失效，而语法检查
 *      （node --check）完全通过。
 *
 * 这两类问题都只在渲染后才暴露，所以用静态断言把它们挡在提交前。
 *
 * 运行：cd dsh-astock && node --test tests/ui-css.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'client.js');
const SOURCE = fs.readFileSync(CLIENT, 'utf8');

/**
 * 取出 CSS 数组并求值成真正的 CSS 文本。
 *
 * 直接 eval 数组字面量而不是自己拼字符串：数组里既有普通字符串，
 * 也有 JS 注释，手写解析容易和真实语义产生偏差。
 */
function readCss() {
  const lines = SOURCE.split('\n');
  const start = lines.findIndex((l) => l.includes('var CSS = ['));
  assert.ok(start >= 0, 'client.js 里找不到 `var CSS = [`');
  let end = -1;
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].includes('].join')) { end = i; break; }
  }
  assert.ok(end > start, 'CSS 数组没有找到 `].join` 结尾');
  const block = lines.slice(start, end + 1).join('\n').trim();
  const expr = block.replace(/^var CSS =/, '').replace(/;?\s*$/, '');
  return Function(`return ${expr}`)();
}

const CSS = readCss();

/* ════════════════════════════════════════════════════════════════
 * 一、CSS 结构
 * ════════════════════════════════════════════════════════════════ */

test('CSS 数组能求值为非空文本', () => {
  assert.equal(typeof CSS, 'string');
  assert.ok(CSS.length > 5000, `CSS 太短（${CSS.length} 字符），可能解析错了`);
});

test('url() 体内不含换行 —— 拆行写 data URI 会让整条规则及其后规则失效', () => {
  const bad = [];
  for (const m of CSS.matchAll(/url\([^)]*\)/gs)) {
    if (m[0].includes('\n')) bad.push(m[0].slice(0, 70).replace(/\n/g, '\\n'));
  }
  assert.deepEqual(bad, [], `发现 ${bad.length} 处 url() 内含换行：${bad.join(' | ')}`);
});

test('花括号平衡，且不存在未闭合的字符串', () => {
  let depth = 0;
  let inStr = null;
  let line = 1;
  let maxDepth = 0;
  for (let i = 0; i < CSS.length; i += 1) {
    const ch = CSS[i];
    if (ch === '\n') line += 1;
    if (inStr) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '/' && CSS[i + 1] === '*') {
      const close = CSS.indexOf('*/', i + 2);
      assert.ok(close > i, `第 ${line} 行的注释没有闭合`);
      line += (CSS.slice(i, close).match(/\n/g) || []).length;
      i = close + 1;
      continue;
    }
    if (ch === '{') { depth += 1; maxDepth = Math.max(maxDepth, depth); }
    if (ch === '}') {
      depth -= 1;
      assert.ok(depth >= 0, `第 ${line} 行出现多余的 }`);
    }
  }
  assert.equal(inStr, null, '存在未闭合的字符串');
  assert.equal(depth, 0, `花括号未配平，剩余深度 ${depth}`);
  // 有嵌套（@media / @keyframes）说明扫描确实走到了嵌套层
  assert.ok(maxDepth >= 2, `最大嵌套深度只有 ${maxDepth}，@media 可能没被正确解析`);
});

test('不存在未接选择器的规则块（`{ ... }` 前面必须有选择器）', () => {
  let depth = 0;
  let selStart = 0;
  const empty = [];
  let line = 1;
  for (let i = 0; i < CSS.length; i += 1) {
    const ch = CSS[i];
    if (ch === '\n') line += 1;
    if (ch === '{') {
      if (depth === 0 && CSS.slice(selStart, i).trim() === '') empty.push(line);
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) selStart = i + 1;
    }
  }
  assert.deepEqual(empty, [], `第 ${empty.join(', ')} 行出现没有选择器的规则块`);
});

test('顶层选择器不重复定义（媒体查询内的覆盖不算）', () => {
  const seen = new Map();
  const dups = [];
  let depth = 0;
  let selStart = 0;
  let line = 1;
  for (let i = 0; i < CSS.length; i += 1) {
    const ch = CSS[i];
    if (ch === '\n') line += 1;
    if (ch === '{') {
      if (depth === 0) {
        const sel = CSS.slice(selStart, i).trim();
        if (sel && !sel.startsWith('@')) {
          if (seen.has(sel)) dups.push(`${sel}（第 ${seen.get(sel)} 行与第 ${line} 行）`);
          else seen.set(sel, line);
        }
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) selStart = i + 1;
    }
  }
  assert.deepEqual(dups, [], `顶层选择器重复：${dups.join(' | ')}`);
});

/* ════════════════════════════════════════════════════════════════
 * 二、类名覆盖：组件用到的每个 className 都必须有样式
 * ════════════════════════════════════════════════════════════════ */

/** 从 className 的各种写法里抽出 astock-* 类名。 */
function collectUsedClasses() {
  const used = new Set();
  // className: 'a b c' / className: "a" / className: 'a' + (cond ? 'b' : '')
  for (const m of SOURCE.matchAll(/className:\s*([^,\n]+)/g)) {
    for (const cls of m[1].match(/astock-[a-z0-9-]+/g) || []) used.add(cls);
  }
  return used;
}

/** CSS 里定义过的类名。 */
function collectDefinedClasses() {
  const defined = new Set();
  for (const m of CSS.matchAll(/\.(astock-[a-z0-9-]+)/g)) defined.add(m[1]);
  return defined;
}

test('组件里用到的每个 astock-* 类名都有对应样式（防"裸奔"）', () => {
  const used = collectUsedClasses();
  const defined = collectDefinedClasses();
  assert.ok(used.size > 100, `只收集到 ${used.size} 个类名，提取逻辑可能失效`);
  const missing = [...used].filter((c) => !defined.has(c)).sort();
  assert.deepEqual(
    missing,
    [],
    `以下 ${missing.length} 个类名被组件使用但没有任何 CSS 规则（面板会塌成裸 HTML）：\n  ${missing.join('\n  ')}`,
  );
});

test('量化模块的类名成组存在 —— 防止局部遗漏', () => {
  const defined = collectDefinedClasses();
  const core = [
    'astock-quant-chart', 'astock-quant-plot', 'astock-quant-svg',
    'astock-quant-legend', 'astock-quant-legend-item', 'astock-quant-dot',
    'astock-quant-stats', 'astock-quant-stat', 'astock-quant-stat-label',
    'astock-quant-stat-value', 'astock-quant-stat-note',
    'astock-quant-controls', 'astock-quant-field',
    'astock-quant-table', 'astock-quant-trades', 'astock-quant-warnings',
    'astock-quant-scan', 'astock-quant-scan-row', 'astock-quant-scan-name',
    'astock-quant-scan-price', 'astock-quant-scan-score',
    'astock-subtabs', 'astock-subtab', 'astock-quant-tip',
  ];
  const missing = core.filter((c) => !defined.has(c));
  assert.deepEqual(missing, [], `量化模块缺少样式：${missing.join(', ')}`);
});

/* ════════════════════════════════════════════════════════════════
 * 三、CSS 变量：引用的每个 --astock-* 都必须先定义
 * ════════════════════════════════════════════════════════════════ */

test('引用的每个 --astock-* 变量都有定义（防主题色失效）', () => {
  const defined = new Set();
  for (const m of CSS.matchAll(/(--astock-[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  const used = new Set();
  for (const m of SOURCE.matchAll(/var\((--astock-[a-z0-9-]+)/g)) used.add(m[1]);
  assert.ok(used.size > 10, `只收集到 ${used.size} 个变量引用，提取逻辑可能失效`);
  const missing = [...used].filter((v) => !defined.has(v)).sort();
  assert.deepEqual(
    missing,
    [],
    `以下变量被引用但从未定义（会静默回退到硬编码色，暗色主题下对比度失控）：\n  ${missing.join('\n  ')}`,
  );
});

/* ════════════════════════════════════════════════════════════════
 * 四、关键布局属性：光定义还不够，得是对的值
 * ════════════════════════════════════════════════════════════════ */

test('净值曲线 SVG 是块级且填满容器（inline 会撑出底部空隙并溢出）', () => {
  const rule = CSS.match(/\.astock-quant-svg\{([^}]*)\}/);
  assert.ok(rule, '找不到 .astock-quant-svg 规则');
  assert.match(rule[1], /display:\s*block/, 'SVG 必须是 block，inline 会导致布局偏移');
  assert.match(rule[1], /width:\s*100%/, 'SVG 宽度必须撑满容器');
  assert.match(rule[1], /height:\s*auto/, 'height:auto 才能按 viewBox 等比缩放，避免拉伸变形');
});

test('统计卡是网格布局（block 会让六项指标堆成六行）', () => {
  const rule = CSS.match(/\.astock-quant-stats\{([^}]*)\}/);
  assert.ok(rule, '找不到 .astock-quant-stats 规则');
  assert.match(rule[1], /display:\s*grid/, '统计卡必须是 grid');
  assert.match(rule[1], /grid-template-columns:\s*repeat\(auto-fit/, '应使用 auto-fit 自适应列数');
});

test('明细表用 border-collapse 且数字列右对齐', () => {
  const rule = CSS.match(/\.astock-quant-table\{([^}]*)\}/);
  assert.ok(rule, '找不到 .astock-quant-table 规则');
  assert.match(rule[1], /border-collapse:\s*collapse/, '表格应合并边框');
  const cell = CSS.match(/\.astock-quant-table td\{([^}]*)\}/);
  assert.ok(cell, '找不到 td 规则');
  assert.match(cell[1], /text-align:\s*right/, '数字列右对齐才便于竖向比较');
});

test('子 Tab 复用主 Tab 的下划线语言，激活态有色边框', () => {
  const active = CSS.match(/\.astock-subtab\[data-active="true"\]\{([^}]*)\}/);
  assert.ok(active, '找不到子 Tab 的激活态规则');
  assert.match(active[1], /border-bottom-color:\s*var\(--astock-accent\)/, '激活态应有主题色下划线');
});

test('hover 气泡不吃鼠标事件（否则一出现就触发 mouseleave、开始闪烁）', () => {
  const rule = CSS.match(/\.astock-quant-tip\{([^}]*)\}/);
  assert.ok(rule, '找不到 .astock-quant-tip 规则');
  assert.match(rule[1], /pointer-events:\s*none/, 'tip 必须 pointer-events:none');
});

test('移动端断点覆盖量化视图', () => {
  const media = CSS.match(/@media \(max-width:520px\)\{([\s\S]*?)\}\s*$/);
  assert.ok(media, '找不到 520px 媒体查询');
  const block = media[1];
  assert.match(block, /\.astock-quant-stats\{grid-template-columns:repeat\(2/, '窄屏统计卡应固定两列');
  assert.match(block, /\.astock-quant-table\{[^}]*overflow-x:auto/, '窄屏表格应可横向滚动');
});

/* ════════════════════════════════════════════════════════════════
 * 五、组件结构：图表容器的层级决定了 hover 定位是否准确
 * ════════════════════════════════════════════════════════════════ */

test('净值曲线有独立的定位容器 .astock-quant-plot', () => {
  assert.match(SOURCE, /className: 'astock-quant-plot'/, '缺少 plot 容器，hover 气泡无法按百分比定位');
  const rule = CSS.match(/\.astock-quant-plot\{([^}]*)\}/);
  assert.ok(rule, '找不到 .astock-quant-plot 规则');
  assert.match(rule[1], /position:\s*relative/, 'plot 必须是 relative，作为气泡的定位参照');
  assert.match(rule[1], /line-height:\s*0/, 'line-height:0 消除 inline 元素基线空隙');
});

test('净值曲线处理了基准序列的两种来源', () => {
  // 回测把基准挂在每个净值点上，没有顶层 benchmark 字段；
  // 组件必须能从 equity[i].benchmark 回退取值，否则基准曲线永远画不出来。
  assert.match(SOURCE, /equity\[d\] && equity\[d\]\.benchmark/, '缺少从 equity[i].benchmark 回退取基准的逻辑');
  assert.match(SOURCE, /preserveAspectRatio: 'xMidYMid meet'/, 'SVG 应等比缩放而不是拉伸');
  assert.match(SOURCE, /vectorEffect: 'non-scaling-stroke'/, '线宽应固定，否则缩放后描边变粗');
});

test('净值曲线的 hover 在 early return 之前调用了 hooks', () => {
  // React 要求每次渲染的 hook 数量一致。若 useState 写在空数据分支之后，
  // 空数据时会少跑一个 hook，直接崩在 rendering order 检查上。
  const fnStart = SOURCE.indexOf('function EquityChart(props)');
  assert.ok(fnStart > 0, '找不到 EquityChart');
  const fnBody = SOURCE.slice(fnStart, fnStart + 1400);
  const hookPos = fnBody.indexOf('React.useState(null)');
  const returnPos = fnBody.indexOf('return h(\'p\'');
  assert.ok(hookPos > 0, 'hover 状态没有用 useState 管理');
  assert.ok(returnPos > 0, '找不到 early return 分支');
  assert.ok(hookPos < returnPos, 'useState 必须在 early return 之前调用');
});
