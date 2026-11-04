---
kind: upgrade-guide
description: "本地凭据迁入私有目录，启动链接改为一次性，HTTP API 连接必须携带所有者 cookie。"
---

# 所有者私有存储与启动链接

[English](guide.md) | 中文

## 变更

默认凭据从 `$PANEDESK_HOME/.credentials.yaml` 迁至 `$PANEDESK_HOME/private/.credentials.yaml`。受限文件访问和进程不能读取父目录。自定义路径保持不变，父目录须专用且与工作区互不包含。显式 full-access 工具不受此限制。

启动链接五分钟后过期，只能交换浏览器 cookie 一次。`/connect` 要求所有者浏览器 cookie，而非启动令牌，并返回独立的 API Peer cookie。签名 cookie 保持配置的有效期。新浏览器要求 POSIX 控制终端确认，之后刷新干净页面。重启后可能需要重新登录。Windows Web 和非交互服务默认拒绝新登录。

## 迁移

Windows Web 和非交互服务要求在受保护配置里关闭新浏览器确认。Windows 发行包首次启动 Host 前会询问；接受后写入 `$PANEDESK_HOME/local.patch.yml`。否则拒绝新登录。手动叠加配置需要两个键，因为 connection 条目会替换整份配置：

```yaml
- id: connection
  config:
    requireOwnerConfirmation: false
    trustedHosts: !!js ctx.webStartup.trustedHosts
```

任何持有未使用启动链接者都可登录。请保护启动链接与 cookie；交互式 POSIX 使用应保留确认。撤销此选择时，移除覆盖条目或设置 `requireOwnerConfirmation: true`，然后重启。Windows 将再次拒绝新浏览器登录；此设置不会撤销已有 cookie。降级时若没有配置迁址后的凭据路径，旧版本会表现为没有已保存凭据；降级不会逆向迁址。

1. 保留仅所有者可读的凭据备份。启动时把默认路径凭据复制到 `private`，校验并同步后删除旧件。相同副本允许重启续接；冲突会阻止启动并保留两份供合并处理。自定义路径不会自动迁移。
2. 将自定义凭据文件放入专用目录，与工作区及其他必须可读的根目录分离。不要创建所有者材料的硬链接副本。受限执行拒绝无法隔离的材料，不要仅为压下拒因切换 full-access。
3. 升级后重新登录一次：浏览器签名密钥已迁址。在五分钟内打开新的 CLI Web 启动链接一次。桌面通过继承的 IPC 通道取得新的 cookie 并只在内存保存，不要求终端确认。不要发布启动链接，也不要把 cookie 复制到模型可读的日志或参数中。手动保留的链接过期或已消费后，请重启 Host。
4. HTTP API 客户端必须通过所有者控制的渠道取得浏览器所有者 cookie，再携带它请求 `/connect?interactions=none` 或 `answer`。返回的 API cookie 与浏览器存储分开保管。TypeScript 与 Python SDK 的 running-Host 凭据文件流程不变。
5. 确认所有者登录及凭据解析正常、默认旧文档已移除、沙箱读取私有目录失败。回退前，为旧版本显式配置迁址后的文件路径；不提供自动降级迁址。
