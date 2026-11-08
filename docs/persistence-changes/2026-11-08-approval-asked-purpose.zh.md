---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-08-approval-asked-purpose

[English](2026-11-08-approval-asked-purpose.md) | 中文

## 概述

approval/asked 的 purpose 字段改为当前用途对象。该事件不再包含宿主输入采集。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-approval-asked-purpose
baseline: false
changes:
  - root: "event:approval/asked"
    previous: "2026-11-02-protected-input-approval"
    after: "3cd6c45914d5c48606d1c426ff75610cc4d023aa0d430b0b0384dfa44e661381"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有会话保留已记录的审批事件。读取方接受当前用途对象，不改写已存会话。

<a id="verification"></a>
## 验证

写入本记录后，pnpm exec tsx scripts/persistence-changes.ts --check 不再报告未确认的持久化类型变化。

<a id="dev-note"></a>
## 开发备注

无。
