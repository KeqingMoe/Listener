# Listener

通过 OneBot v11 接入 QQ 的 AI 群聊 Bot。支持 Chat Completions 与 Responses、按需读取群消息、多群独立会话，以及逐工具授权。

默认可以查询群信息、看图、读取转发、添加消息回应、拍一拍、签到、发送媒体，以及读取、查看、发送、添加、删除和标注Bot账号的自定义收藏表情；群管理与群文件写操作需要主人确认，退群关闭。只服务明确启用的群，默认不随机插话。

## 首次运行

准备 Node.js 24+、可用的 OneBot WebSocket 服务，以及支持工具调用的模型服务。看图还需要该模型支持原生图片输入。

```sh
npm ci
npm run faces:sync
# 仅首次配置；不要覆盖已有私有文件
cp config.example.toml config.toml
cp .env.example .env
# 编辑 config.toml：填写主人QQ、模型名称、服务地址和群号
# 编辑 .env：填写 ONEBOT_ACCESS_TOKEN、OPENAI_API_KEY
npm run config:check
npm run build
npm start
```

模型名称和模型密钥必填。检查配置不联网、不创建数据库；检查通过后仍需确保 OneBot 已登录、Bot 已加入目标群、模型服务可用。

传输统一配置在全局 `model.transport`：`"chat"`、`"responses"` 或 `{ type = "responses", incremental = false, }`。Responses字符串默认增量续接；对象中 `incremental` 必须显式为布尔值，`false` 使用完整上下文，`true` 启用增量续接。不支持chat对象、未知对象字段或旧的群级 `session.transport`；迁移时删除旧字段。支持多行内联表和尾随逗号，详见[模型传输](docs/configuration.md#模型传输)。

收藏添加的受控文件桥目前要求Linux/procfs。NapCat位于容器时，需要把Bot侧原图目录映射到容器并配置两侧路径；这不是手工维护QQ表情清单。详见[收藏原图目录与容器部署](docs/configuration.md#收藏原图目录与容器部署)。

- [首次运行示例](config.example.toml)
- [完整配置参考](docs/configuration.md)：全部字段、默认权限、继承与运行限制
- [只读面板说明](docs/dashboard.md)

配置、人设修改后先检查再重启；不支持热重载。不要让多个 Bot 进程同时使用同一数据库。

## 选择服务群

`defaults` 是所有群的默认策略，`groups."群号"` 只填写需要覆盖的设置：

```toml
[defaults]
enabled = false
persona = "prompts/listener.md"
reply.random = false

[groups."100000002"]
enabled = true

[groups."123456789"]
enabled = true
# 本群不提供踢人工具，不影响其他群
tools.kick_member = "off"
```

示例中的群号必须替换。默认 `enabled = false` 时只服务显式启用的群；改为 `true` 后服务 Bot 加入的所有群，并可用群级 `enabled = false` 排除特定群。私聊不服务。

各群的聊天记录、模型会话和权限独立。人设文件在群级设置后完整替换默认人设，不追加；人设不能改变程序权限。

## 工具权限

工具在 `defaults.tools` 或 `groups."群号".tools` 下按实际名称设置：

- **`direct`**：模型可以在配置授权和 QQ 实际权限范围内自主执行。
- **`confirm`**：模型提出操作，主人在同群发送 `/confirm CODE` 后才执行。
- **`off`**：不向模型提供，执行层也拒绝。

默认查询、互动、看图、媒体发送及自定义收藏六工具使用 `direct`（包含收藏添加、删除和修改描述）；禁言、撤回、修改群信息、精华和公告操作、入群审批等群管理写操作，以及群文件写操作使用 `confirm`；退群使用 `off`。共有48个可配置工具：29个direct、18个confirm、1个off。收藏发送及三个收藏修改工具也可显式设为confirm；列表和查看只支持off/direct。完整工具表见[配置参考](docs/configuration.md#工具权限与参数)。

例如，对所有群限制单次禁言时长：

```toml
[defaults.tools]
mute_member = {
  mode = "confirm",
  max_seconds = 120,
}
```

主人身份只取自全局 `bot.owner_id`，昵称和群聊内容不能修改权限。设置 `direct` 不会让 Bot 获得 QQ 本身没有授予的管理员或群主权限。

## 当前能力边界

- 普通消息支持文字、QQ 原生表情、引用及成员 @；**不支持 @全体或 @自己**。
- 历史读取以本地记录和可核验的消息引用为范围，不是任意远端历史搜索。
- 群消息图片只使用本群可核验来源；自定义收藏是Bot账号共享库，启用本群相关工具即授权访问，删除／改描述会影响其他群。图库自动索引，不需要手工清单；目录有界，不能保证列尽整个QQ账号。
- 收藏原图发送保留GIF/WebP字节，模型预览仅首帧；APNG本版拒绝。`view_custom_face`与`view_images`权限独立、共用视觉预算。收藏并非商城整套管理。
- 转发仅限可核验的已有消息，不伪造发送者。
- 群文件内容读取和上传目前面向文本；公告发布为纯文字。AI 语音发送不代表具有语音转文字能力。
- 关注计划用于后续群消息触发；没有未读消息时不会仅因计时到点额外调用模型。
- 不提供任意QQ API、任意本机文件读取、登录账号切换、好友关系管理或跨群聊天操作；共享收藏不授予其他群消息的访问权。

**接口接受请求不等于已经观察到效果。** “已提交”不是失败，也不是对方已收到或已读的证明。超时、断线等“结果不明”情况可能已经生效，不能盲目补发。群荣誉、公告等上游查询可能不完整，空列表不一定代表没有数据。详细限制见[配置参考](docs/configuration.md#运行限制与结果含义)。

## 日志与维护

```sh
npm run config:check -- --group 123456789
npm run logs -- --follow
npm run logs -- --level warn
```

群内维护命令：

- `/ping`、`/help`：状态和帮助。
- 主人 `/confirm CODE`：确认本群待执行操作，默认有效期60秒。
- 主人 `/reset`：重置本群模型会话和运行期状态，不删除已保存的群消息与事件。

默认数据目录为`data/`，聊天相关数据库按群独立，不能让不同群共用。收藏索引和操作账本则为全局库，按账号隔离；受控原图目录持久保留，不随`/reset`或聊天保留期限清除。配置参考说明了自定义路径、容量和保留边界。

## 只读 Web 面板

```sh
npm run dashboard:build
npm run dashboard:start
# http://127.0.0.1:3210
```

面板从 `.env` 的 `DASHBOARD_PASSWORD` 接受访问密码；未设置则拒绝访问，没有初始密码或在线改密功能。可审阅唤醒、模型内容、工具参数结果、响应链和运行事件；总览、唤醒、请求统一缓存命中率与模型TPS，并区分模型、工具和整轮耗时。业务数据只读，不调用模型、不连接 OneBot、不发送消息。访问应限制到受信任网络或HTTPS入口。使用与统计口径见[面板说明](docs/dashboard.md)，接入异常与恢复验收见[运行排障](docs/operations.md)。

## 开发与验证

源码目录和构建入口见[代码结构](docs/architecture/repository-layout.md)。Bot与面板共享Node模块，页面单独构建。

```sh
npm ci
npm run check:boundaries
npm test                    # 核心回归
npm run dashboard:test      # 面板接口与计算
npm run test:all            # 上述两组全部Node用例
npm run dashboard:build     # 类型检查、Node及页面构建
# 浏览器环境准备（仅首次或Playwright升级后；需要下载）
npx playwright install chromium
npm run dashboard:test:browser
```

测试不需要真实配置、聊天数据库、模型密钥或预装表情目录；HTTP／WebSocket用例只使用本地替身。浏览器测试还需要匹配的Chromium及系统依赖。

## 隐私

`config.toml`、`.env` 和数据目录均为私有文件，不应提交或公开。控制台与结构化运行日志虽不记录聊天正文和密钥，仍可能包含 QQ／消息ID；模型会话、工具账本和私有请求快照则包含正文等敏感内容。

被模型读取的群消息、图片、收藏表情及转发内容会发送给所选模型服务商，应事先告知群成员。仅接收到群消息不意味着立即发送给模型；但本地保留时间也不控制服务商的数据保留策略。
