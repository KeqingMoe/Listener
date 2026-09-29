# 产物（artifact）

产物是Bot本地保存、带期限的二进制内容，用于把沙箱或模型生成的数据交给需要文件的QQ工具。三个工具默认 `direct`，不支持 `confirm`，本身没有QQ副作用：

- `create_artifact`：`name`、`description`、`ttl_ms`、`content`（字符串按UTF-8保存，或字节），可选 `media_type`（默认 `application/octet-stream`，不按内容推断）；
- `create_image`：把 `width`×`height` 的RGBA `pixels`（长度 w·h·4，宽高各不超过8192）按 `format`（`png`/`jpeg`/`webp`，必填）编码为图片产物；
- `list_artifacts`：新到旧列出本群未过期产物，可选 `offset`/`limit`。

`ttl_ms`（1..86400000，即最长24小时）与 `description` 均为必填。直接调用时字节字段写成0..255的整数数组；沙箱代码内使用 `Uint8Array`，详见[计算沙箱](sandbox.md)。

## 使用产物

- `send_group_image` 可用 `artifact_id` 代替 `image_id`；产物须能解码为 png/jpeg/webp/gif，否则返回 `not_an_image`。
- `view_images` 的 `image_ids` 可包含图片产物的 `artifact_id`。
- `upload_group_file` 把产物上传为群文件，群文件名即产物 `name`，可选 `folder_handle`。默认 `confirm`，确认通知展示文件名、说明、大小及SHA256前8位。

两者都把NapCat侧的绝对路径交给NapCat读取，不经OneBot传输base64内容。

## 存储

元数据在 `<storage.directory>/artifacts.sqlite`，内容在 `storage.artifact_directory`（默认 `<storage.directory>/artifacts`），文件只以产物ID命名，经独占临时文件、fsync、rename原子写入，写入后只读。NapCat按 `storage.napcat_artifact_directory` 下的同名路径读取；容器部署须把两者映射到同一实际目录，见[配置](configuration.md)。

产物按账号与群隔离。单个最大64 MiB，全部产物合计最大2 GiB；超出分别返回 `artifact_too_large`、`artifact_storage_full`，不会提前淘汰未过期产物。到期产物不再可见，文件每10分钟及每次写入前清理。读取时校验大小与SHA256，文件被替换或损坏返回 `artifact_unavailable`。
