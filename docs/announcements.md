# 三服公告自动发帖

支持碧蓝档案 **日服 / 国际服 / 国服** 官方公告，抓取「今天之后」的公告，生成 GameKee `type=2`（公告）草稿。

## 公告源

| 源 | 列表接口 | 详情 | 分类 → tag |
|---|---|---|---|
| 日服 | `https://api-web.bluearchive.jp/api/news/list?typeId=0&pageNum=50&pageIndex=1` | 列表已含 `content` HTML | メンテ→2 更新；イベント→3 活动；お知らせ→4 情报 |
| 国际服 | `https://forum.nexon.com/api/v1/board/3352/threads?...` | `/api/v1/thread/{id}?alias=bluearchivetw` | 固定 2 更新 |
| 国服 | `https://bluearchive-cn.com/api/news/list?pageIndex=1&pageNum=50&type=1` | 列表已含 `content` HTML | 标题关键词：维护/更新→2；活动/招募→3；其他→4 |

- 国际服必须走代理（直连 403）；日服/国服可直连。
- 抓取范围：按设置时区（默认 `Asia/Shanghai`）只处理 `dateKey(publishTime) >= 今天` 的公告。
- 去重键：`announcement:<source>:<externalId>`；已入库不会重复建草稿。
- 单轮每源上限由 `announcementMaxItemsPerRun` 控制（默认 10）。

## 翻译

- 日服/国际服用现有 AI 配置（OpenAI 兼容 `/chat/completions`）翻译为简体中文。
- 提示词 `announcementTranslatePrompt`，占位符 `{{source}} {{title}} {{markdown}}`。
- 模型返回 `{"title":"...","markdown":"..."}`；丢失的图片会补回末尾。
- 国服不翻译。
- 翻译失败不会生成半成品草稿，会在源卡片显示错误，下一轮重试。

## 发布

- 草稿固定 `type=2`（公告），`tag` 为 2/3/4（更新/活动/情报），标题前缀 `【日服】`/`【国际服】`/`【国服】`。
- 官方公告默认自动通过（`announcementAutoApprove`）；`autoPublish=true` 时自动入队。
- 发布成功返回 `https://www.gamekee.com/ba/{id}.html`；公告页/草稿页均提供链接。
- 图片上传：GameKee `getObsCredential` 返回腾讯 COS 临时凭证时使用 COS V5（`cdnimg-v2.gamekee.com`）；旧华为 OBS 凭证使用 `cdnimg02.gamekee.com`。
- `cdnimg-v2` 有防盗链：下载/预览必须带 `Referer: https://www.gamekee.com/` 与浏览器 UA，否则 567。

## 设置

- `announcementProxy`：公告抓取代理（国际服必需）。
- `announcementSyncIntervalSeconds`：调度间隔（默认 900 秒）。
- `announcementTranslate`：日服/国际服 AI 翻译开关。
- `announcementAutoApprove`：官方公告自动通过。
- `announcementMaxItemsPerRun`：单轮每源上限。
- `announcementTranslatePrompt`：翻译提示词。

## API

- `GET /api/announcements` → 源状态与最近公告草稿
- `POST /api/announcements/sync`（`{"source":"jp"|"global"|"cn"}` 可选）
- `PATCH /api/announcements/sources/:key`（`{"enabled":true|false}`）
- `POST /api/settings/test` `{"target":"proxy"}`
