---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-02-protected-input-approval

[English](2026-11-02-protected-input-approval.md) | 中文

## 概述

新增 protected-input 显式 owner 审批用途，携带路径及原版本和候选版本摘要。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-protected-input-approval
baseline: false
changes:
  - root: "event:approval/asked"
    previous: "2026-11-02-workspace-write-approval"
    after: "bed5a8f779840c79899e36b28ce0246f886bc17d8f37353695fe594b6082eb4d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 workspace-write 记录保留原判别字段与其他字段。新用途由 type: protected-input 区分，不复用 workspace 字段，不隐含写入授权。审批审计记录仅作日志，不回放为授权。运行时 owner 决定使用经过认证的事件流，只有 allowed-once 授权消费方的确切候选版本。轮次之间的宿主流程保留被动收件消息，不产生要求包围在轮次内的审批审计事件。不修改 Session 格式常量。

<a id="verification"></a>
## 验证

受保护输入审批、profile HMR、完整性及浏览器审批聚焦集 54 项通过，覆盖 owner 允许与拒绝、无人值守被动收件、不同 owner 连接拒答、SDK 自动化交互拒答及审批期间候选替换。较大 boot 测试集仍有 95 项失败；本登记不声称宿主输入保护已完整。

<a id="dev-note"></a>
## 开发备注

无。
