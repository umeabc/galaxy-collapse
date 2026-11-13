# B 站抓取接口备忘

> 2026-11 实测（匿名）。所有请求都带浏览器 UA；可选配置 Netscape cookie（`SESSDATA`）。

## 1. 空间动态流

```
GET https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space
  ?host_mid=<mid>&offset=<cursor>&timezone_offset=-480&platform=web
  &features=itemOpusStyle&wts=<unix>&w_rid=<md5>
```

- **WBI 签名**：
  1. `GET /x/web-interface/nav` → `data.wbi_img.{img_url,sub_url}`。
     未登录时 `code=-101`，但 `wbi_img` 仍然有效（不要按错误处理）。
  2. 两个 URL 取文件名（去扩展名）拼接，按 64 位混淆表取前 32 位得到 `mixinKey`。
  3. 参数按 key 排序、URL 编码（去掉 `!'()*`），追加 `wts`，对 `query + mixinKey` 取 md5 得 `w_rid`。
- **指纹**：`GET /x/frontend/finger/spi` → `b_3` / `b_4`，作为 `buvid3` / `buvid4` cookie；
  再补 `b_nut=<unix>`。缺少 `buvid3` 会稳定触发 `-412 request was banned`。
- **软拦截**：匿名请求偶发 `code=0` 但 `items=[]`。客户端会重新签名并最多重试 4 次
  （600ms 起退避）；仍为空则记 `sync.empty` 警告，提示配置 cookie。
- **分页**：用返回的 `offset` 翻页；`has_more` 判断是否继续。工具每次同步最多取 3 页。

### item 结构（需要的字段）

```
item.id_str
item.type                  DYNAMIC_TYPE_DRAW / ARTICLE / WORD / AV / FORWARD ...
item.basic.jump_url
item.modules.module_author { name, mid, pub_ts }
item.modules.module_dynamic.desc.text
item.modules.module_dynamic.major:
  MAJOR_TYPE_DRAW    → major.draw.items[{ src, width, height }]
  MAJOR_TYPE_OPUS    → major.opus.{ title, summary.text, pics[{url,width,height}], jump_url }
  MAJOR_TYPE_ARTICLE → major.article.{ id, title, desc, covers, jump_url }
  MAJOR_TYPE_ARCHIVE → major.archive.{ title, desc, cover, jump_url }
```

## 2. 专栏列表

```
GET https://api.bilibili.com/x/space/article?mid=<mid>&pn=1&ps=20
```

匿名可用，返回 `data.articles[]`：
`id, title, summary, banner_url, publish_time, author{mid,name}, image_urls, words`。

## 3. 正文（opus / read SSR）

```
GET https://www.bilibili.com/opus/<opusId>
GET https://www.bilibili.com/read/cv<articleId>   → 302 到 opus
```

页面内嵌：

```js
window.__INITIAL_STATE__ = {
  detail: {
    id_str, type,
    modules: {
      0: MODULE_TYPE_TOP,
      1: MODULE_TYPE_TITLE,   // module_title.text
      2: MODULE_TYPE_AUTHOR,  // module_author.{name,mid,pub_ts}
      3: MODULE_TYPE_CONTENT, // module_content.paragraphs[]
      4: MODULE_TYPE_COPYRIGHT,
      ...
    }
  }
}
```

`modules` 在 JSON 里是对象（键 `"0".."6"`），按 `module_type` 取值更稳。

### 段落（paragraphs[]）

| para_type | 字段 | 处理 |
|---|---|---|
| 1 | `text.nodes[]`（`TEXT_NODE_TYPE_WORD/RICH/FORMULA/AT/EMOJI`） | 拼成文本 |
| 2 | `pic.pics[{url,width,height}]` | 图片块 |
| — | `heading{level}` | 标题块 |
| — | `list{style,items}` | 列表块（`style=2` 有序） |
| — | `blockquote` | 引用块 |
| — | `code` | 代码块 |
| — | `link_card{url,title}` | 链接块 |
| — | `line` | 分割线 |

## 4. 风控与 cookie

- `-352` / `-412` / `-509`：稍后重试或配置 cookie；`-412` 常见于 `buvid3` 缺失或 IP 被临时限制。
- 页面返回「出错啦」或空壳（无 `__INITIAL_STATE__`）时，客户端会重试一次，再报
  `BILI_RISK_CONTROL` / `BILI_PARSE_FAILED` 并给出配置 cookie 的提示。
- 建议导出 Netscape 格式，至少包含 `SESSDATA`、`buvid3`；工具会按 mtime 自动重载。

## 5. 限制

- 只处理图文动态、opus、专栏；视频动态保留封面与链接；转发默认跳过。
- B 站图片有防盗链：服务端下载时带 `Referer: https://www.bilibili.com/`；
  WebUI 预览走 `/api/proxy/image`（域名白名单）。
- 部分内容（付费、仅粉丝可见、已删除）会以明确错误落日志，不生成空草稿。


## 6. 订阅语义（galaxy-collapse 的 subscriptions）

- 每个订阅保存 `mid`、`mode`（`dynamic` / `article`）、`include_forwards`、`subscribed_at`。
- **硬下界**：只处理 `published_at >= subscribed_at` 的内容；`subscribed_at` 之前的一律跳过，
  因此「从增加订阅开始」是精确语义，不会补抓历史。
- 动态模式按 `offset` 向前翻页，直到某页最后一条的时间早于 `subscribed_at` 才停止；
  置顶的旧动态不会导致提前停止。
- 专栏模式按 `pn` 翻页，直到该页最后一条 `publish_time` 早于 `subscribed_at`。
- 已入库的 `source_key` 会跳过，不占单轮上限；达到 `syncMaxNewPerRun` 时标记 `truncated`，
  下一轮从未处理的内容继续。
- 转发动态在 `include_forwards=true` 时保留转发语 + 原动态文本/图片（`item.orig`）。
- 旧版单账号配置（`BILI_USER_MID` / 设置里的 `sourceMid`）在首次启动时迁移成一个
  「从现在开始」的订阅，然后清空旧字段。
