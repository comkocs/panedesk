---
description: "静态浏览器图标与设计令牌。"
kind: "package-library"
---

# @panedesk/dsh-client-ui-panedesk-icons

<a id="summary"></a>
## 概述

Panedesk 新入口的静态图标与令牌库:自绘单线 glyph 集(16/20/24、currentColor)、应用图标,以及登记新面板所用上游 DSH 主题变量与唯一新增间距档的设计令牌表。

[English](README.md) | 中文

## 目录

- [使用本包](#using-this-package)
- [令牌表](#token-table)
- [图标清单](#icon-manifest)
- [理解实现](#understanding-the-implementation)
- [延伸阅读](#further-reading)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

<a id="using-this-package"></a>
## 使用本包

直接导入 glyph 组件(`import { IconPanedeskStats } from '@panedesk/dsh-client-ui-panedesk-icons'`);本包是与 ui-primitives 同类的静态浏览器库——无插件半边、无槽位、无 bundle 步。每个 glyph 颜色继承 `currentColor`,在统一 24 格设计网格上以 1.5 线宽按 `size` 16(缺省)、20、24 渲染。

<a id="token-table"></a>
## 令牌表

表的持久落点是 [`src/tokens.ts`](src/tokens.ts);本节是给人读的投影。公开 `./tokens` 入口指向生成的 `lib/types/tokens.js`，声明使用相邻 `.d.ts` 文件。

- **颜色** —— 新件只消费上游语义别名:`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2`、`--dsw-alias-border-l2/l3`、`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-brand-primary`、`--dsw-alias-menu-icon`。值都在 `packages/client/ui-theme/src/styles/design-platform.css`;本包不自造颜色值。
- **字号** —— `--dsw-font-base-16`、`--dsw-font-s-14`、`--dsw-font-m-18`、`--dsw-font-l-20`(定义在 `packages/client/ui-theme/src/styles/gradient-shadow-text.css`)。
- **圆角** —— `--dsw-radius-xs/sm/md/lg`(定义在 `packages/client/ui-theme/src/styles/base.css`)。
- **间距(新增档)** —— 上游主题没有统一间距变量,`PANEDESK_SPACE` 把新面板 CSS Modules 已在用的 4px 步进命名:`x1=4、x2=8、x3=12、x4=16、x6=24`。

漂移守卫(`tests/tokens.client.spec.ts`)在所引上游变量不再存在于登记文件时变红;`pnpm run scan:colors`(同一 spec 也会跑)在 `src/` 下除令牌表本身以外出现任何硬编码色值字面量时变红。

<a id="icon-manifest"></a>
## 图标清单

| 名 | 用途入口(设计 §二 位置表) | 尺寸 | 来源 / 许可 |
|---|---|---|---|
| `app` | Panedesk 各界面的应用标 | 16/20/24 | 自绘(本包,MIT,随仓库) |
| `stats` | 设置统计台节 + 主面板头 | 16/20/24 | 自绘 |
| `workflow` | 工作流面板入口 | 16/20/24 | 自绘 |
| `subagent-tree` | 会话头药丸 + 右栏页签 | 16/20/24 | 自绘 |
| `node` | 设置节点节 | 16/20/24 | 自绘 |
| `seat-grid` | 工位一览悬停位节头 + 位行菜单 | 16/20/24 | 自绘 |
| `seat-profile` | 设置工位档案节 | 16/20/24 | 自绘 |
| `inbox` | 会话头收件 / 隔离药丸 | 16/20/24 | 自绘 |
| `bash` | Windows Git Bash 设置行 | 16/20/24 | 自绘 |

全部自绘:未内嵌任何第三方图标集,故无需 THIRD_PARTY_NOTICES 条目。上游 `ui-primitives` 图标已够用的入口(钉住、省略号、告警、刷新、技能、插件等)照用上游件,刻意不在这里重复。清单由测试封顶 24 个 glyph。

<a id="understanding-the-implementation"></a>
## 理解实现

### 设计思路

一个共享 `Glyph` 框架把线宽、连接、端点与装饰角色(`aria-hidden`)在全集保持一致,glyph 文件只写几何。注册表兼任清单来源,让测试不必维护第二份列表就能封顶数量并盖住尺寸。

### 源码地图

- `src/glyphs.tsx` —— glyph 组件、应用标与清单注册表。
- `src/tokens.ts` —— 令牌表(上游引用 + 新增间距档)。
- `scripts/scan-color-literals.mjs` —— 色值字面量扫描(令牌表按文件名豁免)。

<a id="further-reading"></a>
## 延伸阅读

- [`@panedesk/dsh-client-ui-primitives`](../ui-primitives/README.zh.md) —— 其余入口照用的上游图标集。
- [`ui-theme` 样式](../ui-theme/src/styles/design-platform.css) —— 本表所引上游令牌的值。

<a id="model-experience"></a>
## 模型体验

<a id="user-interface"></a>
### 用户界面

<a id="what-the-model-sees"></a>
#### 模型可见内容

本包不改任何模型输入或输出。

<a id="token-effect"></a>
#### Token 影响

界面与配置操作不消耗模型 token。

<a id="kv-cache-effect"></a>
#### KV 缓存影响

不涉及模型调用,无 KV 缓存影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **glyph 在各道落地前暂无消费方** —— 清单覆盖本包负责的全部规划入口;走查前应复核每条入口与落地界面仍一一对应,再谈复用。
- **间距档是名字不是 CSS 变量** —— 主题没有间距变量,消费方直接用 `PANEDESK_SPACE` 的值;升进 `ui-theme` 是上游的事。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

加 glyph:在 24 格上画,组件加一行注册表,数量 / 尺寸 / 颜色测试自动覆盖;扫描脚本与漂移守卫无需逐 glyph 改动。

</details>
