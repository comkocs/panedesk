---
description: "通过现有宿主服务新建、改名、列举顶层会话并向其发送消息。"
kind: "package-reference"
---

# @panedesk/dsh-tool-session-ops

[English](README.md) | 中文

## 摘要

四件工具管理普通顶层会话，不依赖客户端，也不另建生命周期实现。Web 和 Desktop 的所有智能体预设均默认提供这些工具。

## 使用本包

与 `tools`、`sessionController`、`permissionPresets`、`sessionProjections`、`workingDirectory`、`settings`、`agentDefaultModel` 和 `workspaceRegistry` 一同挂载。本插件没有配置字段。

```yaml
- name: '@panedesk/dsh-tool-session-ops'
```

- `session_new({ cwd?, model?, permissionPreset?, prompt?, name? })` 新建会话。`cwd` 默认取调用方的有效目录。工作区注册表规范化该现有目录，复用匹配的文件夹组；没有匹配时先建组，再附着新会话。与手动注册文件夹一致，相对路径、不存在的路径及非目录路径均拒绝；`model` 匹配已配置模型的 ID 或显示名；省略模型或权限档时沿用现有服务记住的默认值。`prompt` 是可选开窗词。省略 `name` 不调用改名，保留正常自动命名。结果包含 `sessionId` 和当前 `name`，尚无标题时使用会话号。
- `session_rename({ sessionId?, name })` 通过与界面相同的服务改名；省略会话号时改当前调用会话。返回 `sessionId` 和已接受的名字。
- `session_list({})` 返回所有普通顶层会话，包括普通 fork，不含委派子代理。每行包含 `sessionId`、`name`、可用时的有效 `cwd`、`running`，以及包含提供方和模型 ID 的 `model` 对象。顺序沿用现有最近活动排序。
- `session_send({ target, text })` 先精确匹配会话号，再精确匹配名字；同名时选择最近活动的会话。消息按 `next-step` 提交，不打断接收方；返回 `sessionId`、`name` 和 `accepted`，不返回回复。英文语言偏好使用 `[From <name>] `；中文或无法取得语言偏好时使用 `〔来自 <name>〕`。

## 理解实现

工具调用现有宿主会话控制器的新建、选模、发送提示、改名和列表操作。权限档、目录解析、标题投影和记住的模型选择仍由原服务负责。列表读取现有摘要与投影，不重新扫描完整会话日志。常规工具调用／结果记录和接收方的普通用户消息保存模型可见历史。通用工具卡展示规范 JSON 结果，不修改客户端。

## 延伸阅读

- [会话服务](../README.zh.md)——持久化与投影。
- [会话控制器](../../api/session-controller/README.zh.md)——共享宿主操作。
- [工具目录](../../../docs/tool-catalog.zh.md#panedeskdsh-tool-session-ops)——生成的 schema。

## 模型体验

### 工具 schema 与结果

#### 模型看到什么

四段精简英文工具说明概述各项操作；参数说明保留参数细节。结果为规范 JSON 身份、会话行或投递接受状态。接收方消息以发送方当前窗名为前缀。

#### Token 影响

可用时四份工具 schema 增加请求 token。列表 token 随返回会话行数增长。发送操作将带前缀的正文加入接收方普通消息历史。

#### KV Cache 影响

工具可用性改变 schema 上下文。调用追加普通调用／结果历史；投递追加接收方消息，不重写此前消息。

## 已知限制与延后工作

- 浏览器尚未明确保存语言时，宿主可能无法取得语言偏好，此时发方前缀使用中文。
- 列表与按名解析是快照，并非投递保证。错误与生命周期行为由现有宿主服务负责；接受投递不表示回复完成。
- 新建、可选选模、权限选择、开窗词和改名依次调用现有操作，不组成新的原子事务。
