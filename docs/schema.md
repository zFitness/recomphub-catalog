# Catalog schema

本文件定义 catalog repository 中三个 JSON 文件的字段、约束和版本兼容策略。
它们对应 `add-github-game-catalog-pipeline` 的 `github-source-sync` 与
`static-game-catalog` 两个能力。

## 版本兼容策略

- 三个文件都带 `schemaVersion`（整数）。
- 生成器只接受 `SUPPORTED_SOURCE_SCHEMA_VERSIONS = {1}`；遇到更高版本时
  同步失败且不发布，避免用旧脚本改写新结构。
- App 端在 manifest 声明的 `schemaVersion` 高于自身支持版本时拒绝替换目录、
  保留旧目录（见 `static-game-catalog` spec）。
- 新增字段属于向后兼容；删除或改变字段语义必须提升 `schemaVersion`。

## 1. `sources/sources.json`（人工输入）

唯一的人工维护入口。`games.json` 是生成产物，禁止手工编辑。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | integer | 是 | 当前为 `1` |
| `games` | array | 是 | 至少一个条目 |
| `games[].gameId` | string | 是 | 稳定、唯一、kebab-case；发布后不可复用或更改 |
| `games[].title` | string | 是 | 展示标题，≤ 120 字符 |
| `games[].titleCn` | string/null | 否 | 中文标题，≤ 120 字符 |
| `games[].platform` | string | 是 | 被重编译的原主机，取值见下 |
| `games[].runtimePlatforms` | string[] | 是 | 运行系统，至少一个，取值见下 |
| `games[].genres` | string/null | 否 | 类型，≤ 120 字符 |
| `games[].description` | string/null | 否 | 纯文本描述，≤ 2000 字符 |
| `games[].projectUrl` | string/null | 否 | http(s) URL；缺省时回退为仓库地址 |
| `games[].coverUrl` | string/null | 否 | http(s) URL |
| `games[].github.owner` | string | 是 | 仓库 owner |
| `games[].github.repository` | string | 是 | 仓库名 |
| `games[].github.branch` | string/null | 否 | `commit` 策略使用的分支；缺省时读取默认分支 |
| `games[].versionStrategy` | string | 是 | `release` / `tag` / `commit` |
| `games[].fallback` | string[]/null | 否 | 主策略取不到时的降级顺序，元素不得重复主策略 |
| `games[].tagPattern` | string/null | 否 | `tag` 策略的 glob 过滤，如 `v*` |
| `games[].enabled` | boolean | 是 | `false` 时跳过并排除出目录 |

- `platform` 允许值（与 App 的 `GamePlatformType` 对应）：
  `SWITCH`、`PS2`、`PS`、`PC`、`N64`、`GBA`、`XBOX`、`XBOX360`、`NGC`、
  `PSP`、`WII`、`N3DS`、`NDS`。
- `runtimePlatforms` 允许值：`windows`、`macos`、`linux`、`android`、`ios`。
  该字段必须人工维护：`tag` / `commit` 策略拿不到 release 资产，无法从产物可靠推导。

## 2. `catalog/games.json`（生成产物）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | integer | 与 sources 一致 |
| `games` | array | 按 `gameId` 升序稳定排序 |
| `games[].gameId` | string | 稳定标识 |
| `games[].title` / `titleCn` / `platform` / `runtimePlatforms` / `genres` / `description` / `projectUrl` / `coverUrl` | - | 直接来自人工字段，同步不覆盖 |
| `games[].source.owner` / `repository` / `url` | string | GitHub 坐标 |
| `games[].source.version` | string | 版本字符串（release tag、tag 名或短 commit） |
| `games[].source.versionType` | string | `release` / `tag` / `commit` |
| `games[].source.versionUrl` | string | 可点击的来源地址 |
| `games[].source.revision` | string | 来源 revision（commit sha 或 tag 名） |
| `games[].source.publishedAt` | string/null | ISO-8601 发布时间 |
| `games[].source.observedAt` | string | 该版本被首次观察到的时间（版本未变时保持不变） |
| `games[].source.status` | string | `ok` / `unavailable` / `error` |

规范化：UTF-8、`ensure_ascii=false`、2 空格缩进、末尾换行、`games` 按
`gameId` 排序。`contentSha256` 是对这些字节的 SHA-256。

## 3. `catalog/games.manifest.json`（生成产物）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | integer | 客户端兼容判断依据 |
| `catalogRevision` | string | 由内容哈希派生，如 `sha256-<16 hex>` |
| `contentSha256` | string | `games.json` 完整内容的 SHA-256 |
| `generatedAt` | string | 生成时间，仅用于诊断，不参与“是否更新”判断 |
| `gameCount` | integer | 条目数 |
| `dataUrl` | string | 相对地址，当前为 `games.json` |

客户端先比较 `catalogRevision` / `contentSha256`，只有变化时才下载完整目录。

## 4. `state/`（同步器内部状态）

- `state/last-known.json`：按 `gameId` 记录上一次已知版本字段与 `observedAt`，
  用于单仓库临时失败时保留 `lastKnown`。
- `state/last-run.json`：最近一次同步的运行报告（开始/结束时间、来源统计、
  请求数、限流剩余、是否生成新目录）。

这两个文件是同步器内部状态，不属于 App 消费的协议。
