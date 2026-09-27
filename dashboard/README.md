# Listener 只读面板

查看模型用量、唤醒记录和工具执行情况。面板独立于 Bot 运行，只读已有数据，不连接 OneBot、不调用模型、不发送群消息。

## 构建与启动

完成仓库根目录的配置和依赖安装后，在根目录执行：

```sh
npm run dashboard:build
npm run dashboard:start
# http://127.0.0.1:3210
```

服务读取根目录的 `config.toml`／`.env`，使用 `storage.telemetry_path` 和各群 `storage.database` 对应的会话数据。它不会创建、改写或删除群历史数据库。

显式配置中启用的群，即使 Bot 已停机，仍可查看已有历史。全部群模式下的其他群，通过 Bot 写入的私有 `storage.registry_path` 清单发现；清单每30秒更新、120秒过期，过期后不再依赖它展示动态群。所有群仍按当前启用策略过滤，禁用群不可见。

## 监听地址与访问安全

默认只监听 `127.0.0.1:3210`。使用 `--host`、`--port` 可选择受信任的内网地址；也支持 `DASHBOARD_HOST`、`DASHBOARD_PORT` 环境变量，命令行优先。

```sh
npm run dashboard:start -- --host 192.168.1.5 --port 8080
npm run dashboard:start -- --host  # 监听所有IPv4网卡（0.0.0.0）
```

**面板没有登录认证，不要直接公开到公网。** 内网访问同样应由防火墙或网络访问控制限制。“只读”不等于“数据公开”：群号、活跃时间、模型用量都可能敏感。通配监听接受IP形式的Host，不接受任意域名。

若保持本机监听，可使用SSH转发：

```sh
ssh -L 3210:127.0.0.1:3210 user@host
# 在自己电脑打开 http://127.0.0.1:3210
```

API仅返回运行元数据，不返回聊天正文、完整工具参数／结果、模型提示词、图片、密钥或数据库路径。执行时间线不是聊天回放，也不是模型内部思考。

## 页面与范围

- **总览**：模型请求数、输入和输出tokens、缓存命中率及覆盖率、时间趋势和分群统计。
- **唤醒记录**：按群和时间筛选，分页查看模型请求、工具状态与耗时。
- **工具统计**：调用次数、完成、错误、跳过、结果不明与耗时分位数。

筛选保存在URL中，支持24小时、7天和最多31天的自定义区间。默认不自动刷新，可开启每30秒刷新。

单次统计超过10000条样本时会要求缩小时间范围；单次详情最多展示500个模型请求和500个工具调用，并提示截断。唤醒列表每页最多30条，API每页上限100条。空数据、数据源缺失和请求失败分别显示。

## 统计口径

- 输入token已包含缓存输入；推理token是输出的子集，不能重复相加。
- 缓存率按已知字段的请求加权，并显示字段覆盖率；缺失缓存数据不视为零命中。
- 未记录的触发原因显示未知。正常结束不一定代表发了消息，“已提交”也不等于效果已经确认。
- 无法关联到具体唤醒的模型请求，可能只出现在总览中。
- 工具调用次数不等于底层QQ接口请求次数；面板不提供费用或节省金额估算。

## systemd部署

`deploy/qqbot-dashboard.service` 让面板随 Bot 启动、停止或重启。面板崩溃只重启面板，不重启 Bot。安装前按机器修改服务文件中的用户、路径和 `ExecStart` 监听地址。

```sh
npm run dashboard:build
sudo install -m 0644 deploy/qqbot-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qqbot-dashboard.service
systemctl status qqbot-dashboard.service
journalctl -u qqbot-dashboard.service -n 50
```

只更新面板时，重新构建后单独执行：

```sh
sudo systemctl restart qqbot-dashboard.service
```

## 本地开发预览

```sh
npm run dashboard:dev
# 页面 http://127.0.0.1:5174，API http://127.0.0.1:3210
```

开发代理默认连接3210端口，更改开发API地址时也需调整代理。开发进程结束会同时停止它启动的页面与API进程，不影响 Bot。面板构建产物在 `dist-dashboard/`，Bot构建产物在 `dist/`。
