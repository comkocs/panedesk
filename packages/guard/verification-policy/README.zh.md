---
description: "工具执行前生效的工作区验证开关。"
kind: "package-reference"
---

# @panedesk/dsh-verification-policy

[English](README.md) | 中文

## 概述

Web／桌面装配安装 `verificationPolicy`。它复用活动服务的归类、任务用时与拒绝话术，不另行归类命令。启用缺省为真；关闭后保留活动统计，不裁决也不执行客户端超时。

## 使用本包

设置按工作区号保存，结构带 `version: 1`。未开启事项记录时仍用 `workspace_verification` storage-domain 的 `settings` 表；开启时将原值照搬至项目 SQLite 的 `settings` 表，迁移失败则继续使用原适配器。`src/storage.ts` 选择存储，不改准入裁决。停用事项记录后重新使用原工作区设置；项目副本保留供再次开启使用。不写项目文件，不进入 `panedesk_settings`。

缺省允许根会话一轮用户请求及全部子代理合计一次全量测试，禁止变异测试，允许其余类别。「不限」允许全部类别且无上限。「只编译」禁止全量、改动面、变异测试、自写脚本及 CI 触发，客户端等待上限五分钟。其他数值上限缺省不限。自定支持每任务验证分钟预算或占全部观测任务用时的百分比；编译计入验证，脚本重叠只计一次。

`tools/pre-execute` 拒绝禁用主类或脚本标记。「只一次」在兄弟代理之间同步预留准入，开始执行时消耗；工具结果结算时释放未使用预留。同一条命令里有两段及以上全量（按 `;`、`&&`、`||`、换行或管道分段）即用掉这次额度，并用同一句「本轮全量已用过一次」拒绝，即使前一段会把整条判成改动面测试。原生与程序化嵌套调用共用该执行器。预算可直接拦或使用现有审批询问，提示列出单次放行、本任务都放行、本任务停掉验证；现有通道仅实现单次放行或拒绝，不支持任务级选择。

客户端启动在 `tools/execute` 套既有协作式截止时间，将取消信号传给工具，等待执行结算后返回 `VERIFICATION_CLIENT_TIMEOUT`。根代理与子代理系统提示均附一行只读设置，并由既有系统消息投影记录。

包入口默认服务提供 `addTaskProhibitions(request: VerificationTaskRestrictions): void` 及其远端包装 `prohibitTaskCategories(request: VerificationTaskRestrictions): void` 给清单消费者，以及远端 `readWorkspace(request: VerificationWorkspaceRequest): VerificationView` 给设置与灰显判断。两个禁止方法都向精确活动任务追加类别号，不改工作区设置。树行勾选另有可逆状态，取消勾选不会移除清单禁止项。

同一行系统提示要求代理开工前调用 `verification_checklist`，提交一句需求标题和计划检查项；没有要验证的内容时提交空的 items 数组。

## 模型体验

### 验证策略

#### 模型看到什么

一行只读策略、固定双语类别拒绝、一句全量已用拒绝、预算审批提示与客户端超时错误。该行同时带这条指示：「Before you start work, call verification_checklist with a one-sentence requirement title and the checks you plan to run. If there is nothing to verify, submit an empty items array.」不新增设置修改工具。

#### Token 影响

策略行及偶发拒绝、审批增加文字，不新增模型请求。

#### KV 缓存影响

工作区设置变化会改变系统提示行，可能使其缓存前缀失效；设置不变时文字稳定。

## 已知限制与延期工作

归类保留活动服务的限制：不检查外部代理、脚本隐藏内容及远端 CI 内容。超时限制工具活跃等待，不覆盖工具返回后的后台进程。任务禁止项与预留仅存进程内；持久全量次数读活动账本，恢复后代祖先归属仍有活动服务的重启限制。审批界面没有任务级响应按钮。设置修改影响后续裁决，不追溯已准入工具。

## 开发备注

本服务不改 Core 工具策略类型或协议常量。
