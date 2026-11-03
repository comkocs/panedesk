---
description: "凭据文档位置与可中断恢复的迁址。"
kind: reference
---

# 所有者凭据存储迁址

[English](README.md) | 中文

## 范围

这是存储位置记录，不是 Session 类型变更。凭据 YAML 格式和凭据键保持不变；相邻 schema 描述迁址位置，不声称 Session schema 已改变。默认文档从 `$PANEDESK_HOME/.credentials.yaml` 迁至 `$PANEDESK_HOME/private/.credentials.yaml`。自定义路径保留原位置，其整个父目录受到保护。

## 恢复

启动时原子写入新件、核验字节并同步文件；POSIX 还会在删除旧件前同步私密目录及其在 home 中的目录项，随后再次同步 home。相同副本可以安全续接；冲突副本保留不动并阻止启动。Windows 不使用 POSIX 目录同步。中断夹具在每个被监测的文件系统操作完成后重启，模拟移除进程持有的锁，不代表硬件断电测试。

## 兼容性

新确认的浏览器会话在 Host 重启后可能需要重新登录。旧版本不会自动发现迁址后的文档：降级前须显式配置新路径。自定义凭据目录若与工作区或其他必需可读根重叠，会阻止受限执行；应将文件移入专用私密目录，不要仅为绕过拒绝而使用 full-access。服务方式运行的 Web 部署须在升级前配置确认策略，参见[升级指南](../../upgrade-guide/v0.2.1-rc.2/owner-private-storage/guide.zh.md)。
