---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-22-finish-routing-cache-evidence

[English](2026-10-22-finish-routing-cache-evidence.md) | 中文

## 概述

为持久化 finish 块增加可选的非敏感账号标签、实际缓存写入档名、实际上 wire 的保留期与降档原因。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-finish-routing-cache-evidence
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-10-22-cache-response-evidence"
    after: "41f8c16d4681c4cd8b2f317262cc4c2d21ca65ab27514e7e8b75e4dc698316d2"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-10-22-cache-response-evidence"
    after: "9622e21efac0d87dfaebe3a771a35b3872823ad70f4df758f18da8c32832d2c7"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

会话版本及块判别值不变。既有记录省略新增可选字段仍有效；缺失表示未观察到，不伪造缓存档。旧读取方将原始 finish 块按无损 JSON 保留，聚合只读取已知 reason 与 replay 字段，故新增证据不改变消息内容、不要求新增回放行为。新读取方接受缺少证据的记录。实际保留期排除仅用于请求的 default 值。账本旁件声明独立于会话存储。

<a id="verification"></a>
## 验证

已核适配器发出、运行时转发、AssistantStreamAttempt、AssistantStreamAccumulator 快照与校验、BlockAssembler 以及持久化 assistant 事件类型。以 CI=true LANG=C.UTF-8 node_modules/.bin/vitest run 对改动包及相邻消费者点名，130 文件、2801 用例通过。未改变适配器、聚合器或读取器实现；认领后另跑持久化历史及目录核验。

<a id="dev-note"></a>
## 开发备注

无。
