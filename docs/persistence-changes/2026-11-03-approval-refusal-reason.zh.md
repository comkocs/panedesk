---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-03-approval-refusal-reason

[English](2026-11-03-approval-refusal-reason.md) | 中文

## 概述

为审批决定审计事件增加可选的具体策略拒绝原因。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-approval-refusal-reason
baseline: false
changes:
  - root: "event:approval/decided"
    previous: "2026-09-11-initial"
    after: "8e41e729609767fd1c3697ad5ab323068db7273ab48eabc49d5c55f03ec94c69"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

没有 reason 的已有事件仍有效。旧读取方保留原有 rejected 结果，可忽略新增的仅用于审计的字符串；新读取方接受字段缺失。此字段不授权动作，也不改变回放同意。事件判别值与结果词汇均不改变。

<a id="verification"></a>
## 验证

Windows owner 写入、平台默认、状态信任 locale、工作区权限界面及本地 ACL 授权定向检查共 5 文件 31 例通过。嵌套状态例断言 rejected 与具体双语原因。其他捕获失败保留 unavailable。

<a id="dev-note"></a>
## 开发备注

无。
