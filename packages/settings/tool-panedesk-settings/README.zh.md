# @panedesk/dsh-tool-panedesk-settings

[English](README.md) | 中文

## 概述

`panedesk_settings` 读取可编辑的 Panedesk 设置，并通过设置页共用的、带修订号检查的 `settings.mutate` 写入指定项。基础装配只挂载一次，Web 会话预设继承此工具。`read` 返回当前值及 Schemastery 可选值规则；`write` 返回修改前与保存后的值。

## 使用

先以 `action: "read"` 调用，再将返回的准确 `name` 和 JSON `value` 交给 `action: "write"`。可改项包括开窗命名开关与左右锚规则、统计开关与刷新间隔、外部登记文件路径与开关、全局文件系统技能扫描控件、节点刷新间隔与唯一已配置传输的开关，以及数据存储设置。技能和传输字段复用页面的 `configEditor.edit` 路径；存储复用 `postgresStorage.save` 并回显重启要求。只列出已装配且可编辑的设置。读取可并行，写入独占执行。

工具页与本工具共用 `disabledTools` 工具名数组。经过校验的默认值不提供 `subagent_fork`、`workflow`、`create_goal`、`update_goal`、`get_goal`、`present` 六个工具，未保存设置时也一样；提问卡保持开启。空数组开启全部可用工具。普通会话在第一次模型装配时固定名单，后续修改对新会话生效。类型子代理呈现映射后的工具。无类型子代理仅呈现干活工具集，加上 `subagent.extra_tools` 显式点名的工具；缺省不带浏览器或 MCP 工具。`subagentsFullTools` 开关缺省为 false，开启后为新建无类型子代理恢复全部可用工具。这是模型呈现偏好，不是执行权限：隐藏原生 schema 与 PTC SDK 条目，不改变工具注册或执行守卫。

## 模型体验

模型请求增加一个工具定义，结果为 JSON 文本。当前值与修改结果作为普通工具结果记录；不添加提示词章节或额外模型请求。继续使用原有设置校验和修订冲突处理。

## 已知限制与后续工作

项目开窗、数据库连接、工位及其他没有可调用共用写口的设置只可手动，不列为可编辑项。不伪造所有者身份调用受限的远程方法。
