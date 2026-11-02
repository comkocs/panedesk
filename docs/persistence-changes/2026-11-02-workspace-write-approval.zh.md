---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-02-workspace-write-approval

[English](2026-11-02-workspace-write-approval.md) | 中文

## 概述

为 approval/asked 审计事件增加可选的 workspace-write 用途，记录请求持久授权的规范化目录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-workspace-write-approval
baseline: false
changes:
  - root: "event:approval/asked"
    previous: "2026-09-11-initial"
    after: "3cd6c45914d5c48606d1c426ff75610cc4d023aa0d430b0b0384dfa44e661381"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

旧审计事件没有 purpose，仍表示单次操作。旧读取方识别 approval/asked，并保留其 JSON 负载而不解释 purpose；此纯日志审计事件不会回放为授权，也不用于授予访问。沙箱策略读取独立的工作区授权记录，接受审批不追加 sandbox/mode 覆盖。不改变 Session 格式版本。

<a id="verification"></a>
## 验证

workspace-confirmation 与 ui-approval 两套测试共 49 例通过，覆盖持久化用途、无 sandbox/mode 覆盖、Loader 允许/拒绝组合、记录与 ACL 效果、撤销、取消、期限及真实 Gateway/Remotes 所有者流断连。现有 validateStoredEvents 读取方保留已知事件的 JSON 字段；授权解析读取 WorkspaceWriteAccess，不读取审批审计事件。

<a id="dev-note"></a>
## 开发备注

无。
