---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-08-after-tools-input

[English](2026-11-08-after-tools-input.md) | 中文

## 概述

为待处理 Agent 输入增加可选 afterTools 调度元数据，允许排队提示词进入完整工具步骤后的下一请求，最终回答则保留下一轮投递。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-after-tools-input
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-29-subagent-report-paths"
    after: "8d28dd42eb03b986f5326f2544eb9f9e443868554b53004fa29e1c49dadba340"
    decision: same-version
  - root: "event:agent/input/transition"
    previous: "2026-10-22-message-delivery"
    after: "74ec79de4358fd720eefa4dd9d41d619a7ea0066e0507862e5651e46b3a970b9"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

afterTools 为可选字段，缺失时保留下一轮排队语义，因此新读取器接受旧记录。旧读取器忽略新增调度属性，继续把 queue 优先级消息留到下一轮；可能延迟投递，但不会取消活跃工具、遗漏面向模型的输入或改变排队内容的解释。原有优先级、被动、唤醒、身份及最早轮次字段保持不变。不修改会话格式版本或操作编号。

<a id="verification"></a>
## 验证

已人工阅读 Inbox 调度序列化、投影验证、领取选择及 AgentLoop 请求与工具完成路径。依派单未运行测试、lint 或 CI；包编译证据另记于交付回报。

<a id="dev-note"></a>
## 开发备注

无。
