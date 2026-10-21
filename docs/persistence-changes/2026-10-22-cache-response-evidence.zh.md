---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-22-cache-response-evidence

[English](2026-10-22-cache-response-evidence.md) | 中文

## 概述

在既有请求和助手流载荷中加入可选缓存保留期控制、长档缓存写入数与提供商响应证据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-cache-response-evidence
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "eb608af79b9fa565a1df6485962ee1c9c439a3dd0a0f9107f5bcdbdd0c66cc63"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "ec644f73d256557dd3c575126bd0d7c758236a3d9ce097b9225eada82b87f129"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "0be441e0594eb8c4d2980c607fbb02b07d32e28750ead053140b80e0e6c2ab90"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-16-session-format-v4"
    after: "03a30239b47b11cd23e5e4dc32280a5bc17e8e7923f7f90a3b178d7e72060503"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

所有新增持久成员均为可选，旧记录继续有效。会话头版本与事件判别值均未改变。已发布读者检查请求提供商、模型与适配器默认标记，不拒绝配置中的额外成员；助手终结检查流数组，不解释可选 finish 元数据。紧凑流累积保留完整 usage 与 finish 块。旧读者可能忽略新增记账证据与缓存控制，因此不具备新增记账或缓存策略行为。证据缺失必须保持未知，不能解释为命中缓存、已回传模型或零费用。新读者继续接受不含新增成员的旧记录。

<a id="verification"></a>
## 验证

源码核对：packages/core/session/src/index.ts 的 assertCurrentLlmShape 与 assertAssistantSettlementShape；packages/core/session/src/surface.ts 的 validateSessionEventData；packages/session/session-format-v3-to-v4/src/validation.ts 的 restoreReleasedV4Artifact；packages/llm/llm/src/assistant-stream.ts 的 AssistantStreamAccumulator.push。点名测试与全仓检查尚待执行；本认领不宣称已经通过。

<a id="dev-note"></a>
## 开发备注

无。
