# galaxy-collapse

> 以 [solar-eclipse](https://github.com/umeabc/solar-eclipse) 为原型重写的 **B 站 → GameKee wiki 文章** 发布台。
> 订阅 B 站账号，从订阅时刻起抓取它的全部新动态或专栏，转换成 GameKee `/ba/editor` 的编辑器格式，
> 经关键字 / AI 审核后进入队列发布；全程本地运行，SQLite 持久化。

## 与 solar-eclipse 的区别

| | solar-eclipse | galaxy-collapse |
|---|---|---|
| 来源 | danbooru / gelbooru / X 等图库 | B 站账号订阅（可多个，动态 / 专栏） |
| 目标 | 同人广场素材帖 `pictureSquare/add` | wiki 文章 `content/add`（`/ba/editor`） |
| 内容形态 | 图片 + 短简介 + 标签 | 富文本（段落/标题/列表/图片/链接） |
| 审核 | rating + 标签置信度 | 关键字规则 + 可配置提示词的 AI 审核 |
| 修改已发布内容 | — | 预留 `publications/:id/update`（`content/edit`） |

复用 solar-eclipse 的工程约定：Node ESM、SQLite、本地优先、凭证只从文件读取、
发布闸门（窗口 / 间隔 / 日限）、日志脱敏、设置热生效。

## 功能

### 1. 内核（`src/`）

- **B 站订阅抓取**
  - 多账号订阅：每个订阅记录「订阅时间」，只抓取该时刻之后发布的内容；支持动态（含转发原文）与专栏两种模式。
  - 空间动态流：`/x/polymer/web-dynamic/v1/feed/space`，WBI 签名 + `buvid3/buvid4` 指纹，空列表自动重试。
  - 专栏列表：`/x/space/article`（匿名可用）。
  - 正文：`/opus/<id>`、`/read/cv<id>` 的 SSR `__INITIAL_STATE__`，解析结构化段落。
- **内容转换**
  - B 站段落 → 统一 blocks（text / heading / image / list / quote / code / link / divider）
  - → Markdown（可编辑）
  - → GameKee Slate-like `content_json`（`editor_type=1`）或 HTML（`editor_type=0`）
  - 图片：下载（带 B 站 Referer）→ 华为云 OBS V2 签名直传 → `cdnimg-v2.gamekee.com`。
- **发布**
  - `POST /v1/protected/content/add` 新建、`content/edit` 覆盖更新、`content/detail` 回读。
  - 发布前校验：标题长度、图片数量/大小、Cookie 完整性、队列闸门。

### 2. WebUI（`public/`，无构建）

- 深色 / 浅色主题（`localStorage` 持久化）、桌面侧栏 + 移动端底部标签栏、响应式布局
- **队列**：状态卡片、今日配额、窗口、自动发布/审核开关；立即发布 / 重试 / 取消。
- **草稿**：按状态筛选；Markdown 编辑器 + 实时预览（图片经本地代理绕过防盗链）；审核 / 通过 / 拒绝 / 入队 / 发布。
- **日志**：级别 / 模块 / 关键字过滤，详情可展开。
- **手工加入**：粘贴 B 站专栏/opus 链接或直接写 Markdown。
- **设置**：订阅账号、GameKee、调度、审核五组配置，热生效；GameKee Cookies 可直接粘贴，也支持 Cookie 文件；提供 Cookie 与 AI 连通性测试。

### 3. 自动审核

优先级：**拦截词 > 强制人工词 > 通过词 > AI > 人工兜底**。

- 关键字命中即落结论（`REJECTED` / `APPROVED` / `NEEDS_REVIEW`）。
- 未命中且启用 AI 时，调用 OpenAI 兼容的 `/chat/completions`，提示词可在设置里改，
  支持 `{{title}} {{author}} {{sourceUrl}} {{content}}` 占位符。
- 模型必须返回 `{"decision":"approve|reject|review","confidence":0..1,"reason":"..."}`；
  低于 `aiMinConfidence` 的 `approve` 自动降级为人工。
- AI 失败时按设置回落：转人工（默认）/ 自动通过 / 自动拒绝。
- 编辑已保存的草稿会清空审核结论并回到「草稿」，避免旧结论放行新内容。

### 4. 预留：修改已有帖子

```http
POST /api/publications/:publicationId/update
{ "title": "可选", "markdown": "可选" }
```

不传正文时用草稿当前内容；服务端调用 `content/edit` 全量覆盖，
更新 `publications.last_pushed_at`。UI 在「已发布」草稿上有对应按钮。
另有只读接口 `GET /api/gamekee/articles/:id` 用于核对远端状态。

## 三服公告自动发帖

除 B 站订阅外，内置碧蓝档案 **日服 / 国际服 / 国服** 公告源：

- 只抓「今天之后」的公告，按发布时间升序生成草稿，按 `announcement:<source>:<id>` 去重。
- 日服、国际服经 AI 翻译为简体中文；国服直接转换。
- GameKee 草稿固定 `type=2`（公告），`tag=2/3/4`（更新/活动/情报），标题带 `【日服】`/`【国际服】`/`【国服】` 前缀。
- 官方公告默认自动通过；`autoPublish` 开启时自动排队发布。
- **定时抓取**：默认开启，按 `announcementSyncIntervalSeconds`（默认 3600 秒 / 1 小时）自动轮询三个源；公告页显示下次抓取时间，可在设置中关闭。
- 国际服必须配置公告代理；日服/国服直连，代理故障时自动回退直连。
- 图片上传自动适配腾讯 COS（`cdnimg-v2`）与旧华为 OBS（`cdnimg02`）；GameKee CDN 需要 Referer 防盗链。

WebUI「公告」页可查看三个源的状态、上次错误、立即同步与最近草稿；「设置 → 公告」维护代理、翻译提示词、自动通过和单轮上限。详见 [`docs/announcements.md`](docs/announcements.md)。

## 快速开始

要求：Node.js >= 20。

```bash
cd galaxy-collapse
npm install
cp .env.example .env
# 编辑 .env：填 BILI_USER_MID、GAMEKEE_COOKIE_FILE 等
npm start
# 打开 http://127.0.0.1:3100
```

也可以先不配置任何东西启动，只浏览 UI；同步/发布时才会报缺少配置。

### Cookie 准备

- **GameKee（发布必需）**：两种方式，设置页粘贴优先：
  1. **直接粘贴**（推荐）：`userToken=...; userUid=...; obs_client_params=...`，
     也支持 JSON 对象或 Netscape 多行文本；保存在 SQLite，接口只返回「已保存」状态。
  2. **Cookie 文件**：浏览器导出的 Netscape 文件路径。

  无论哪种方式，都必须包含：
  - `userToken`（JWT，同时作为 `Access-Token` 请求头）
  - `userUid`
  - `obs_client_params`（URL 编码 JSON，华为云 OBS 临时凭证；过期需重新导出）
- **B 站（可选）**：导出含 `SESSDATA` 的 Netscape cookie。匿名可抓公开内容，
  但 B 站会对匿名请求随机下发空壳页/空动态流，配置后更稳。

粘贴内容与文件路径都在「设置 → GameKee 目标」维护（数据库优先，热生效）；粘贴非空时优先于文件。

## 使用流程

1. 「设置 → 订阅账号」填 B 站 UID，选择「动态」或「专栏」，点「添加订阅」。
   **只抓取订阅时刻之后发布的内容**，历史内容请用「手工加入」。可开「定时同步全部订阅」。
2. 点「立即同步」，或在「手工加入」粘贴单篇链接。
3. 新草稿按设置自动审核；未通过的到「草稿」里改完再审核。
4. 通过后可「入队」（受窗口/间隔/日限约束）或「立即发布」（忽略限制，需确认）。
5. 发布结果与 GameKee 文章 ID 记录在队列/发布记录中；后续可从草稿页「更新已发布文章」。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3100` / `127.0.0.1` | 仅本机监听 |
| `DB_PATH` | `./data/galaxy.sqlite` | SQLite 路径 |
| `BILI_USER_MID` | 空 | 旧版单账号 UID：仅首次启动自动迁移为订阅（从迁移时刻开始） |
| `BILI_SOURCE_MODE` | `dynamic` | `dynamic` / `article` |
| `BILI_COOKIE_FILE` | 空 | 可选 Netscape cookie |
| `GAMEKEE_COOKIE_FILE` | 空 | 发布必需 |
| `GAMEKEE_GAME_ID` / `GAMEKEE_GAME_ALIAS` | `829` / `ba` | 请求头与 URL |
| `PUBLISH_TIMEOUT_MS` | `20000` | GameKee / OBS / 图片下载超时 |
| `MAX_TITLE_LENGTH` | `100` | 标题上限 |
| `AI_*` | — | AI 审核默认值，设置页覆盖 |

设置项（SQLite `settings` 表）优先于 `.env`，保存后立即生效。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 仪表盘：配额、窗口、Cookie 状态 |
| GET/PATCH | `/api/settings` | 读取（密钥掩码）/ 修改 |
| POST | `/api/settings/test` | `{"target":"gamekee"\|"bilibili"\|"ai"}` |
| POST | `/api/sync` | 立即抓取全部订阅（可传 `subscriptionId`） |
| GET/POST | `/api/subscriptions` | 订阅列表 / 新增订阅（`mid`、`mode`、`includeForwards`） |
| PATCH/DELETE | `/api/subscriptions/:id` | 启用/暂停、改名 / 删除订阅 |
| POST | `/api/subscriptions/:id/sync` | 只同步该订阅 |
| GET | `/api/drafts` | 草稿列表（`status`/`limit`/`offset`） |
| GET | `/api/drafts/:id` | 草稿 + 发布记录 + 预览 HTML |
| PATCH | `/api/drafts/:id` | 改标题/正文（重置审核） |
| POST | `/api/drafts/:id/review` | 重新审核 |
| POST | `/api/drafts/:id/approve` / `reject` | 人工结论 |
| POST | `/api/drafts/:id/queue` | 入队 |
| POST | `/api/drafts/:id/publish` | 立即发布（`force` 忽略闸门） |
| GET | `/api/queue` | 队列项 |
| POST | `/api/queue/:id/publish` / `retry` / `cancel` | 队列操作 |
| POST | `/api/queue/pause` / `resume` | 全局暂停/恢复 |
| POST | `/api/manual` | `{url|id, kind}` 或 `{title, markdown}` |
| GET | `/api/publications` | 发布记录 |
| POST | `/api/publications/:id/update` | **修改已有帖子** |
| GET | `/api/gamekee/articles/:id` | 远端文章核对 |
| GET | `/api/logs` | 日志查询 |

## 状态机

```
草稿: DRAFT → REVIEWING → APPROVED / REJECTED / NEEDS_REVIEW
                              ↓
                            QUEUED → PUBLISHING → PUBLISHED / FAILED
队列: QUEUED → PUBLISHING → PUBLISHED / FAILED（3 次退避重试）
```

- 发布失败：`30s / 60s` 退避，第 3 次落 `FAILED`；`AUTH_REQUIRED` 立即失败。
- 每日配额按设置时区的自然日计数（`published_day`）。
- 暂停 / 窗口外 / 间隔不足时，自动 tick 直接跳过，不会消耗重试次数。

## 安全与合规

- 默认只监听 `127.0.0.1`；状态变更接口校验 `Origin`。
- Cookie / token / API Key 不写日志、不回显（设置接口只给掩码）。
- 预览图片代理仅允许 `hdslb.com` / `bilibili.com` / `gamekee.com` 域名（防 SSRF）。
- 下载图片上限 30MB、单篇 30 张；编辑器只生成站点实测支持的块类型。
- **仅搬运获得授权或允许转载的内容**；默认自动追加「本文转载自 B 站 @作者，原文链接」，
  可在设置关闭，但请自行确认授权与目标站规则。

## 测试

```bash
npm test
```

覆盖：Markdown 往返、Slate 构造、B 站段落/动态/转发提取、SSR 解析、Cookie 文件与粘贴文本、订阅过滤/续跑/去重、
OBS 签名、关键字/AI 审核、审核流转、发布闸门、队列重试、HTTP API。

## 已知限制与验证状态

- GameKee 文章接口字段来自 2026-11 线上 bundle 逆向（`articleForm`、`savePage`、
  `content/add|edit`）以及 2026-10 的图片帖实测链路；**本仓库没有可用凭证，未做过真实文章发布**。
  首次使用请先用一篇测试草稿发布并在站点核对，再开启自动发布。
- `content/add` 的成功响应不带新文章 ID 时会记 `publish.no_content_id` 警告，需人工核对。
- 支持图文与专栏；视频动态只保留封面/链接，转发默认跳过（可开启，仅保留转发语）。
- 不支持 GameKee 编辑器的表格、投票、图鉴卡片、视频上传等高级块（可后续扩展）。
- 订阅只保证「订阅时间之后」的内容；订阅前的历史内容不会自动补抓（可用「手工加入」逐篇导入）。
- 单轮新建草稿有上限（默认 50）；达到上限会标记 `truncated`，下一轮继续抓取剩余内容。
- B 站匿名访问存在风控软拦截（空列表/空壳页），已做重试与明确错误提示，配置 Cookie 最稳。

## 目录

```
src/
  bili/       B 站客户端、WBI、页面解析、动态提取
  convert/    Markdown ⇄ blocks、Slate/HTML 生成
  gamekee/    GameKee API 客户端、OBS 直传
  review/     关键字规则、AI 审核
  services/   设置、同步、审核、发布、队列、闸门
  routes.js   HTTP API
  app.js      依赖装配
  server.js   入口
public/       WebUI
test/         node:test 测试
docs/         接口逆向与使用说明
tools/        命令行诊断
```
