# Listener 只读控制台

独立于 Bot 的 Vue 3 + TypeScript 控制台。Fastify 提供 API，使用只读 SQLite 连接读取现有指标和工具执行账本；不会启动 Listener、连接 OneBot、调用模型或发送群消息。

## 开发与构建

从仓库根目录执行：

```sh
npm ci
npm run dashboard:dev
# 开发页面 http://127.0.0.1:5174，API http://127.0.0.1:3210
```

```sh
npm run dashboard:build
npm run dashboard:start
# 生产页面与API同源：http://127.0.0.1:3210
```

服务从仓库根目录读取现有 `config.toml`／`.env`，只使用配置中启用群的数据库位置；AI关闭的启用群仍可查看历史。使用通用 `--host`、`--port` 参数选择监听地址；也支持 `DASHBOARD_HOST`、`DASHBOARD_PORT` 环境变量，命令行优先。代码不区分公网、局域网或Tailscale。

```sh
npm run dashboard:start -- --host 192.168.1.5 --port 8080
npm run dashboard:start -- --host 100.64.0.1 --port 3210
npm run dashboard:start -- --host  # 监听所有IPv4网卡（0.0.0.0）
```

默认仍为 `127.0.0.1:3210`。开发代理默认连接3210，如改开发API地址，需同步修改Vite代理。

面板与 Bot 构建产物分别位于 `dist-dashboard/` 和 `dist/`。面板开发进程结束会一起停止其 Vite 和 API 子进程，不影响 Bot。

## systemd 联动

`deploy/qqbot-dashboard.service` 使用独立进程管理面板，`WantedBy=qqbot.service` 让Bot启动时拉起面板，`PartOf=qqbot.service` 让Bot停止／重启时同步处理面板。面板崩溃只重启面板，不重启Bot。安装前按机器修改用户、路径和ExecStart的 `--host` 地址。

```sh
npm run dashboard:build
sudo install -m 0644 deploy/qqbot-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qqbot-dashboard.service
# 查看状态／日志
systemctl status qqbot-dashboard.service
journalctl -u qqbot-dashboard.service -n 50
# 仅更新面板：构建后单独重启它
sudo systemctl restart qqbot-dashboard.service
```

## 页面

- **总览**：模型请求数、输入和输出 tokens、缓存命中率及覆盖率、时间趋势和分群统计。
- **唤醒记录**：按群及时间筛选，分页查看记录；详情显示模型请求、工具执行状态与耗时。
- **工具统计**：调用次数、完成、错误、跳过、结果不明及耗时分位数。

筛选保留在 URL 中，支持24小时、7天和最多31天的自定义区间；默认不自动轮询，可开启每30秒刷新。单次统计超过10000条样本时明确要求缩小范围，不用部分数据伪装总计；单次详情最多展示500个模型请求和500个工具调用，并提示截断。唤醒列表每页最多30条（API最多100条）。

空数据、数据源缺失和请求失败分开展示；未记录的数据不会通过猜测补全。

## 安全边界

面板没有独立登录功能，默认只监听本机。可通过 `--host` 选择受信任的内网接口，网络访问权限由防火墙／内网ACL控制。当前部署监听 `100.64.0.1:3210`，直接通过Tailscale内网访问，不使用Serve或Funnel。应用保留同源校验与只读方法限制；通配监听允许IP形式的Host，不接受任意域名，以降低DNS重绑定风险。

若保持默认本机监听，也可使用 SSH 转发：

```sh
ssh -L 3210:127.0.0.1:3210 user@host
# 在自己电脑打开 http://127.0.0.1:3210
```

不要把这个无认证只读面板直接反向代理到公网。“只读”不等于“数据公开”：群号、活跃时间、模型用量同样可能敏感。

API 仅提供运行元数据，不返回消息正文、完整工具参数／结果、模型提示词、图片、checkpoint、密钥或数据库路径。初版详情是执行元数据时间线，而不是原始聊天回放，更不是模型内部思考。

## 统计口径

- 输入 token 已包含缓存输入；推理 token 若有也是输出的子集，不能重复相加。
- 缓存率按已知输入和缓存字段的请求加权；同时显示覆盖率。
- 未缓存输入仅根据字段完整的样本计算，不能把缺失缓存字段当成零命中。
- 历史唤醒未记录触发原因时显示未知。结束记录不一定代表成功发送，不能把正常结束标成“已回复”。
- 模型请求通过会话消息中保存的 `request_id` 与指标库关联，而不是假设模型会话的 wake ID 等于运行日志的 turn ID。未进入会话记录的失败请求可能只在总览中出现，不应伪造其唤醒归属。
- 工具次数不等于底层 OneBot 请求次数。没有新增 RPC 追踪，也没有成本或节省金额估算。

## 验证

```sh
npm run dashboard:typecheck
npm run dashboard:test
npx playwright install chromium
npm run dashboard:test:browser
npm test
```

后端测试使用临时合成数据库；浏览器测试模拟 API，不读取生产聊天记录。
