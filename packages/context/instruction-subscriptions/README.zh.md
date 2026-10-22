---
description: "输入认领前的有界规矩件变更提醒。"
kind: "package-reference"
---

# @panedesk/dsh-instruction-subscriptions

[English](README.md) | 中文

## 概述

此可选插件在输入认领前的 `agent/input-preparing` 通过 `MessageDelivery.send` 发送仅含元数据的规矩变更提醒。每个代理独立订阅实际加载的启动文件和显式配置的路径。缺少文件系统或投递服务时，上游行为不变。参见[会话持久化](../../../docs/subsystems/persistence.zh.md)。

## 目录

- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="dev-note"></a>
## 开发备注

通过既有 profile 或 patch 配置插件：`files` 默认为空的附加路径列表，`maxBytes` 是必填正整数，限制每个代理保留的原始字节和每次边界扫描的字节，`watch` 默认为 false。相对路径从代理工作目录解析。watch 回调只置脏；每个运行中代理的边界仍会扫描。代理结束或插件卸载时关闭 watcher 并丢弃内存快照。不写上一版正文文件或账本正文，因此不涉及磁盘快照权限。

启动加载哈希初始化基线，不把竞争中的更新读取当作原始基线。成功的同代理写入只有在经版本核验的原始字节证据等于最终扫描哈希时才抑制提醒；无证据不会抑制变更。父写不抑制子提醒。投递被拒时保留旧基线以重试。增删行数按 LF 规范化后比较；缺失保留字节或不可读／超限时计数为 null，不编造数值。

<a id="model-experience"></a>
## 模型体验

### 规矩变更提醒

#### 模型看到什么

一条追加的 steer 档消息包含 JSON 字段 `kind: instruction-change`、`path`、`oldHash`、`newHash`、`status`、`added` 与 `removed`。状态为 `present`、`deleted`、`unreadable` 或 `over-limit`；不存在的哈希为 null。不含规矩正文或差异片段。投递类别为 `handoff`，因为知会不能使用 steer 档；只向运行中的已订阅代理发送。

#### Token 影响

每次检测到的变更通过普通、已记录的投递路径增加一条元数据消息。文件未变或有自写证据时不增加提醒 Token。

#### KV Cache 影响

插件只追加提醒，不替换请求开头，也不重载规矩正文。上游指令重组独立保留；其导致的任何开头变化仍属于上游行为。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 自写证据是有界、经版本核验的后读，不是写入时的原子摘要；竞争可能多提醒一次。
- 检测依赖宿主可等待的认领前事件和投递 provider。watch 失败后退回边界扫描，不做后台重载。
- 快照仅在进程内且受字节上限约束。上一版不可用时行数未知。重启重新建立订阅。
