# Listener

一个用 TypeScript 写的 QQ AI 猫娘，通过 OneBot v11 接入 QQ，AI 使用支持工具调用的 OpenAI 兼容接口，不依赖现成 Bot 框架。

## 能做什么

- 被 @、被引用时接话，也能按概率随机参与聊天。
- 群共享记忆、自动摘要，支持分条回复、真正的 @ 和保持沉默。
- 查询群成员、成员资料和引用消息。
- 管理员确认后，可禁言、撤回成员消息、修改群名片；不提供踢人和修改群设置。

目前只服务一个白名单群，群号和管理员在 `src/contracts.ts` 中固定，私聊不处理。

## 运行

建议 Node.js 24+，需要可用的 OneBot v11 WebSocket 服务：

```sh
npm ci
# 首次配置才复制，已有 .env 不要覆盖
cp .env.example .env
# 填写 OneBot 密钥、AI 地址、模型和 Key，设置 AI_ENABLED=true
npm run build
npm start
```

开发用 `npm run dev`，测试用 `npm test`。配置项见 `.env.example`，修改后重启 Bot。不要同时启动多个实例。

## 小提醒

- `/ping` 检查在线，`/help` 查看帮助；管理员可用 `/reset` 清空记忆、`/confirm 确认码` 确认管理操作。
- 随机回复默认概率 3%，可在 `.env` 调整或关闭。触发不代表一定发言。
- AI 启用后，本群上下文会发送给配置的模型服务商，请事先告知群成员。
- 密钥和数据库不要提交；Listener 的本地记忆默认放在 `data/`。
