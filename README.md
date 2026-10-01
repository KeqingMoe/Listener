# Listener

Listener 致力于把 QQ 群聊的原生功能完整交给模型使用：看图、读合并转发、引用与@、表情回应、收藏表情、戳一戳、群文件、公告与群管理等，都以工具形式提供，由模型按需调用。QQ 功能接得越完整，Bot 能做出的反应就越接近真人：配合人设提示词，它可以像群友一样自己翻看上下文，选择用文字、表情、回应还是戳一戳来接话，而不只是一问一答。

- 按需读取群消息，多群各自独立的聊天记录、模型会话和权限
- 工具逐个授权：可让模型自主执行、需主人在群内确认，或完全关闭
- 另有一次性提醒、联网搜索和 JavaScript 计算沙箱
- 只读 Web 面板，可审阅每次唤醒的模型请求、工具调用和用量

本项目最初为自用而写，整理后开源。使用前请注意：

- 项目处于 0.x 阶段，版本间可能包含破坏性变更，包括配置格式、数据库结构和工具行为，升级前请阅读提交记录
- 代码和文档大量由 AI 编写，虽有测试覆盖，仍可能存在未发现的问题，请审慎评估后使用
- 只在 NapCat v4.18.28 上测试过

## 运行要求

- Node.js 24+
- 已登录 QQ 的 OneBot v11 WebSocket 服务（NapCat）
- 支持工具调用的模型服务，Chat Completions 或 Responses 协议；看图需要模型支持图片输入

## 快速开始

```sh
npm ci
npm run faces:sync
# 仅首次配置；不要覆盖已有私有文件
cp config.example.toml config.toml
cp .env.example .env
# 编辑 config.toml：填写主人QQ、模型和要服务的群号
# 编辑 .env：填写 ONEBOT_ACCESS_TOKEN，以及各模型 api_key_env 指定的密钥
npm run config:check
npm run build
npm start
```

`npm run faces:sync` 从 NapCat 下载 QQ 表情数据。这份数据受 NapCat 许可约束，不随本仓库分发。

默认只服务 `config.toml` 中显式启用的群，不服务私聊，不随机插话。全部配置项与工具权限见[配置参考](docs/configuration.md)，其余文档在 `docs/` 目录。

## 开发

```sh
npm run check   # 格式、lint、依赖边界、类型检查与全部 Node 用例
npm run format  # 按 Prettier 统一排版
```

- 提交前 `npm run check` 必须通过
- 测试不需要真实配置、数据库或密钥，只用本地替身；不要在代码、测试或文档中写入真实 QQ 号、群号或聊天内容
- 提交信息使用[约定式提交](https://www.conventionalcommits.org/zh-hans/v1.0.0/)，推荐用中文写说明

## 隐私

`config.toml`、`.env` 和数据目录是私有文件，不要提交或公开。模型读取的群消息、图片和转发内容会发送给所选模型服务商，应事先告知群成员。

## 许可证

[MIT](LICENSE)。`npm run faces:sync` 下载的 NapCat 表情数据不在此许可范围内。
