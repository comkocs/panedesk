---
description: "按需开启的项目事项、活动引用与不可变拍板版本，存于 SQLite。"
kind: "package-reference"
---

# @panedesk/dsh-trace-store

[English](README.md) | 中文

## 概述

Web／桌面 Host 挂载 `traceStore`；事项记录与严格拍板缺省关闭。`enable` 一次授权项目记录，不逐条确认。服务通过既有家目录解析器取得 `<home>/projects/<projectId>/trace.sqlite`，使用 SQLite WAL 与单一 Host 写队列。事项、留言、归属、设置更新和拍板版本均以短事务同其事件提交。

## 使用本包

默认导出为 Host 服务。`/types` 导出客户端安全记录，`/typert` 提供 Host 描述，`/remote` 通过应用远端装配公开同名方法。工作区请求使用 `workspaceId`；可选 `sessionId` 标识用户所在窗口，但不授予模型权限。模型调用从当前 Host agent initiator 自动取得会话与模型出处。

- 工作区：`status`、`followStatus`（初始开关及保存后的更新）、`enable`、`disable`、`associateProject`、`setStrict`。
- 事项：`createItem`、`closeItem`、`voidItem`、`listItems`。
- 活动：`timeline`、`assignEvents`、`comment`、`linkSession`、`readReference`。
- 拍板：`writeDecision`、`confirmDecision`、`rejectDecision`、`revertDecision`、`listDecisions`、`decisionHistory`、`followDecisions`（首帧历史及拍板写入提交后的更新）。

全局 `project_traces` 域将规范化工作区路径映射至稳定项目号与工作区开关。显式关联复用已登记项目，不扫描目录。`timeline` 选择事项时旧的在前，以 null 选择未归属活动时新的在前，沿对应方向使用不包含游标自身的事件分页，缺省每页 100 条。`linkSession` 关联该会话及后代之后产生的活动。停用记录保留数据并关闭严格档；数据操作要求记录处于开启状态。

普通拍板写入立即生效。严格档指定非子代理的规划会话：只有其可信 Host agent 能提议或提议回退，用户可直接回退，只有用户能确认或驳回精确的待处理版本。用户提供的窗口号不代表规划权限。版本只追加；确认与驳回均新增版本，仅生效或回退时更新现行指针。记录、项目关联与严格档开关也仅限用户操作。

观察器记录会话与子代理运行起止、轮次／消息序号引用、消息投递状态、交付附件、已就绪的工作区改动摘要，以及每次成功的 write 或 edit 工具结果（独立的文件改动事件和一条改动引用）。成功的 write 结果没有 diffs 时，从对应调用的 `file_path` 和 `content` 生成改前为空的新建对比。Bash 调用保留序号引用以显示命令开头；其文件改动仍依赖工作区改动摘要，不提供逐次 diff。会话／序号、子代理运行号与消息版本构成确定去重键。助手流提交后，采集按已提交序号读取消息，在 `text` 字段保留可见回复正文，上限为 4000 个 UTF-16 代码单元，不含推理；组装正文为空时，从已提交流的文本片段取得回复。显式取引用时以 JSON 字符串返回已存正文。不补写已有的空记录。其他对话与子代理输出留在 SessionPersistence；旧回复引用和其他会话引用只读所选片段。附件保留声明路径，不复制文件。改动对比先同步至项目所属 JSON 文件，再提交引用，且在记录器清理之前完成。

验证存储登记原设置来源。首次成功迁移将 JSON 原样复制至项目 `settings`；失败时继续使用原工作区存储。关闭事项记录的工作区仍走原适配器。项目设置副本在停用后保留，再开启时复用；模型不能修改设置。

## 模型体验

### 项目记录

#### 模型看到什么

不新增工具或提示文字。Host 消费者可调用服务；本包不提供模型工具或命令行。

#### Token 影响

记录不新增模型请求；有长度上限的回复正文只留在项目存储，不进入模型输入。后续消费者显式读取时自行控制输出预算。

#### KV 缓存影响

单纯记录不改变模型输入或缓存复用。

## 已知限制与延期工作

采集从开启记录开始，不回填早期会话、不扫描其他项目。改动覆盖范围和字节／文件上限沿用既有记录器。二进制与超限文件保存拒绝对比的元数据，不保存文本 diff；无法取得的文件哈希为 null。引用提交前崩溃可能留下未引用的 diff 文件。独立 Host 进程不共享进程内写队列。模型工具、只读命令行与用户界面由独立消费者实现。

## 开发备注

`database.ts` 持有单调模式版本 1 与关系表；另增 `session_links` 索引关系以关联后代活动。`registry.ts` 持有工作区映射。`capture.ts` 等待对比耐久写入；现有改动文件卡片不变。不改 Session 格式版本或 Core 协议号。
