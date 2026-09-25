# Listener

一个用 TypeScript 写的 QQ AI 猫娘，通过 OneBot v11 接入 QQ，使用支持工具调用的 OpenAI 兼容接口。

支持 @／引用接话、随机插话、群共享记忆、分条发送与真实 @，也能查询成员。禁言、撤回成员消息、改群名片需要主人确认，不提供踢人或修改群设置。

## 配置和运行

建议 Node.js 24+，并准备可用的 OneBot v11 WebSocket 服务。

```sh
npm ci
# 仅首次配置；不要覆盖已有文件
cp config.example.toml config.toml
cp .env.example .env
# 编辑配置、填写密钥，再把 config.toml 的 [ai] enabled 设为 true
npm run config:check
npm run build
npm start
```

- `config.toml`：模型、连接、触发概率、记忆与工具开关，不入库；注释见 `config.example.toml`。
- `.env`：仅放 OneBot Token 和模型 Key，不入库；也可用配置中指定名称的环境变量注入密钥，优先于文件。
- `prompts/listener.md`：人设与语气，入库。权限规则不放在人设里。
- 相对人设和记忆路径按 `config.toml` 所在目录解析。未知配置项或非法值会阻止启动，检查命令不联网、不创建记忆库。

旧版 `.env` 可用 `npm run config:migrate` 一次性迁移：保留实际参数，旧文件备份在 `data/config-migration.env.bak`；若已有 `config.toml` 则拒绝覆盖。运行时不再从环境变量读取行为参数。

修改配置或人设后重启 Bot，暂不热加载。开发用 `npm run dev`，测试用 `npm test`；不要同时启动多个实例。

## 图片

使用同一个 `[ai]` 模型的原生多模态能力，不配置第二个模型。模型需支持 Chat Completions 的 `image_url` 输入。

```toml
[images]
enabled = true
max_per_turn = 3
max_download_mb = 10
```

开启后可发图片并 @她，或引用图片消息再 @她。模型按需调用 `view_images`，程序将图片作为 Base64 `image_url` 内容块加入当轮请求，而不是让另一个模型转述。关闭时不暴露工具，也不下载、上传图片。

目前支持 JPEG、PNG、WebP、GIF（动画仅首帧）；单张最多10MiB、4000万像素，去除元数据并缩放到最长2048像素。仅获取可核验的本群附件和允许的 QQ HTTPS 图片地址，链接过期、下载失败或不支持的格式会返回不可读取错误，不允许猜图。数据库只保存图片ID和来源，不存原图、Base64或签名链接；原图仅当轮使用，之后需要时重新获取。

## 小提醒

- 仍只服务固定白名单群，私聊不处理；群和管理员必须与 `src/contracts.ts` 的安装边界一致。
- 工具开关只能收紧能力，管理确认不能取消，禁言上限不能超过600秒。
- `/ping` 检查在线，`/help` 查看帮助；主人可用 `/reset` 清空记忆、`/confirm 确认码` 确认操作。
- 随机回复默认概率3%，在 `[reply] random_probability` 调整；触发不保证发言。`reply.mention` 控制被@触发，`tools.mention` 控制发送@。
- AI 启用后，本群上下文会发送给模型服务商；启用图片后，按需查看的图片也会发送，请事先告知群成员。
- 本地记忆放在 `data/`；密钥、配置备份和数据库不要提交。
