# 代码结构

## 源码

| 目录 | 内容 |
| --- | --- |
| `src/app` | Bot入口、每群实例装配与资源关闭 |
| `src/config` | 配置解析、校验、策略及群注册信息 |
| `src/contracts` | 身份、JSON、OneBot、消息、模型与工具接口 |
| `src/agent` | 唤醒编排、调度、合批、关注计划与消息缓存 |
| `src/agent/session` | 模型会话、唤醒记录与工具账本 |
| `src/onebot` | OneBot连接、身份与引用解析、表情目录 |
| `src/model` | Chat Completions与Responses客户端 |
| `src/world` | 群事实存储、事件摄取、消息表示与反应观察 |
| `src/tools` | 按能力分组的工具实现 |
| `src/observability` | 日志、遥测、请求诊断与运行事件 |
| `src/cli` | 配置检查、日志查询、表情同步命令 |
| `src/dashboard/server` | 面板认证、只读查询与HTTP路由 |
| `src/dashboard/contracts` | 面板前后端共用的数据类型和计算 |
| `src/dashboard/web` | Vue页面与Vite配置 |

`agent/listener.ts` 负责每群唤醒编排；提示词在 `agent/prompts.ts`，工具定义组合在 `agent/tool-definitions.ts`。`agent/memory.ts` 管理消息缓存和摘要，与 `world` 的事实库、`agent/session` 的会话账本是不同存储。

## 构建

`npm run build` 将Node源码从 `src` 编译到 `dist`，不包含前端；相对导入写 `.ts`，编译时改写为 `.js`。`npm run dashboard:build` 还会检查并构建Vue页面。Vite输出到 `dist/dashboard/web`，只清理该子目录。

| 入口 | 编译文件 |
| --- | --- |
| Bot | `dist/app/bot.js` |
| Dashboard | `dist/dashboard/server/index.js` |
| 配置检查 | `dist/cli/config-check.js` |
| 日志查询 | `dist/cli/logs.js` |
| 表情同步 | `dist/cli/sync-faces.js` |

## 测试

`tests/unit` 放单组件测试，`tests/integration` 放跨组件测试，`tests/protocol` 使用本地HTTP／WebSocket服务，`tests/browser` 放浏览器测试。合成数据在 `tests/fixtures`，测试工厂在 `tests/support`。

`scripts/test.mjs` 递归发现 `*.test.ts`，排除夹具、支持代码和浏览器目录。`npm test` 运行核心用例，`npm run dashboard:test` 运行Dashboard用例，`npm run test:all` 运行两组Node用例。浏览器测试使用 `npm run dashboard:test:browser`。

`scripts/check-boundaries.mjs` 检查TS与Vue脚本的依赖方向、相对导入和运行时环，区分类型导入与运行时导入。单独运行命令为 `npm run check:boundaries`。

## 代码风格

Prettier负责排版：行宽80、两空格缩进、单引号、分号、尾随逗号。ESLint负责代码规范与Prettier不管的空行：import块之后、多行的顶层函数/类/interface/type/enum/测试前后，以及多行类成员之间必须空一行，函数内部不强制；`if`与循环必须带花括号、使用 `===`、`import type`、`throw new Error(...)`、具名导出，源码禁止 `any`。标识符用英文；注释、文档、提示词与面向用户的文字用中文。

`npm run check` 依次运行格式检查、lint、依赖边界、类型检查与全部Node用例，合入前必须通过；`npm run build` 只编译，不做这些检查。
