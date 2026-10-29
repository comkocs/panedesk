---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-29-subagent-report-paths

[English](2026-10-29-subagent-report-paths.md) | 中文

## 概述

为用户消息、开发者消息、收件箱及标题请求事件中的子代理完成消息来源添加可选 reportPaths。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-29-subagent-report-paths
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-22-message-delivery"
    after: "50d8870c243f856efea4c7376cae8261e2474dae1032f7ef0f4855f25cab3d98"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-message-delivery"
    after: "5367bb1b70853870821aafbec035fa339a41fdecae3523a0362a0c1418a1a262"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-message-delivery"
    after: "8e4e1300eaff1472e3e9c158718893bfdc9d85daa54fa6d32290611bd2aa515c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-message-delivery"
    after: "55ed93dabc12a312ce531d0492f740381b426084c91d6c3e85e40e8a2d835678"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有 subagent-settled 判别字段和全部必填字段不变。旧记录不含 reportPaths，仍然可读。读取方只将新增可选字段用于展示；字段缺席保留既有行为，路径是不可信提示，不是指令或已验证文件。该字段不改变执行、回放顺序或协议操作号。

<a id="verification"></a>
## 验证

packages/seat/seat-gates/tests/completion-wake-composition.spec.ts 的 Loader 组合四例全部通过，覆盖命令/子代理及空闲/忙碌，含唯一持久完成通知、路径提示、重试窗口后无重复。Host tsc --noEmit 退出 0。持久类型预览将四个受影响根均分类为 optional-property-added，无强制兼容性复核要求。

<a id="dev-note"></a>
## 开发备注

无。
