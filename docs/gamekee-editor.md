# GameKee `/ba/editor` 文章发布接口备忘

> 来源：2026-11 抓取线上 SPA bundle（`main.cb270d4c.js`、`6207.*.js`）并对照 2026-10 的图片帖实测链路。
> **状态：文章 `content/add|edit` 未在真实账号上验证**；图片 OBS 直传与 Cookie 鉴权已在图片帖链路实测通过。

## 路由与组件

```
/:gameAlias/editor  →  name: "editor"
  component: Promise.all([8508, 2993, 6207])
```

`6207` chunk 里的编辑器页面（模块 2801）就是 `/ba/editor`。

## articleForm 默认值（新建）

```js
{
  editor_type: 1,                 // 1 = wiki 富文本（Slate-like），0 = HTML
  game: { game_id: "" },          // 提交时填数字 game_id（BA = 829）
  seo: { desc: "", key: "", title: "" },
  server_id: 0,
  content: "",                    // editor_type=0 时使用
  content_json: "",               // editor_type=1 时使用
  model_ids: "",
  summary: "",
  thumb: "",                      // 前 3 张图，逗号分隔，协议相对 URL
  image_list: [],                 // 全部图片，协议相对 URL
  title: "",
  video: null,
  type: 4,                        // 4 = 综合，2 = 公告，8 = 情报，17 = 提问，19 = 视频
  tag: "2",                       // type=4 时：2 = 默认，9 = 安装教程；type=2 时 2/3/4
  content_type: 0,
  is_admin: 0,
  force_release: false
}
```

## 保存流程（savePage）

1. `syncEditorContent()`：
   - `editor_type=1`：从 wiki 编辑器取 `children` → `content_json = JSON.stringify(children)`；
     `thumb` = 前 3 张图；`image_list` = 所有图；`summary` = 纯文本前 150 字；`is_image_text` 视块类型而定。
   - `editor_type=0`：从 HTML 编辑器取 `content/thumb/image_list/video_list/summary`。
2. 新建 → `POST /v1/protected/content/add`；已有 `id` → `POST /v1/protected/content/edit`。
3. 成功响应 `{ code: 0, data: { id } }`，前端用 `data.id` 跳转 `/<alias>/<id>.html`。
4. 冲突：`code=100011` 表示他人刚发布过（可用 `must_post=true` 强制覆盖）；
   `100012/100013` 为违禁内容风控，会返回 `riskHtml`。

## content_json 结构（实测样例）

```json
[
  {
    "type": "paragraph",
    "customClass": null,
    "lineHeight": "",
    "textAlign": "start",
    "indent": "0px",
    "children": [
      { "color": "", "bold": false, "bgColor": "", "text": "正文", "fontSize": "18px" }
    ]
  },
  {
    "type": "header2",
    "customClass": null,
    "lineHeight": "",
    "textAlign": "start",
    "indent": "0px",
    "children": [{ "color": "", "bold": false, "bgColor": "", "text": "小标题", "fontSize": "18px" }]
  },
  {
    "type": "bulleted-list",
    "children": [
      { "type": "list-item", "children": [{ "type": "paragraph", "children": [{ "text": "要点" }] }] }
    ]
  },
  {
    "type": "paragraph",
    "children": [
      { "text": "" },
      {
        "type": "image",
        "key": "O3RhTP0kOVyskwX7",
        "src": "//cdnimg-v2.gamekee.com/wiki2.0/pro/829/images/w_1200/h_800/399789/2026/11/12/xxxx.jpg",
        "alt": "",
        "isAdaptive": true,
        "style": { "width": "1200px", "height": "800px" },
        "children": [{ "text": "" }]
      },
      { "text": "" }
    ]
  },
  {
    "type": "paragraph",
    "children": [
      { "text": "" },
      { "type": "link", "url": "https://www.bilibili.com/opus/123", "children": [{ "text": "原文链接", "fontSize": "18px" }] }
    ]
  }
]
```

支持的块类型（bundle 渲染 switch）：`paragraph`、`header1..5`、`numbered-list`、
`bulleted-list`、`list-item`、`image`、`link`、`divider`、`table`、`grid`、`tabs`、
`vote`、`battle-array` 等。本工具只生成前 8 种，避免未验证结构。

## 请求头

```
Cookie: <www.gamekee.com 的浏览器 cookie>
Access-Token: <cookie 中 userToken 的值>
game-id: 829
game-alias: ba
device-num: 1
X-Requested-With: XMLHttpRequest
Lang: zh-cn
Content-Type: application/json;charset=utf-8
```

仅 Cookie 不足以通过 protected 接口（返回 401「请先登录」）；必须带 `Access-Token`。

## 图片上传（OBS）

- 凭证：cookie 可来自设置页粘贴文本或 Netscape 文件（粘贴优先）；`obs_client_params`（URL 编码 JSON）中的 `access_key_id` / `secret_access_key` /
  `security_token` / `bucket_name` / `server` / `path.image`。
- 签名：OBS V2（HMAC-SHA1），`x-obs-date`、`x-obs-security-token` 参与签名。
- 对象 key：`wiki2.0/pro/<gameId>/images/w_<w>/h_<h>/<uid>/<Y>/<M>/<D>/<rand10>.<ext>`
  （Y/M/D 不补零）。
- 公开地址：`https://cdnimg-v2.gamekee.com/<key>`；编辑器内使用协议相对 `//cdnimg-v2.gamekee.com/<key>`。
- 403/401 常见于临时凭证过期：重新导出 cookie 即可。

## 本项目的映射

| 本地字段 | GameKee payload |
|---|---|
| 草稿标题 | `title`（≤ `maxTitleLength`） |
| Markdown → `buildSlate` | `content_json`（`editor_type=1`） |
| Markdown → `buildHtml` | `content`（`editor_type=0`） |
| 图片（OBS 上传后） | `image_list`、`thumb`（前 3 张）、image 节点 `src` |
| 纯文本摘要 | `summary` |
| 设置 `gamekeeType` / `gamekeeTag` | `type` / `tag` |
| 设置 `gamekeeGameId` | `game.game_id`（数字） |

## 验证状态

- ✅ Cookie → `Access-Token` 鉴权、OBS 直传、`cdnimg` 可访问：2026-10 图片帖链路实测。
- ✅ `articleForm` 字段、`savePage` 行为、`content/add|edit`、`content/detail`：2026-11 bundle 逆向。
- ❌ 未凭空账号实际提交文章；首次发布请人工核对，并优先使用一篇测试草稿。
