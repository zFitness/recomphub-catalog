# recomphub-catalog

RecompHub 的独立目录数据仓库。它人工维护游戏来源清单，通过 GitHub Actions
每日调用 GitHub REST API 同步版本信息，生成静态目录并发布，供 Android App
按需下载。

本仓库与 `RecompHub` Android 源码仓库解耦：App 只保留目录协议、客户端逻辑和
默认 endpoint，不提交完整远程目录。

## 目录结构

```text
sources/sources.json                 # 人工维护输入（唯一手工编辑入口）
catalog/games.json                   # 生成产物：完整目录
catalog/games.manifest.json          # 生成产物：小型更新清单
state/last-known.json                # 同步器内部状态
state/last-run.json                  # 最近一次运行报告
src/                                 # 同步器（TypeScript，Node 原生运行，无运行时依赖）
  sync_catalog.ts                    # CLI 入口（validate / sync）
  catalog.ts                         # 合并人工字段、生成目录与 manifest
  github_client.ts                   # GitHub REST client 与版本解析
  validation.ts                      # sources.json / 目录校验
tests/                               # 生成器 / API client 测试（node:test）
package.json / tsconfig.json         # 脚本、类型检查配置
.github/workflows/sync-catalog.yml   # Actions workflow
docs/schema.md                       # 字段、约束与版本兼容策略
```

## 发布地址（Android App 使用的 HTTPS endpoint）

GitHub Pages 从默认分支的 `catalog/` 目录发布：

- manifest：`https://zfitness.github.io/recomphub-catalog/games.manifest.json`
- 完整目录：`https://zfitness.github.io/recomphub-catalog/games.json`

raw 备用/诊断入口（不作为客户端唯一承诺）：

- `https://raw.githubusercontent.com/zfitness/recomphub-catalog/main/catalog/games.manifest.json`
- `https://raw.githubusercontent.com/zfitness/recomphub-catalog/main/catalog/games.json`

> 若 owner 不是 `zfitness`，请同步修改 App 的默认 endpoint 配置。

## 本地运行

需要 Node.js 22.18+（本仓库在 Node 24 上验证），由 Node 原生执行 TypeScript，
无需构建步骤：

```bash
npm install                                # 安装开发依赖（仅 typescript / @types/node）
npm run validate                           # 只校验 sources.json
GITHUB_TOKEN=<token> npm run sync          # 解析、合并、生成目录
npm run typecheck                          # tsc --noEmit
npm test                                   # node:test 单元测试
```

`sync` 只在规范化目录内容变化时写入 `catalog/`，未变化时不产生提交。

## 新增或修改一个游戏

1. 在 `sources/sources.json` 增加一个条目（稳定 `gameId`、GitHub 坐标、
   `versionStrategy`、至少一个 `runtimePlatforms`）。
2. 提交 PR / commit，`validate` 步骤会检查字段、唯一性和 URL。
3. 触发同步（等待每日 `schedule`，或手动 `workflow_dispatch`）。
4. 同步器合并人工字段与 GitHub 观察结果，重新生成 `games.json` 和 manifest。
5. App 在下一次更新检查中获取新目录，无需发版。

**不要**直接编辑 `catalog/games.json`，它会在下次同步被覆盖。

## GitHub Pages 配置

仓库 Settings → Pages → Source 选择 “GitHub Actions”。workflow 会在提交后
上传 `catalog/` 目录并部署。首次启用后确认两个静态文件可访问。

## 运维说明

- `schedule` 是“尽力而为”的：可能延迟、被丢弃，公开仓库长期无活动时还可能被
  自动停用。异步延迟或停用不是故障，App 会继续使用最近一次有效缓存。
- 手动触发用于新增 source、排查失败和补偿运行；它与每日任务使用相同的校验、
  限流和发布规则。
- 限流：请求使用 `GITHUB_TOKEN`，低并发（4），读取响应中的限流头；遇到
  `Retry-After` 或剩余额度低于安全余量时停止新请求并让本次运行失败，不会用
  未完成的结果覆盖最近一次有效目录。
- 单仓库不可访问：已有条目标记 `error`/`unavailable` 并保留最近已知版本；
  新增条目首次取不到有效版本时会阻止本次发布。
- 失败诊断：workflow 日志和 `state/last-run.json` 都会记录统计与原因；
  排查后可手动 `workflow_dispatch` 补偿。
