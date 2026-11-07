# 发布说明

面向维护者：如何发一个新版本。

## 一次性准备

### 1. 建 GitHub 仓库并推送

```bash
cd dsh-stock-surf
git remote add origin git@github.com:FanXingChunShui/dsh-stock.git
git push -u origin main
```

### 2. 配置 npm 发布令牌

1. 登录 [npmjs.com](https://www.npmjs.com) → 右上角头像 → **Access Tokens**
2. **Generate New Token** → 选 **Automation**（CI 专用，可绕过 2FA）
3. 复制令牌（只显示一次）
4. 到 GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions**
   → **New repository secret**
   - Name: `NPM_TOKEN`
   - Secret: 粘贴令牌

> ⚠️ 用 **Automation** 类型。Classic 的 Publish 类型在开启 2FA 的账号上会失败。

### 3. 确认仓库是公开的（provenance 要求）

`npm publish --provenance` 会附带 SLSA 来源证明，但**只支持公开仓库**。

- 仓库公开：不用改，workflow 默认开启 provenance
- 仓库私有：到 Settings → Secrets and variables → Actions → **Variables** 新建
  `ENABLE_PROVENANCE` = `false`，否则发布会失败

### 4. 确认包名可用

```bash
npm view dsh-stock-surf version   # 若已存在会打印版本号
```

如果包名被占用，改 `package.json` 的 `name`，**同时**要改这三处：

1. `cordis.patch.yml` 的 `name`（Loader 按它找包）
2. `client.js` 顶部的 `id:`（必须与包名一致，否则前端模块对不上）
3. `lib/watchlist.js` 的 `PLUGIN_NAME`（按它定位配置条目，不改会写不进自选股）

`client.js` 里的 `data-plugin="..."` 与 localStorage key 是运行时内部标识，
**不要跟着改**——改了会让用户已保存的「上次查看代码」丢失。

## 发版流程

```bash
# 1. 改版本号（二选一）
npm version patch --no-git-tag-version   # 0.1.0 → 0.1.1，修 bug
npm version minor --no-git-tag-version   # 0.1.0 → 0.2.0，加功能
npm version major --no-git-tag-version   # 0.1.0 → 1.0.0，破坏性变更

# 2. 更新 CHANGELOG.md：把 [Unreleased] 内容挪到新版本小节

# 3. 本地验证
npm run lint:syntax && npm run verify:json && npm run verify:exports
npm test

# 4. 提交并打 tag（tag 必须与 package.json 的 version 完全一致）
git add -A
git commit -m "chore: release v0.2.0"
git tag v0.2.0
git push && git push --tags
```

推送 tag 后，`Release` workflow 会自动：

1. 校验 tag 与 `package.json` 版本一致（不一致直接失败）
2. 校验 `private` 为 `false`
3. 跑语法检查、JSON 校验、导出校验、全量测试
4. `npm publish --access public --provenance`
5. 建 GitHub Release 并附上 tarball

## 手动试跑（不发布）

在 GitHub 仓库 → **Actions** → **Release** → **Run workflow**，
把 `dry-run` 保持勾选，只跑校验不发布。

## 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| `tag (vX.Y.Z) 与 package.json (A.B.C) 版本不一致` | tag 与版本号不匹配 | 改 `package.json` 的 version，删 tag 重打 |
| `private 必须是 false` | `package.json` 里 `private: true` | 改成 `false` |
| `npm publish` 报 403 | `NPM_TOKEN` 缺失/过期/权限不足 | 重新生成 Automation token 并更新 secret |
| `npm publish` 报 403 `cannot publish over` | 该版本号已存在 | npm 不允许覆盖，必须升版本号 |
| `ENEEDAUTH` | 未配置 `registry-url` 或 token 未注入 | 检查 workflow 的 `setup-node` 参数 |
| 联网测试失败 | GitHub runner 访问国内接口不稳定 | 测试自带 `isOnline()` 探测并 skip，正常不会红；若真红了说明代码 bug |
| `Assert required files are packaged` 失败 | 曾用 `grep " $file "` 做文本断言，但 `npm pack` 的文件清单按列宽动态对齐，文件名后补多空格 | 已改用 `scripts/verify-pack.mjs`（走 `npm pack --dry-run --json` 拿结构化列表）。若仍失败，看日志里具体哪个文件缺失，检查 `package.json` 的 `files` 字段 |

## 本地安装验证

发布后可以这样验证包是否可用：

```bash
# 方式一：直接从 npm 装
# 在 DSH 里对 agent 说：安装 dsh-stock-surf 这个 bundle

# 方式二：下载 tarball 本地装
npm pack dsh-stock-surf
# 然后 install_bundle 指向该 .tgz
```

## 版本策略

- **patch**：修 bug、改文案、调参数
- **minor**：新增 tab、新增工具、新增数据源
- **major**：改 `Evaluation` 字段名、改 RPC 端点契约、改工具名

评分权重调整算 **minor**（结果会变但接口不变）；`CONTRACT.md` 里标注「冻结」的
签名变更算 **major**。
