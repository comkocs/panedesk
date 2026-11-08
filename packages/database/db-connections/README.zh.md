# PostgreSQL 连接

宿主端管理用户数据库连接。本包不会把 Panedesk 自身存储迁移到 PostgreSQL；存储适配器可以使用下面的宿主接口。

## 使用方式

打开 **设置 → Panedesk → 数据库连接**，添加名称唯一的连接，粘贴 `postgres://用户:密码@主机:端口/库名` 或填写分项。PostgreSQL 除主机、端口和密码外，还需要用户名和库名。缺省端口 `5432`，用户名和库名 `postgres`，SSL、SSH、模型查库均关闭。本地地址以 Panedesk 宿主机器为准，不是浏览器机器。无需 MCP 服务。

开启 SSL 会要求可信服务器证书。数据库端口不对外时，勾选 **经 SSH 连接**，填写 SSH 服务器、端口（缺省 `22`）和用户，并选择宿主上的私钥路径。未加密私钥可不填口令。此时数据库地址和端口从 SSH 服务器访问。文件选择器只列宿主路径，不上传或复制私钥。可先测试未保存表单，再保存。修改时密码、口令留空会保留原值，明确勾选清除才删除。

## 配置与凭据

非秘密项原子写入 `$PANEDESK_HOME/database-connections.json`（缺省根目录 `~/.panedesk`）。插件 `filename` 可覆盖路径。设置页显示绝对路径并提供打开按钮。连接名称唯一，改名保留 id，模型访问缺省关闭。连接串在浏览器拆解，不以 URL 形式存盘。目录解析器拒绝未知字段，包括误写的明文密码字段。

密码与私钥口令通过 `ctx.credentials` 保存，记录键为 `db-connections/db-<uuid>`，类型 `api-key`，密码在 `key`，口令在 `env.SSH_PASSPHRASE`。缺省凭据提供者将其存入 `$PANEDESK_HOME/private/.credentials.yaml`，沿用现有私有文件保护。这与模型提供商凭据是同一存储，不是新增加密保险箱。浏览器读取接口不返回秘密，设置 RPC 要求认证所有者。

## 宿主接口

`ctx.databaseConnections.listConnections(): Promise<DatabaseConnection[]>` 列出元数据；`getConfig(id: string): Promise<DatabaseConnection>` 按 id 取配置；`open(id: string, signal?: AbortSignal): Promise<OpenDatabaseConnection>` 解析凭据并返回 `{ client: pg.Client, close(): Promise<void> }`，调用方须在 `finally` 关闭；`close(id: string): Promise<void>` 关闭该 id 的所有活动句柄。设置页通过生成的 Remote 方法使用 `inspect`、`save`、`remove`、`test`、`browseKeys`。`test` 用 `SELECT 1` 探测并始终释放连接。

SSH 只在开连接或测试时启动，绑定仅回环可用的随机端口，转发至配置中的数据库地址。关闭句柄、取消、传输断开、删除连接及卸载插件均释放套接字和转发。仅加载插件不会连接数据库或 SSH。

## 模型体验

本包自身不增加提示词或工具。独立 SQL 消费者只暴露用户明确开启模型访问的连接。元数据读取不消耗模型 token 或 KV 缓存；SQL 工具变化和结果会消耗。

## 已知限制与后续工作

现有 SSH helper 包要求版本匹配的远端运行时，因此这里使用可移植 `ssh2` 实现。支持私钥认证，未提供 SSH 密码登录、多跳、主机密钥固定或 known-hosts 管理、自定义 SSL 证书表单。请在可信 SSH 网络使用，或在本功能之外核验 SSH 端点。SSL 证书须被 Node 信任。URL 仅接受支持的 `sslmode` 参数，其他参数会拒绝而非静默忽略；除 disable 外均开启证书验证。外部修改 JSON 后须重载服务来刷新模型连接名称列表；执行时仍会重新检查目录。同一工具调用的多条 SQL 共用连接，不同调用不共享事务。
