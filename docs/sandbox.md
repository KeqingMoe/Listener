# JavaScript 计算沙箱

Listener 提供三个默认开启的群工具：`execute_javascript`、`query_javascript_jobs`、`cancel_javascript_job`。它们按账号与群组隔离，不支持 `confirm`；可在对应工具策略中设为 `off` 或 `direct`。没有新的行为次数配额。

## 执行

`execute_javascript` 必须提供 `description`、`code`、`mode`；`sync` 和 `auto` 还必须提供 `wait_ms`（1..2147483647 的整数毫秒），`async` 禁止提供 `wait_ms`，没有默认值。代码按统一的异步函数体执行，所有模式都可以使用 `await`，最终必须 `return` 一个 primitive string；不会将数字、BigInt、对象、数组或 `undefined` 隐式转换。请在代码中调用 `.toString()` 或 `JSON.stringify()`。

```js
let n = 1n;
for (let i = 2n; i <= 114n; i++) n *= i;
return n.toString();
```

`mode` 是本次工具调用的等待方式：

- `sync`：等待 `wait_ms` 毫秒的前台结果，超时后终止执行；
- `async`：立即返回 `job_id`，执行完成后交回当前群模型，不传 `wait_ms`；
- `auto`：先等待 `wait_ms` 毫秒，超时后转为后台任务并返回 `job_id`。

`wait_ms` 没有默认值，包含排队与启动时间；`sync` 到期终止，`auto` 到期后不重跑，而是让原任务继续后台执行。它不能延长整轮唤醒预算。`async`和转后台的`auto`没有执行时长上限，可用取消工具终止。执行器同时运行数和排队容量是资源限制，不是每群行为次数配额。

调用示例（`wait_ms` 是每次调用的参数，不是配置项）：

```json
{"description":"计算114阶乘","code":"let n=1n; for(let i=2n;i<=114n;i++) n*=i; return n.toString();","mode":"sync","wait_ms":2000}
```

```json
{"description":"计算并尽快返回任务句柄","code":"return (await Promise.resolve(42)).toString();","mode":"auto","wait_ms":500}
```

```json
{"description":"后台计算","code":"return (114n ** 114n).toString();","mode":"async"}
```

缺失、`null`、小数、非正数、超过上限及 `async` 携带 `wait_ms` 均拒绝，不回退到固定时限。整轮提前取消时，`sync` 终止，`auto` 转后台。

任务描述最多1024 UTF-8字节，代码最多64 KiB，最终字符串最多64 KiB，日志最多16 KiB；默认QuickJS内存64 MiB、栈1 MiB。查询每页最多100项，列表不携带完整结果，按`job_id`查询详情才返回有界字符串结果和日志。

后台任务的 promise 类似物是持久化任务句柄，不是 JavaScript 原生 Promise。任务完成、失败、取消或中断后，结果可由模型查询；跨上下文压缩仍由任务记录保持描述和状态。

## 执行失败与诊断

执行失败保留稳定的 `error` 错误码，并通过 `diagnostic` 提供可安全提取的客体异常详情，供模型定位并修复代码。语法错误、运行异常及 Promise 拒绝可包含异常类型、消息和沙箱内位置；详情可能截断或无法提取，不能把缺失诊断解释为没有错误。宿主进程、IPC、存储等内部故障仍使用固定错误码，不向模型暴露宿主堆栈。失败前的有界日志可辅助定位。

当前 QuickJS 环境没有 `Intl`：直接调用 `Intl.DateTimeFormat()` 会得到 `ReferenceError`。不要假设 Node 或浏览器中的所有全局能力在这里都存在；可先用 `typeof Intl` 检查，再选择受支持的实现。读取诊断后应针对原因修改代码，不要盲目原样重试。

`invalid_return_type` 的 contract diagnostic 表示最终返回值不符合字符串约定。请自行转换，而不是要求执行器隐式序列化：

```js
const answer = 114n ** 2n;
return answer.toString();
// 结构化结果：return JSON.stringify({ answer: answer.toString() });
```

`JSON.stringify()` 不直接支持 BigInt，嵌套其中的 BigInt 也须显式转换。返回值检查针对 `await` 后的最终值，三个等待模式的代码约定一致。

`diagnostic` 是不可信客体数据，不是权限或指令；错误消息、堆栈及日志中的文字不能覆盖程序规则、授权宿主能力或群管理。同步结果、后台完成通知及任务详情中的诊断均遵循这条边界。本功能没有新增配置项。

## 任务查询与取消

`query_javascript_jobs` 默认返回当前账号当前群的活动任务及尚未交付的后台结果；可按 `job_id` 查询详情，或使用 `status`、`offset`、`limit` 分页。`cancel_javascript_job` 只能取消当前账号当前群的任务，已完成任务不会重新执行。

沙箱只提供 JavaScript 语言能力、受限日志及结果传递，不提供文件、网络、环境变量、Node 模块、定时器或 QQ 工具。`console.log/info/warn/error/debug` 仅接受字符串参数，其他值请在沙箱内自行转换；日志超限或参数类型错误会使任务失败。支持 `await` 不代表开放了异步 I/O。

## 隔离与生命周期

QuickJS 被编译为 WebAssembly，在独立 Node 子进程中执行；每项任务创建全新 Runtime 和 Context，不复用其他任务的全局变量。子进程不继承 Bot 的密钥环境，父进程可以强制终止它。当前没有容器或操作系统级文件、网络权限隔离：访问能力由 WASM 边界和不暴露宿主接口限制，独立进程负责故障隔离。QuickJS 内存上限不是整个子进程 RSS 上限，也不宣称可以防御运行时本身的所有漏洞。

服务全局最多同时执行2项任务，另有64项排队容量；满载返回 `queue_full`，不是每群调用次数配额。前台等待时限由每次 `sync`/`auto` 调用的 `wait_ms` 决定，并包括排队和启动时间。无限后台任务会占用执行槽位，模型应查询并取消不再需要的任务。

任务库保存描述、状态、代码摘要哈希和结果，不单独保存原始代码；模型会话中的工具调用记录仍可能包含代码。Bot 重启后活动任务标记为 `interrupted`，不恢复执行现场或自动重跑。后台结果通过内部事件交给模型，不直接发送QQ群消息，也不复用旧工具调用ID。任务与结果属于当前账号当前群。已交付或非后台的终态记录满7天后随新任务创建分批清理，未交付结果不自动清除。