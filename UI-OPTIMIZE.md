# UI 优化方案

> 状态：**P0 + P1 已实施（v0.2.1）**，P2 未做。实施结果见文末第 5 节。
> 本文基于对 `client.js` 的实际审计，不是主观猜测。审计脚本见文末。

---

## 0. 审计结果（先看事实）

```
client.js 中 CSS 数组：313 行，定义了 150 个类
组件中 className 实际使用：176 个类
→ 29 个类完全没有样式
```

**29 个缺失中，22 个属于量化模块**（上次新增量化 UI 时只写了类名、没写样式）。其余 7 个是更早就存在的：

| 类别 | 数量 | 明细 |
|---|---|---|
| 量化模块 | **22** | `astock-quant-*` 全部 + `astock-subtab` / `astock-subtabs` |
| 历史遗留 | 5 | `astock-change`、`astock-price-row`、`astock-score-unit`、`astock-score-value`、`astock-verdict` |
| 变量未定义 | 1 | `--astock-warn` 被使用 3 处，但从未定义 |

### 这意味着什么

**量化 Tab 目前是没有任何样式的裸 HTML。** 具体后果：

| 位置 | 现状（无样式） | 应该的样子 |
|---|---|---|
| 六项统计指标 | 纵向堆成一列「总收益 / -26.67% / 年化 / -6.73%…」，看不清对应关系 | 2×3 或 3×2 网格，数字大、标签小 |
| 净值曲线 SVG | 无宽度约束，`viewBox 720×180` 会按原尺寸撑开，窄容器里溢出 | 宽度 100%、高度固定、可缩放 |
| 交易明细表 | 无边框无内边距，数字贴在一起 | 细边框、右对齐数字、斑马纹 |
| 子 Tab（回测/扫描/组合） | 3 个浏览器默认灰色按钮，与上方 4 个 Tab 视觉断裂 | 与主 Tab 同一套下划线样式 |
| 控制栏（策略下拉 + 区间下拉 + 按钮） | 挤在一行无间距 | 横向排列、有间距、标签在控件上方 |

另外 `astock-change`（量化选股行的涨跌幅）虽然传了 `data-tone="up/down"`，但因为没有 CSS，**涨跌颜色完全不生效**。

---

## 1. 现有设计语言（新样式必须对齐）

审计出来的一套既定规范，新样式照此写才不会违和：

| 维度 | 现有取值 |
|---|---|
| 颜色 | 全部走 DSH 主题变量，双层 fallback：`var(--dsh-color-*, var(--dsw-alias-*, 硬编码))` |
| 涨跌色 | 红涨绿跌 `--astock-up:#e33a34` / `--astock-down:#18a058`（A 股习惯） |
| 边框 | `.5px solid var(--astock-border)` —— 统一的半像素细边框 |
| 圆角 | `--astock-radius:10px` / `--astock-radius-sm:6px` |
| 字号 | 根 13px/20px｜标题 17px/600｜卡片正文 12px｜小字 11px |
| 数字 | `font-variant-numeric: tabular-nums` 全局等宽，避免跳动 |
| 间距 | `gap` 12px（块间）/ 8px（元素间）/ 6px（紧凑） |
| 动效 | 只有一个 spin，且 `prefers-reduced-motion` 时降速 |
| 响应式 | 900px 断点（双栏→单栏）、520px 断点（缩小 padding） |

**关键约束**：不硬编码品牌色，才能跟随用户主题（亮/暗）切换。

---

## 2. 三档方案

### P0 —— 补齐缺失样式（必做，约 120 行 CSS）

只补样式，不动组件结构，风险最低。

**量化统计卡** `.astock-quant-stats` / `.astock-quant-stat`
- 网格自适应：`repeat(auto-fit, minmax(110px, 1fr))`，6 张卡在宽屏一行、窄屏换行
- 卡片内：标签 11px/次要色，数值 18px/600/等宽，备注 11px/三级色
- 数值按 tone 上色（正红负绿）

**净值曲线** `.astock-quant-chart` / `.astock-quant-svg`
- 容器：`width:100%`，`height:180px`，细边框 + 圆角 + 内边距
- SVG：`width:100%;height:100%;display:block`（关键：消除 inline 元素底部间隙）
- 图例：横排，11px，圆点标记

**子 Tab** `.astock-subtabs` / `.astock-subtab`
- 完全复用主 Tab 的下划线样式，只是字号小一档（12px）
- 这样从「个股/板块/列表/量化」切到「单股回测/选股扫描/组合回测」时视觉是连续的

**控制栏** `.astock-quant-controls` / `.astock-quant-field`
- `display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap`
- 字段内标签 11px 次要色在上，`select` 沿用搜索框的边框风格

**表格** `.astock-quant-table`
- `.5px` 细边框、`padding:6px 10px`、数字列右对齐、表头 11px 次要色
- 行 hover 高亮

**扫描列表** `.astock-quant-scan*`
- 复用 `.astock-mlist-row` 的网格节奏，保持和「列表」Tab 一致的手感

**顺带修掉**
- `--astock-warn` 补定义（暗色主题下当前用的是硬编码 `#b8860b`，对比度不可控）
- `.astock-change[data-tone]` 补涨跌色，让量化行的涨跌幅颜色生效
- 其余 4 个历史遗留类一并落实

### P1 —— 交互增强（约 80 行）

**净值曲线 hover 十字光标**
K 线图已经有 hover tip（`.astock-kline-tip`），量化图完全没有。补上：
- 鼠标移动时显示该日期的净值与基准值
- 悬停点画圆点高亮
- 离开后隐藏

这是**最值得做的一项**——回测最有价值的动作是「看看某个时点发生了什么」，没有 hover 就只能看个大概形状。

**空态与错误态**
现在量化三个子视图的空态都是纯文字段落。改成带图标/标题/操作建议的卡片，和现有 `.astock-state` 风格统一。

**加载态**
扫描全市场要 4-6 秒，现在只有一行文字。加进度感（步骤提示：拉列表 → 粗筛 → 评分）。

### P2 —— 布局打磨（可选）

**结果优先的信息层级**
回测完成后，用户最想看的是「赚了还是亏了」。当前六张卡等权排列，主次不分。建议：
- 总收益做成大号主数字（24px），其余五项降为次级
- 超额收益（策略 − 基准）单独突出，这是判断策略有没有价值的核心指标

**移动端**
量化视图没做响应式。520px 下统计卡应 2 列、表格横向滚动、控制栏竖排。

**净值曲线基线**
当前纵轴只是数值范围，看不出「有没有赚钱」。加一条水平基准线（初始净值），盈亏两侧用淡色填充。

---

## 3. 建议

**先做 P0 + P1 的 hover**。理由：

- P0 是**修 bug 不是美化**——量化 Tab 现在视觉上是坏的，功能再好也用不了
- hover 是投入产出比最高的一项，直接决定「回测结果可不可读」
- P2 的视觉打磨等 P0 上线后看到了真实效果再决定，避免一次改太多方向跑偏

预估工作量：P0 约 120 行 CSS（集中在 CSS 数组尾部追加，不动组件）；P1 约 80 行（EquityChart 加 hover 状态）。

---

## 4. 验证方式

目前 GUI 需要认证（`HTTP 401`），Playwright 打不开。建议二选一：

- **A**：你提供访问方式，我用浏览器逐屏截图核对
- **B**：我用模拟 React 环境把组件渲染成静态 HTML + 内联 CSS，导出成 `.html` 文件给你在本地打开看效果

B 的好处是不依赖 GUI 认证，能直接对比「改前 / 改后」。

---

## 附：审计方法

```js
const src = fs.readFileSync('client.js','utf8');
const lines = src.split('\n');
// CSS 数组从 `var CSS = [` 到 `].join`
const defined = new Set((css.match(/\.astock-[a-z-]+/g)||[]).map(x=>x.slice(1)));
// 组件里 className 用到的类
const used = new Set();
for (const m of src.matchAll(/className:\s*([^,\n]+)/g))
  for (const c of (m[1].match(/astock-[a-z-]+/g)||[])) used.add(c);
// 差集即缺失
const missing = [...used].filter(c=>!defined.has(c));
```

---

## 5. 实施结果（v0.2.1）

### 做了什么

P0 全部 + P1 的 hover 交互，共改 `client.js` 278 行新增 / 17 行删除。

| 项 | 改前 | 改后 |
|---|---|---|
| 统计卡 | `display:block`，6 张卡各占一行（每行 20px 高） | `display:grid` + `auto-fit`，6 张卡一行，每张 143px |
| 净值曲线 SVG | `display:inline`，`preserveAspectRatio:none`（拉伸变形） | `display:block`，`xMidYMid meet` 等比缩放，`non-scaling-stroke` 固定线宽 |
| 明细表 | `border-collapse:separate`，`padding:1px` | `collapse`，`padding:5px 9px`，数字右对齐 |
| 子 Tab | 浏览器默认灰按钮 | 复用主 Tab 下划线语言，激活态主题色 |
| 控制栏 | 无间隔 | `flex` + `gap:10px`，下拉框带自定义箭头 |
| 基准曲线 | **从未渲染**（字段读错） | 从 `equity[i].benchmark` 回退取值，正常显示 |
| 涨跌色 | `data-tone` 无样式，完全不生效 | 红涨绿跌生效 |
| 移动端 | 无适配 | 480px 视口 2 列网格、表格横滚、字段竖排 |
| hover | 无 | 十字光标 + 净值气泡，曲线顶端自动翻转 |

### 实施中额外发现的两个问题

1. **基准对比从未显示**（`CHANGELOG` 已单列）。这是审计样式时顺带发现的：
   数据把基准挂在 `equity[i].benchmark`，组件读顶层 `data.benchmark`。
   属于功能性缺陷，比样式问题更严重——它让回测图失去了唯一的价值判断依据。

2. **拆行写 `url()` 会静默毁掉整块 CSS**。我第一版把 select 的下拉箭头
   data URI 拆成 3 个数组元素，CSS 数组 `join('\n')` 后在 `url()` 内插入换行，
   浏览器直接丢弃该规则**及其后所有规则**。表现是「子 Tab 有样式、统计卡没有」
   ——因为我只测了 `node --check`（语法通过）和几个类名是否存在（都存在）。
   最终是靠 Playwright 读 `getComputedStyle` 发现 `grid` 变成了 `block` 才定位到。

### 验证方式

GUI 需要认证（401），所以用**静态 HTML 预览 + DOM 计算样式**验证：

- 从 `git show HEAD:client.js` 取改前版本，用同一份真实回测数据分别渲染，
  输出 `ui-preview/{before,after,after-dark}.html` 可直接在浏览器打开对比
- 用 Playwright 读 `getComputedStyle` 逐项核对布局（而非目测截图）
- hover 的坐标换算单独做逻辑验证：5 个边界用例（图外左/左缘/正中/右缘/图外右）
  全部通过，越界钳制与 `mouseleave` 清理也都正确

### 新增的防回归测试

`tests/ui-css.test.mjs`（17 项），把两类只在渲染后才暴露的事故挡在提交前：

- 类名裸奔（用了但没写样式）
- CSS 结构破坏（`url()` 含换行、花括号不平衡、顶层选择器重复）
- 变量引用但未定义
- 关键布局属性是否是对的值（如 SVG 必须 `block`、统计卡必须 `grid`）

变异验证确认非空转：删 `.astock-quant-stats` → 测试 10 失败；拆行 `url()` →
测试 2 失败；删 `--astock-warn` → 测试 8 失败。

### 未做（P2）

主次信息层级（总收益大号化、超额收益突出）、净值曲线的初始净值基线、
扫描结果的进度提示。这些属于「更好看」而非「能用」，等 P0 上线后
看到真实效果再决定方向。
