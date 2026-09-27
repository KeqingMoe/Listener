# 配置参考

行为配置统一写在 `config.toml`。相对路径以该文件所在目录为基准，密钥来自选定的环境变量或同目录 `.env`。示例使用2空格缩进；支持多行内联表与尾随逗号。

配置、人设修改后需要重启。未知字段、错误类型和放错层级都会报错，包括未启用群中的错误配置。

## 检查与诊断

```sh
npm run config:check
npm run config:check -- --group 123456789
```

检查不联网、不创建数据库。第二条输出该群的最终策略和字段来源：`program_default` 为程序默认，`defaults` 为公共群策略，`group` 为本群覆盖。不会输出密钥或人设正文，但群号和路径仍可能敏感，不要直接公开检查结果。

`membership: not_checked` 表示检查没有验证 Bot 是否已加入该群；配置允许服务不等于群连接已经就绪。

## 应用级配置

以下字段对整个应用生效，不能写入 `defaults` 或群级配置。

| 段 | 字段 | 默认／含义 |
| --- | --- | --- |
| `bot` | `name` | `Listener` |
| | `owner_id` | 主人QQ，正整数字符串；启用群服务时必须显式填写，群聊不能修改 |
| | `owner_name` | `主人`，仅称呼，不作为身份判断依据 |
| `onebot` | `url` | `ws://127.0.0.1:3001`；支持ws/wss，不允许URL用户名、密码、查询参数或fragment |
| | `token_env` | `ONEBOT_ACCESS_TOKEN`，指定必填的OneBot密钥环境变量 |
| | `api_timeout_ms` | 10000 |
| | `reconnect_base_ms` / `reconnect_max_ms` | 1000 / 30000；最大不得小于基础 |
| | `heartbeat_ms` | 30000 |
| `model` | `base_url` | `https://api.openai.com/v1`；HTTPS或支持的本机HTTP地址，不允许URL凭证、查询参数或fragment |
| | `model` | **必填**，服务商提供的非空模型名称；模型须支持工具调用 |
| | `api_key_env` | `OPENAI_API_KEY`，指定**必填**的模型密钥环境变量 |
| | `timeout_ms` | 45000，范围1000..120000 |
| | `max_output_tokens` | 8192，安全正整数；单次模型输出预算，仍受服务商限制 |
| `runtime` | `max_concurrent_turns` | 2，范围1..8；全局同时运行的唤醒数，同一群不会并行唤醒 |
| `storage` | `directory` | `data`，分群及全局数据文件的基准目录 |
| | `telemetry_path` | `<directory>/telemetry.sqlite`，模型用量库 |
| | `registry_path` | `<directory>/group-registry.json`，Bot与面板共享的私有群清单，不含正文或密钥 |
| `logging` | `level` | info；可选debug/info/warn/error |
| | `console` | true |
| | `file` | 缺省开启；关闭用false，自定义用参数对象，不能写true |
| `logging.file` | `directory` | `<storage.directory>/logs` |
| | `retention_days` | 7，范围1..30 |
| | `max_file_mb` | 20，范围1..100 MiB |
| | `max_total_mb` | 200，范围1..1000 MiB，且不得小于单文件上限 |

OneBot毫秒参数的范围为1..2147483647。密钥变量名须为大写字母／数字／下划线组成的合法环境变量名称。`.env` 只接受选定的两个密钥名；同名进程环境变量优先。不要把凭证写进URL或TOML。

文件日志关闭写 `logging.file = false`；只改目录写 `logging.file.directory = "data/logs"`。关闭值不能与文件日志参数同时使用。多个选项可以组合为：

```toml
[logging]
level = "info"
file = {
  directory = "data/logs",
  retention_days = 7,
  max_file_mb = 20,
  max_total_mb = 200,
}
```

文件日志关闭后，可用 `npm run logs -- --directory 路径` 查看指定目录中已存在的日志。

## 群策略与继承

`defaults` 定义各群共用的策略，`groups."群号"` 覆盖某个群；没写的配置使用下表中的程序默认值。

| 字段 | 程序默认 | 含义与范围 |
| --- | --- | --- |
| `enabled` | false | false时只服务显式启用的群；defaults为true时服务Bot加入的所有群，群级false用于排除 |
| `persona` | `prompts/listener.md` | UTF-8人设文件路径，非空普通文件，最多16KiB；群级文件完整替换默认人设 |
| `reply.mention` | true | 被真正@时触发 |
| `reply.quote_bot` | true | 有效引用Bot消息时触发 |
| `reply.delay_ms` | [1200, 3000] | 合批等待区间；两个整数，下界0..5000，上界0..10000，上界不得小于下界；[0,0]不额外等待 |
| `reply.cooldown_ms` | 5000 | 范围1000..60000 |
| `reply.random` | false | 随机参与关闭；开启用参数对象，不能写true |
| `session.transport` | chat | chat或responses，须与模型服务匹配 |
| `session.max_transcript_bytes` | 524288 | 范围65536..8388608；本地模型会话容量，不是服务商的token窗口 |
| `session.compaction` | false | 服务端压缩关闭；参数形式为`{threshold_tokens}`，当前运行入口不支持启用，保持false |
| `execution.max_tool_calls_per_wake` | 96 | 范围1..4096；一次唤醒全部工具共享 |
| `execution.wake_timeout_ms` | 90000 | 范围1000..600000；一次完整唤醒的时间预算 |
| `messages.mentions` | true | 允许Bot发送成员@，不改变被@触发；不支持@全体或@自己 |
| `observation.reactions` | true | 后台反应观察；与添加回应、查询回应者的工具权限分别设置 |
| `confirmation.ttl_seconds` | 60 | 范围1..60，主人确认操作的有效期 |
| `history.retention_days` | 7 | 范围1..30；本地消息／事件保留天数，不控制服务商保留时间 |
| `storage.database` | 按群生成 | `<storage.directory>/groups/<群号>/listener.sqlite`；可指定属于本群的现有数据库 |
| `tools` | 见工具表 | 按真实工具名称独立授权 |

群号须为无前导零、无空白的正整数字符串。Bot必须真实加入目标群；群聊正文不能将其他群加入服务范围。私聊不服务。

### 怎样覆盖默认值

普通设置按字段继承，数组整项替换。`false`、`0`、`off` 都是明确配置，不会被当成“没写”。例如本群只写 `reply.mention = false`，其他回复设置仍继承 `defaults`。

以下三种设置按**完整功能**覆盖：

- `reply.random`
- `session.compaction`
- 每一个 `tools.<工具名>`

本群没有写这个功能时，完整继承 `defaults`。一旦写了，就替换该功能的整项配置；未写的参数使用该功能的程序默认值，**不继承被替换项的参数**。

```toml
[defaults]
reply.random = {
  probability = 0.2,
  cooldown_ms = 10000,
  max_per_minute = 6,
}

[groups."100000002"]
enabled = true
reply.random = false

[groups."123456789"]
enabled = true
reply.random.probability = 0.1
# 本群其余random参数采用程序默认：cooldown_ms为60000，max_per_minute为2。
```

随机参与开启后的参数为：`probability`（默认0.03，范围0..1）、`cooldown_ms`（默认60000，范围1000..3600000）、`max_per_minute`（默认2，范围1..10）。关闭写 `false`。

服务端压缩的参数形式为 `session.compaction.threshold_tokens = 65536`，要求responses和正整数阈值；**当前不可启用，运行入口会拒绝**，应使用 `session.compaction = false`。关闭值和参数对象不能同时写；chat模式不能配置压缩对象。

### 文件路径与数据保留

各群分别保存消息缓存、事件和模型会话。默认缓存路径为 `data/groups/<群号>/listener.sqlite`，事件和会话库分别在该路径后加 `.events.sqlite`、`.session.sqlite`。

已有本群数据库时，可显式指定：

```toml
[groups."100000002"]
enabled = true
storage.database = "data/listener.sqlite"
```

修改配置不会搬动、清空或重新归属数据库。程序检查各群数据库、全局用量库、群清单及SQLite附属文件的路径冲突，包括符号链接和硬链接；不要让多个群共用数据库。另外，设置日志目录时也应避开这些数据文件。

`defaults.storage.database` 设置的固定路径会被所有群继承，仅适合明确的单群用途；多群应分别覆盖，或使用自动生成的分群路径。

本地事实记录和模型会话是两种存储。重置或轮换模型会话不会删除本地事实；服务商会话有自己的保留规则。Responses续接失效时会重新建立会话，不自动重放已经执行的写操作。图片内容只暂存在内存，重启后需要重新读取。

## 工具权限与参数

- `direct`：模型可以在本群配置与QQ实际权限内自主执行。
- `confirm`：模型提出操作，由主人在同群发送 `/confirm CODE` 后执行。
- `off`：不向模型提供，执行层也拒绝。

只读及不支持确认的工具只接受 `off`／`direct`；其他工具可以使用三种模式。工具设置不接受布尔值。程序基础工具如发送消息、读取消息、结束唤醒和观察本群事件，不另设可选开关。

有配置参数时写对象，必须包含非off的 `mode`；没有配置参数时直接写模式字符串。关闭只写 `"off"`，不能附带参数。表中“配置参数”指TOML中可填写的资源限制，不是工具调用参数：目标成员、消息、正文等由Bot调用时填写，不写在这里。

### 工具类别

- **QQ功能**：对应QQ中的资料查询、互动、消息发送或群管理功能，由Bot账号通过NapCat操作，仍受QQ实际权限与接口支持情况限制。
- **Bot辅助**：为模型提供阅读、理解或后续关注能力，不是QQ客户端中的同名功能。辅助工具也可能通过QQ接口取得素材；分类不表示它完全离线。

例如，`send_group_ai_voice`调用的是**QQ的AI语音功能**，使用QQ提供的声线把文字发成语音，不是让本项目配置的模型生成音频；`view_images`则把可核验图片提供给**本项目配置的模型**理解，不是调用QQ的“AI识图”。两者名称里都可能涉及AI，但作用不同。

### 查询与阅读

| 工具 | 默认 | 支持confirm | 配置参数 | 类别 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `get_group_members` | direct | 否 | 无 | QQ功能 | 分页查看或搜索本群成员列表。 |
| `get_member_info` | direct | 否 | 无 | QQ功能 | 查询指定成员的昵称、群名片、角色等资料。 |
| `get_group_info` | direct | 否 | 无 | QQ功能 | 查询本群名称、人数、容量等资料。 |
| `get_group_honor` | direct | 否 | 无 | QQ功能 | 查询龙王、群聊之火等群荣誉；上游可能不支持或返回不完整数据。 |
| `get_group_mutes` | direct | 否 | 无 | QQ功能 | 查询本群禁言名单；空结果不一定证明无人禁言。 |
| `read_group_notices` | direct | 否 | 无 | QQ功能 | 读取群公告文字、发布者等信息，不展开公告图片。 |
| `read_group_essence` | direct | 否 | 无 | QQ功能 | 查看群精华消息列表及上游可提供的内容。 |
| `get_reaction_users` | direct | 否 | 无 | QQ功能 | 查询某条消息上某种表情回应的参与者，可核对指定QQ号。 |
| `get_group_ai_voices` | direct | 否 | 无 | QQ功能 | 查询QQ提供的AI语音角色／声线，供发送AI语音时选择。 |
| `get_group_file_space` | direct | 否 | 无 | QQ功能 | 查询群文件数量与空间信息；部分上游数值可能是占位值。 |
| `list_group_files` | direct | 否 | 无 | QQ功能 | 查看群根目录或指定文件夹的文件、目录及可操作引用，不保证列出全部文件。 |
| `list_group_requests` | direct | 否 | 无 | QQ功能 | 查看本群待处理的直接入群申请，需Bot有管理员权限；不显示邀请Bot加入其他群的请求。 |
| `view_images` | direct | 否 | `max_per_turn`默认3，范围1..3；`max_download_mb`默认10，范围1..10 | Bot辅助 | 读取本群可核验图片并提供给模型理解；需要模型支持原生图片输入。 |
| `read_forward` | direct | 否 | 无 | Bot辅助 | 按需展开合并转发供模型阅读，不会将内容转发到群里。 |
| `read_group_text_file` | direct | 否 | 无 | Bot辅助 | 下载并读取本群列表中选定文件的文本内容，不是PDF／Office等通用文档解析器。 |

### 互动、发送与关注

| 工具 | 默认 | 支持confirm | 配置参数 | 类别 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `react_message` | direct | 否 | 无 | QQ功能 | 给消息添加或取消Bot自己的表情回应，不是发送QQ原生表情消息。 |
| `poke_member` | direct | 是 | 无 | QQ功能 | 对指定群成员拍一拍／戳一戳。 |
| `group_sign` | direct | 是 | 无 | QQ功能 | 使用Bot账号在本群签到，不是创建定时任务。 |
| `send_group_image` | direct | 是 | 无 | QQ功能 | 把本群可核验的已有图片发到当前群，不生成新图片，也不接受任意URL。 |
| `forward_message` | direct | 是 | 无 | QQ功能 | 将一条可核验的本群消息原生转发到当前群。 |
| `send_group_forward` | direct | 是 | 无 | QQ功能 | 将多条可核验的已有消息合并转发，不伪造发送者或正文。 |
| `send_group_ai_voice` | direct | 是 | 无 | QQ功能 | 使用QQ的AI声线把文字作为语音发到本群，不是语音识别或本项目模型的音频生成。 |
| `manage_attention` | direct | 否 | `max_plans`默认16，范围1..32 | Bot辅助 | 管理后续关注计划，如关注下一条消息、指定成员或时间条件；不是QQ日程，也不保证无新消息时定点发言。 |

### 群管理与群文件写操作

| 工具 | 默认 | 支持confirm | 配置参数 | 类别 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `mute_member` | confirm | 是 | `max_seconds`默认600，范围1..600 | QQ功能 | 禁言指定群成员，时长必须为正且不超过配置上限。 |
| `unmute_member` | confirm | 是 | 无 | QQ功能 | 解除指定成员的禁言，不解除全员禁言。 |
| `recall_message` | confirm | 是 | 无 | QQ功能 | 撤回可核验的本群消息，受Bot实际QQ权限限制。 |
| `set_member_card` | confirm | 是 | 无 | QQ功能 | 修改成员在本群的群名片，不改其账号昵称。 |
| `set_group_name` | confirm | 是 | 无 | QQ功能 | 修改当前群的名称。 |
| `set_group_title` | confirm | 是 | 无 | QQ功能 | 设置或移除成员专属头衔，需要Bot为群主。 |
| `set_group_whole_mute` | confirm | 是 | 无 | QQ功能 | 开启或关闭全员禁言。 |
| `kick_member` | confirm | 是 | 无 | QQ功能 | 将成员移出本群，并明确是否拒绝其再次加群。 |
| `set_group_admin` | confirm | 是 | 无 | QQ功能 | 任命或取消群管理员，需要Bot为群主。 |
| `set_group_essence` | confirm | 是 | 无 | QQ功能 | 将可核验消息设为群精华。 |
| `remove_group_essence` | confirm | 是 | 无 | QQ功能 | 取消消息的群精华标记，不是撤回原消息。 |
| `publish_group_notice` | confirm | 是 | 无 | QQ功能 | 发布纯文字群公告。 |
| `delete_group_notice` | confirm | 是 | 无 | QQ功能 | 删除当前公告列表中核验存在的指定公告。 |
| `respond_group_request` | confirm | 是 | 无 | QQ功能 | 同意或拒绝通过申请列表核验的本群直接入群申请，不接受任意申请标识或其他群的请求。 |
| `upload_group_text_file` | confirm | 是 | 无 | QQ功能 | 把工具调用中提供的文字生成文本文件并上传到本群，不上传任意本机文件。 |
| `create_group_folder` | confirm | 是 | 无 | QQ功能 | 在本群群文件中创建目录。 |
| `delete_group_file` | confirm | 是 | 无 | QQ功能 | 删除本群文件列表中核验选定的文件。 |
| `delete_group_folder` | confirm | 是 | 无 | QQ功能 | 删除本群核验选定的群文件目录，不允许删除根目录。 |
| `leave_group` | off | 是 | 无 | QQ功能 | 请求Bot退出当前群；群主账号操作可能涉及解散风险，默认关闭。 |

### 基础工具（不单独配置开关）

这些也会提供给模型，但不写入 `tools` 配置表：

| 工具 | 类别 | 用途 |
| --- | --- | --- |
| `send_message` | QQ功能 | 向本群发送文字、QQ原生表情、引用回复和成员@；模型普通正文不会自动发到QQ。 |
| `read_message` | Bot辅助 | 读取本群已知消息或可核验直接引用，必要时通过QQ接口核验、补取内容。 |
| `get_wake_state` | Bot辅助 | 查看本轮为何被唤醒、当前身份、未读事件概况和执行预算。 |
| `get_time` | Bot辅助 | 查询当前时间。 |
| `read_events` | Bot辅助 | 读取本地保存的本群消息、撤回、成员变动等事件。 |
| `read_messages` | Bot辅助 | 读取本地保存的本群消息，不是任意QQ远端历史搜索。 |
| `ack_events` | Bot辅助 | 推进Bot已观察事件的位置，不是向QQ发送消息已读回执。 |
| `finish` | Bot辅助 | 结束本轮处理；可以不发言，结束后不再执行本轮工具。 |

已有显式模式会覆盖默认模式。`direct` 并不要求主人先发言，但也不授予QQ实际没有的权限；设置管理员和专属头衔等操作需要Bot具有群主权限。

工具参数也遵循整项覆盖：

```toml
[defaults.tools]
mute_member = {
  mode = "confirm",
  max_seconds = 120,
}

[groups."100000002"]
enabled = true
tools.mute_member = "direct"
# 本群完整替换mute_member配置，max_seconds采用程序默认600。
# 若希望仍限制为120秒，本群也需要写包含mode和max_seconds的对象。
```

确认操作只允许真实主人在同群、同登录身份下执行，默认60秒内有效，每群最多10个待确认项。确认时再次核验权限与目标；重置、断线、退出群或停止会清空待确认项。

`observation.reactions` 仅控制后台观察，即使开启也不能执行被关闭的回应工具；查询回应者不要求后台观察开启。看图、发送图片、读取转发和转发消息同样独立授权。

## 运行限制与结果含义

### 触发与资源预算

一次唤醒可以连续查询和操作，全部工具共享调用数与时间预算；非法调用、失败和缓存命中也消耗调用次数。主人之后的确认不属于模型额外工具调用。一次完整唤醒达到时间预算，不表示此前所有工具都失败，也不撤销已提交操作。

普通消息每条最多12个片段、800文字字符、3个成员@；不支持@全体或@自己。多人的请求会合批处理；进入本轮后的新消息由后续批次处理。普通文字里的CQ或媒体标记不会自动执行为操作。

关注计划可以等待下一消息、指定成员、指定时间或活跃度条件；多个条件满足任一个即可。没有未读消息时不额外调用模型；重置、断线或停止会清空运行期计划。

### 媒体与来源范围

- 看图需要模型原生图片能力。只读取本群可核验图片，下载限制大小和解码资源，并阻止访问私网地址；发送图片不代表模型已经看过它。
- 读取合并转发需明确范围；嵌套内容按需读取。转发内部的发送者声明不是当前发言者身份，不能据此获得管理权限。
- 单条转发和合并转发只接受本群可核验消息，不伪造发送者或正文。
- 群文件使用从本群列表取得的临时引用；内容读取与上传面向文本，不能让模型读取任意本机文件或上传任意路径。
- 公告发布仅支持纯文字；读取公告不会展开其中的图片。入群审批只处理本群真实待处理申请。
- reaction是消息下面的回应，QQ原生表情是消息内容。观察聚合数量不能证明某个人是否参与，需要查询回应者名单。
- 退群默认关闭；上游不能保证区分群主退群与解散，启用前须特别注意。

### 已提交、已核验与结果不明

| 结果 | 含义 |
| --- | --- |
| `executed` 或 `effect_confirmed=true` | 有可核验的效果依据，不表示收件人已读 |
| `ok` 且 `submitted=true`、`effect_confirmed=false` | 接口正常接受请求，但尚未核验最终效果；不是失败 |
| 明确拒绝 | 有明确失败依据，或请求在派发前被拒绝 |
| `unknown` | 超时、断线或异常响应等导致结果不明；可能已经生效，不能盲目重试或用逆操作试探 |

后续取消、沉默或回复失败不会撤销此前已经提交的操作。正常提交后不要仅因没有额外回执而补发。对于reaction，可以在查询可用时核对自身是否在回应者名单；该查询证明的是查询时状态，而不是补造原写操作的回执。

群荣誉、禁言名单、公告及精华列表等可能受上游获取失败或覆盖范围限制，空列表不一定代表不存在。NapCat 4.18.28的冒尖小萌新荣誉未实现，其他荣誉分类获取失败也可能返回空；公告列表可能漏掉部分分区。配置授权不保证上游接口成功或数据完整。

## 隐私与维护

模型按需读取本地群事实，读取的消息、图片与转发内容会发送给所选服务商。应事先告知群成员；本地数据保留配置不能替代服务商的保留政策。

日志不记录聊天正文、人设、模型内容、密钥或确认码，但可能包含QQ和消息ID。模型会话与工具执行账本包含私有恢复数据，不要公开数据目录或将其当作匿名统计。主人 `/reset` 不删除已保存的群消息与事件；`/ping`、`/help` 提供状态与帮助。
