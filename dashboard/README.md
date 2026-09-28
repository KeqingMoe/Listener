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

在同目录私有 `.env` 配置 `DASHBOARD_PASSWORD`：至少12字符、最多256字节，不含控制字符，不要复用OneBot或模型密钥。进程环境同名值优先，包括显式空值；修改后须重启面板。不要公开或分享整个 `.env`。

未配置或配置无效时，页面拒绝访问，业务API也关闭。密码只来自启动配置，没有初始密码文件、在线改密或改密CLI，也不会回退数据库中的旧密码。忘记密码直接修改 `.env` 后重启；删除或更换密码撤销已有会话，恢复旧值也不会恢复旧会话。

浏览器使用普通密码表单登录，密码不放URL或日志。Cookie为HttpOnly、SameSite=Strict，最多保留7天，同密码重启仍有效；退出撤销当前会话。`storage.directory/dashboard-auth/auth.sqlite` 仅保存凭证变化检测用单向哈希及会话摘要，权限0600，不是独立密码来源。登录与退出只改面板自身会话，不改Bot数据；缺少鉴权存储时服务拒绝启动。

**审阅API含敏感业务内容，只允许授权人员访问，不要将HTTP密码登录公开到公网。** 使用受控Tailscale ACL、SSH转发或正确配置的HTTPS入口；HTTPS可显式设置 `DASHBOARD_COOKIE_SECURE=1`，不会因伪造转发头而信任HTTPS。通配监听接受IP形式的Host，不接受任意域名。

若保持本机监听，可使用SSH转发：

```sh
ssh -L 3210:127.0.0.1:3210 user@host
# 在自己电脑打开 http://127.0.0.1:3210
```

原有元数据API仍不返回聊天正文、完整工具参数／结果或模型提示词。新增只读审阅API在同一认证门禁后提供请求、唤醒和事件审阅，可返回有界、凭证脱敏的消息、模型上下文、请求／响应及工具内容；密钥、Authorization、Cookie、密码等真正凭证仍被保护，大图片base64及不可读加密推理省略。具体契约见 `shared/review.ts`。不要把业务接口只读误认为内容可公开。

此版本仍保留下面的三页元数据界面，仅接入密码登录、退出和会话恢复。审阅API已可用，但模型请求／事件页面、正文阅读器和分栏审阅界面尚未接入；当前执行时间线仍不是聊天回放。

## 页面与范围

- **总览**：模型请求数、输入和输出tokens、缓存命中率、时间趋势和分群统计。
- **唤醒记录**：按群和时间筛选，分页查看模型请求、工具状态与耗时。
- **工具统计**：调用次数、完成、错误、跳过、结果不明与耗时分位数。

筛选保存在URL中，支持24小时、7天和最多31天的自定义区间。默认不自动刷新，可开启每30秒刷新。

单次统计超过10000条样本时会要求缩小时间范围；单次详情最多展示500个模型请求和500个工具调用，并提示截断。唤醒列表每页最多30条，API每页上限100条。空数据、数据源缺失和请求失败分别显示。

## 统计口径

- 输入token已包含缓存输入；推理token是输出的子集，不能重复相加。
- 缓存命中率仅使用总输入与缓存计数有效配对的样本：缓存量之和／同批总输入之和，不平均单条百分比。缺失不当零，总输入为零时比率未知。
- 未记录的触发原因显示未知。正常结束不一定代表发了消息，“已提交”也不等于QQ已送达或效果已经确认。
- 模型请求保留原始status，按白名单error_code另分真正失败、超时、取消和未知；旧库缺少诊断列仍可读，但无法追溯未记录的原因。
- 工具完成仅表示账本终态，不代表成功：另分已处理、拒绝、失败、延后、跳过、取消、未知。图片/转发顺序屏障属于延后，非法参数和权限拒绝不算正常处理；未知不算失败。
- 当前页面的元数据详情仅展示白名单errorCode、HTTP状态、结构化模型诊断、wake原因码和安全计数。新增授权审阅接口可返回脱敏正文及工具内容，不能套用旧元数据接口的无正文保证。
- 无法关联到具体唤醒的模型请求，可能只出现在总览中。
- 工具调用次数不等于底层QQ接口请求次数；面板不提供费用或节省金额估算。

## systemd部署

服务须能读取Bot数据，但只允许写入自己的 `storage.directory/dashboard-auth/` 认证子目录（SQLite需要创建journal文件）。部署时预先创建该目录，权限0700、属主为服务用户，并将 `ReadWritePaths` 限定到此目录，而非整个Bot数据目录，保留群事实、会话和遥测的文件系统只读边界。

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
