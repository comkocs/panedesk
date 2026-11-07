---
kind: upgrade-guide
description: "本地凭据迁入私有目录，启动链接改为一次性，HTTP API 连接必须携带所有者 cookie。"
---

# 所有者私有存储与启动链接

[English](guide.md) | 中文

## 变更

默认凭据从 `$PANEDESK_HOME/.credentials.yaml` 迁至 `$PANEDESK_HOME/private/.credentials.yaml`。受限文件访问和进程不能读取父目录。自定义路径保持不变，父目录须专用且与工作区互不包含。显式 full-access 工具不受此限制。

启动链接五分钟后过期，只能交换浏览器 cookie 一次。`/connect` 要求所有者浏览器 cookie，而非启动令牌，并返回独立的 API Peer cookie。浏览器 cookie 默认持久保存 30 天，可通过 `cookieMaxAgeDays` 配置。已有 cookie 不会被撤销。新浏览器通过启动链接登录，无需终端确认；已有浏览器 cookie 在 Host 重启后仍然有效。

## 迁移

Windows Web 和非交互服务不再要求关闭确认的覆盖配置。移除过时的 `requireOwnerConfirmation` 设置，保留其他 connection 配置，包括从调用参数派生的 `trustedHosts`。降级时若未显式配置路径，旧版本既不会发现迁址后的凭据，也不会逆向迁址。

1. 私密备份凭据。启动时把默认凭据复制到 `private`，校验并同步后删除原件。相同副本允许重启；冲突会阻止启动并保留两份。自定义路径不迁移。
2. 将自定义凭据文件放入专用目录，与工作区及其他必须可读的根目录分离。不要创建所有者材料的硬链接副本。受限执行拒绝无法隔离的材料，不要仅为压下拒因切换 full-access。
3. 签名密钥迁址后重新登录。在五分钟内打开新的 CLI Web 链接。桌面把继承 IPC 传入的 cookie 保存在内存中，不要求终端确认。不得在模型可读的日志或参数中暴露链接或 cookie。链接过期或已消费后，请重启 Host。
4. HTTP API 客户端必须通过所有者控制的渠道取得浏览器所有者 cookie，再携带它请求 `/connect?interactions=none` 或 `answer`。返回的 API cookie 与浏览器存储分开保管。TypeScript 与 Python SDK 的 running-Host 凭据文件流程不变。
5. 若需调整浏览器 cookie 有效期，在 connection 配置设置正整数 `cookieMaxAgeDays` 并保留其余键；省略时保持默认的 30 天。重启并兑换启动链接，取得采用所配置有效期的 cookie。
6. 确认所有者登录及凭据解析正常、默认旧文档已移除、沙箱读取私有目录失败。回退前，为旧版本显式配置迁址后的文件路径；不提供自动降级迁址。
