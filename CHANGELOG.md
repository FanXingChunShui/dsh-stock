# Changelog

本项目的所有重要变更记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

发布流程：把下方 `[Unreleased]` 的内容整理到新版本小节 → 改 `package.json` 的
`version` → 提交 → 打 `vX.Y.Z` tag → 推送。GitHub Actions 会自动校验版本一致性、
跑全量测试、发布到 npm 并建 Release。

## [Unreleased]

### 新增

- **日 K 线模块**：纯 SVG 蜡烛图，含 MA5/10/20/60 均线与成交量副图，
  支持 60/120/250 日切换，鼠标悬停显示当日 OHLCV。零图表库依赖。
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

[Unreleased]: https://github.com/OWNER/dsh-astock/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/dsh-astock/releases/tag/v0.1.0
