---
description: "账本检查点投影与压缩事件所有权。"
kind: "package-reference"
---

# @panedesk/dsh-compaction-ledger

[English](README.md) | 中文

## 概述

提供账本检查点贡献和提交后的压缩事实。账本可用时，插件登记为唯一压缩事件所有者；调用计量保留物理摘要请求，不再写第二份事件。卸载会释放所有权。没有账本时，检查点原样传递。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

从包入口导入公共类型。本包仅用于 Host，不提供浏览器入口。

<a id="model-experience"></a>
## 模型体验

### 账本检查点

#### 模型可见内容

提交的检查点包含有界 `<ledger-checkpoint-data>`，其中包括存活子代理标识，并明确标记为不可信运行时数据。

#### Token 影响

检查点数据占用配置的 token 预算，但不发起额外模型请求。

#### KV Cache 影响

检查点改变压缩后的历史；插件不建立或刷新提供方缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 提交后的账本失败会被报告，但不回滚检查点。持久化存储和物理模型调用计量归账本提供方所有。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
