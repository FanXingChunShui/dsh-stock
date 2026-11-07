# Changelog

本项目的所有重要变更记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发布流程：把下方 `[Unreleased]` 的内容整理到新版本小节 → 改 `package.json` 的
`version` → 提交 → 打 `vX.Y.Z` tag → 推送。GitHub Actions 会自动校验版本一致性、
跑全量测试、发布到 npm 并建 Release。

## [Unreleased]

## [0.1.1] - 2026-11-07

### 修复

- **CI 打包校验假失败**：`npm pack` 的文件清单按列宽动态对齐，用
  `grep " $file "` 做文本断言匹配不上多空格。改用
  `scripts/verify-pack.mjs`（`npm pack --dry-run --json` 结构化校验）。
- **publish 假成功**：`npm publish | tee` 的退出码是 tee 的，失败会被伪装成成功，
  导致「Release 全绿但 npm 上没有包」。加 `set -o pipefail` 并新增
  registry 上线校验。

### 变更

- **改用 npm Trusted Publishing (OIDC)**，不再依赖任何长期 token：
  - 移除 `NPM_TOKEN` 及凭证校验步骤
  - 移除 `setup-node` 的 `registry-url`（它会写空 token 到 .npmrc 导致 ENEEDAUTH）
  - 新增 npm 升级步骤（OIDC 需 npm ≥ 11.5.1，Node 自带的是 10.x）
- 包名改为 `dsh-stock-surf`（`dsh-astock` / `dsh-stock` 已被占用）

### 新增

- **K 线模块**：纯 SVG 蜡烛图，含均线与成交量副图，鼠标悬停显示 OHLCV。零图表库依赖。
- **六档时间范围**：1天 / 7天 / 30天 / 60天 / 120天 / 250天。
  其中 1 天用 5 分钟线（48 根）、7 天用 30 分钟线（70 根）、30 天用 60 分钟线（120 根），
  更长的范围走日线。分钟线只有 A 股有免费源，港美股自动回落日线。
- **一键解读**：把 K 线与技术指标翻译成中文结论——区间表现、均线结构、
  RSI 区间、MACD 状态、量能变化，并单列「需要留意」的风险点。
  规则化文案，不做涨跌预测。

### 新增

- **K 线模块**：纯 SVG 蜡烛图，含均线与成交量副图，鼠标悬停显示 OHLCV。零图表库依赖。
- **六档时间范围**：1天 / 7天 / 30天 / 60天 / 120天 / 250天。
  其中 1 天用 5 分钟线（48 根）、7 天用 30 分钟线（70 根）、30 天用 60 分钟线（120 根），
  更长的范围走日线。分钟线只有 A 股有免费源，港美股自动回落日线。
- **一键解读**：把 K 线与技术指标翻译成中文结论——区间表现、均线结构、
  RSI 区间、MACD 状态、量能变化，并单列「需要留意」的风险点。
  规则化文案，不做涨跌预测。

### 变更

- 移除代码与文档中的个人信息与设备信息：
  - 4 个 lib 文件的 User-Agent 不再暴露操作系统与版本
  - CONTRACT.md 去掉个人绝对路径
  - DATA-SOURCES.md 去掉调研环境的系统描述

## [0.1.0] - 2026-11-07

首个可用版本。

### 新增

- **Web 面板**（侧栏「股票冲浪」）：个股 / 板块 / 列表三个 tab
- **个股评估**：6 因子技术评分（趋势 28% / 动量 22% / 量能 18% / 位置 16% / 波动 10% / 风险 6%），
  输出 0-100 综合分、多空判定、支撑压力位、风险提示
- **多市场支持**：A 股（沪/深/北）、港股、美股，代码自动识别
  （`600519` / `hk00700` / `usAAPL` / `hkHSI`）
- **板块功能**：一级行业 31 个、二级行业 124 个、概念板块 805 个，
  5 因子截面评分（动量 / 趋势 / 资金流 / 活跃度 / 广度）
- **板块成分股**：板块详情页展示全部成分股，可点击跳转个股
- **股票列表**：A 股全量 5578 只（搜索 / 排序 / 分页）、港股 60 只、美股 32 只
- **自选股**：增删、持久化、行内显示涨跌幅与评分
- **个股详情增强**：公司业务介绍（行业 / 经营范围 / 简介 / 员工数）、最新公告、
  涨跌依据卡片、一键分析
- **Agent 工具**：`astock_evaluate` / `astock_quote` / `astock_search` /
  `astock_sectors` / `astock_detail`

### 数据源

- A 股行情：腾讯快照 + 新浪 K 线（腾讯 K 线被 WAF 拦截时自动回退）
- 港股：腾讯快照与 K 线
- 美股：腾讯快照 + 新浪 K 线备源（含全历史）
- 公司资料与公告：东方财富 F10 / 公告接口
- 板块成分股：东方财富 datacenter

### 工程

- 零运行时依赖（仅 `@deepseek-ai/schemastery` 用于配置 schema）
- 204 个测试，含纯函数测试与联网冒烟（网络不可达时自动 skip）
- GitHub Actions：CI（3 个 Node 版本矩阵 + 打包校验）、Release（版本校验 + npm 发布）

[Unreleased]: https://github.com/FanXingChunShui/dsh-stock/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/FanXingChunShui/dsh-stock/releases/tag/v0.1.1
[0.1.0]: https://github.com/FanXingChunShui/dsh-stock/releases/tag/v0.1.0
