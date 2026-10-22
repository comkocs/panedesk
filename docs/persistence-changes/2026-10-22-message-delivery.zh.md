---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-22-message-delivery

[English](2026-10-22-message-delivery.md) | 中文

## 概述

新增读取时必需的输入调度转移与消息收件设置、可选待收调度和中断/取消细节，以及生产者拥有的 message-delivery 来源。独立消息账本不属于会话事件命名空间。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-message-delivery
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "fa22b0edcaf841e7f760f3b22d1f416c6eaf191911f63aae30a1874ed48eabf8"
    decision: same-version
  - root: "event:agent/input/transition"
    previous: null
    after: "b9e10f1ac80ba67a20ba4c147c2c244eddec9d3cbe10152c65b8897bccdfbadf"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-10-22-finish-routing-cache-evidence"
    after: "679003a1efb09972bc012da3182fca051594d2023cb94f61d93d32c703016c02"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "52ae4bb312f6b70af07b559debb4cc99085c0497210cb1442aacbb0be39d6d60"
    decision: same-version
  - root: "event:message/settings"
    previous: null
    after: "757193c76cc6d99e1fd4bdf164ad5e6a62d2a6e688717d2213948605ab93ce51"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "56ae645fa4efcca3d3898f568363319208b90dc364c7fa2aa5bbf0b6bb4bd9a3"
    decision: same-version
  - root: "event:tool/result"
    previous: "2026-09-16-session-format-v4"
    after: "a754e11f97735cab7d4e48291f22fdfda0ae5c0bdbc9c36dbf2653aa225be3e4"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "97eefbc3e975784b2afcfc9c964b6af3ac6125ab91553758072a553e847c7e42"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "a04c293cd5c2c85c99cad9ef1592454ccef82ef314d124cfa731c6f3e6d7b83b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保持会话格式版本 4。新读者在缺少 scheduling 时保留旧待收语义，缺少可选细节时保留粗粒度 interrupted/aborted 语义。写入者必须先提交 phase 为 scheduled 的必需 agent/input/transition，再提交对应的带调度待收拼接。旧读者在重放或追加前拒绝未知必需事件，不会静默把被动输入按旧规则调度。message/settings 同样是读取时必需的事件，两者均不可忽略。当前 V4 来源准入保留生产者拥有的任意非空来源种类；message-delivery 不改变消息内容或表面操作。interjection 细化既有 aborted 外层判别，粗粒度读者仍保留 aborted 语义及原始原因对象。可选 assistant interruptionReason 和工具 cancellation 元数据不替换保留内容，也不声称副作用已回滚。本次声明不修改事件写入者、调度实现或 Core 格式常量。

<a id="verification"></a>
## 验证

以 LANG=C.UTF-8 CI=true 对 17 个改动及相邻包目录运行 vitest：4060 例通过、14 例跳过，另有两项环境失败。构建原生系统产物，并仅为测试进程移除继承的 Windows 当前目录搜索策略变量后，两项受影响包目录复测 430 例通过、13 例跳过。通过集包括 storage-contract 在采用前拒绝未知必需事件、current-event-admission 拒绝且不截断提供者追加，以及 V4 编解码/来源准入。CI=true pnpm run typecheck 退出 0，发生在最终仅类型规矩观察出口接入之前。源码复核了 storage-contract.ts 的必需事件准入、JSONL format.ts 的恢复前准入、V4 message-sources.ts 的生产者来源保留。调度与投递写入者尚未实现；这些检查不代表运行时消息投递或平台验收通过。

<a id="dev-note"></a>
## 开发备注

无。
