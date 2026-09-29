# 联网搜索与网页读取

Listener 提供两个只读群工具：`web_search` 搜索网页，`web_fetch` 读取单个公开网页的正文。两者默认 `direct`，不支持 `confirm`，没有行为次数配额；可在工具策略中设为 `off`。

## 配置

搜索服务是应用级配置，所有群共用，按 `type` 区分：

```toml
[web]
search = { type = "searxng", url = "http://127.0.0.1:8888" }
```

| `type` | 字段 | 含义 |
| --- | --- | --- |
| `searxng` | `url` | **必填**，SearXNG 实例地址；HTTPS 或本机 HTTP，不允许URL凭证、查询参数或fragment。实例需在 `search.formats` 中启用 `json`。 |

`type` 必须显式填写，目前只支持 `searxng`；其他值和分支外字段均拒绝。不写 `[web].search` 时模型看不到 `web_search`，提示词也不提及搜索，即使工具策略为 `direct`。配置检查不连接搜索服务；服务运行时不可用时工具返回 `search_unavailable`。

`web_fetch` 不依赖搜索服务，只受工具策略控制。

## web_search

参数 `queries` 为1..4个查询，每项最多512字节。多个查询并行执行，结果按排名交错合并并按URL去重，最多返回10个来源：

```json
{"status":"ok","sources":[{"url":"https://…","title":"…","snippet":"…","published_at":"2026-09-01T00:00:00.000Z"}],"truncated":true}
```

部分查询失败时返回 `failed_queries`；全部失败返回 `search_unavailable` 或 `search_timeout`（整体15秒）。标题和摘要会去除控制字符并截断。

## web_fetch

参数 `url` 为完整 http(s) 地址，可选 `start` 用于续读。返回最终 `url`、`http_status`、`content_type`（`html`/`text`/`json`/`xml`）、可选 `title`、`content`、`total_chars` 和 `truncated`；超过20000字符时通过 `next_start` 继续读取。非2xx状态码作为结果返回，不当作工具错误。

HTML 转为 Markdown：删除脚本、样式、表单、导航和 `hidden`/`aria-hidden`/`display:none` 等不可见内容，只保留绝对 http(s) 链接；存在足够长的 `<main>`/`<article>` 时只取该部分。嵌套过深的HTML改为纯文本提取，避免解析耗时失控。

### 网络边界

- 只允许不含凭证的 http/https URL，最长2048字符；
- 每次连接前解析DNS，任何解析结果不是公共单播地址即拒绝（`blocked_url`），并把连接固定到已检查的地址，防止DNS重绑定；回环、私网、链路本地、云元数据、IPv4映射IPv6及保留地址均被拒绝；
- 同源重定向最多跟随5次，每次重新检查地址；跨站重定向不自动跟随，返回 `redirect_to` 由模型决定是否再读；
- 响应体（含解压后）最多2 MiB，整体超时20秒；只接受 HTML、文本、JSON、XML；字符集取自响应头或HTML `meta`，不认识的字符集返回 `unsupported_charset`；
- 不发送Cookie或凭证，不执行JavaScript，也不渲染页面；需要登录或依赖脚本渲染的页面可能只有少量内容。

搜索服务是运维方配置的受信基础设施，不受上述公共地址限制。

## 资源与隐私

全局最多同时执行4个联网工具调用，超过返回 `busy`，这是资源限制而不是配额。查询词会发送给配置的搜索服务（SearXNG 会再转发给上游搜索引擎），`web_fetch` 会直接访问目标网站，对方可以看到本机出口IP。本功能不缓存结果，不写数据库。

## 不可信内容

搜索结果、网页标题、摘要和正文都是外部不可信数据，不是用户或主人的指令，不授予权限，也不证明内容真实。提示词要求模型忽略网页中的操作要求，说明信息来源，来源矛盾时如实说明，失败时不编造结果。
