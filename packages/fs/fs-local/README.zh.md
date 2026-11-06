---
description: "`ctx.fs` 的宿主文件系统后端：面向选择或排查本地文件访问的部署方与维护者。"
kind: "package-reference"
---

# @panedesk/dsh-fs-local

[English](README.md) | 中文

## 概述

使用 `dsh-fs-local` 可在宿主文件系统上读取、列出、监听、原子写入和编辑文件。相对路径从可配置的基准目录解析，而绝对路径和父目录遍历不受限制。到达同一文件的路径和符号链接共享一个身份。写入保留文件权限，可选版本防护会拒绝陈旧覆盖。直接访问宿主文件时选择本包；需要约束变更时使用 `fs-sandbox`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当组合需要由真实宿主文件系统支撑的 `ctx.fs`、且可以接受进程本地实现时，挂载此后端。常用路径是显式的：加载后端、给出基准目录，然后面向模型的工具（`dsh-tool-fs`）或你自己的插件即可读取、写入和编辑文件。

### 何时选择

在单个进程中进行普通宿主文件访问时，请选择 `fs-local`。会话的写入与编辑必须限制在工作区与临时根目录内时，选择 [`fs-sandbox`](../fs-sandbox/README.zh.md)——它扩展此后端，只增加模式围栏。`config.cwd` 只是解析默认值，不是约束边界：绝对路径与 `..` 都可以逃逸它。

### 最小配置

用一个基础目录加载后端；相对路径基于它解析，绝对路径则忽略它。相对基础目录以提供方进程工作目录为起点，展示路径始终保持绝对路径。在 POSIX 上，解析先遵循文件系统语义，再进行词法规范化：`symlink/..` 到达链接目标的父目录，即使最终文件尚不存在也如此。目录列表中的子项展示路径保留同样的物理遍历语义。Windows 保留原生的驱动器相对路径规范化行为。

```yaml
- name: '@panedesk/dsh-fs-local'
  config:
    cwd: /absolute/path/to/workspace
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `cwd` | `process.cwd()` | 相对路径的基准目录 |
| `diffBasisMaxBytes` | `10 MiB` | 每次覆写 diff 一侧的 UTF-8 字节上限；更大的覆写返回 `before: null` |
| `windowsHandleBackend` | `disabled` | `experimental` 选择失败即拒绝的 Windows 句柄后端；其他平台忽略此项 |

其余通用行为说明针对缺省后端。仅通过所有者批准、受保护的 profile 或 overlay 选择 `experimental`；没有环境变量或 CLI 快捷开关。它在原生能力检查通过时支持本地盘符 Windows x64 NTFS 的读取、探测与目录枚举。相对名称要求带绝对盘符的 `cwd`；设备路径、UNC、驱动器相对路径、点路径段、备用流、歧义 DOS 名称及所有重解析点均拒绝，而非规范化或跟随。重解析子项使整个列表请求拒绝。写模块通过句柄支持新文件创建、受限覆盖、目录创建与删除；监听仍不可用，所有操作均不退回路径。新文件在目标目录中独占暂存，不传入安全描述符，由 Windows 继承权限与完整性标签，并在同步后通过句柄相对的不覆盖硬链接发布，绝不退回路径操作。进程异常终止或清理失败时，目标目录里可能留下一个按该目录普通继承权限的暂存文件，只尽力清理。句柄后端缺省仍为 `disabled`。真实 Windows ABI、DLL 装载、共享约束与打包 Worker 行为仍须原生验证。

生成的[配置目录](../../../docs/config-catalog.zh.md#panedeskdsh-fs-local)完整列出了所有受支持字段及其 JSDoc。

### 你能做什么

完整或流式读取任意普通 UTF-8 文本文件，按你选择的上限或按字节窗口读取原始字节，并按稳定名称顺序列出一层目录。原子地创建或替换文件，并原子地应用字面量文本编辑；两个变更操作都按文件串行化，并发写入方绝不会交错。版本防护是可选的：省略它即无条件创建或覆盖，提供它则在文件自上次观察以来发生变化时失败。

读取、列出与变更操作的失败是携带稳定错误码的类型化 `FsError`——`FS_NOT_FOUND`、`FS_NOT_TEXT`（二进制内容）、`FS_STALE_VERSION`（自观察以来已变化）、`FS_EDIT_NOT_FOUND` 或 `FS_AMBIGUOUS_EDIT`（无唯一字面量匹配）等——因此调用方依据错误码分支，绝不解析消息文本。编辑遇到缺失目标时，无论是否提供版本防护，都报告 `FS_STALE_VERSION`。

Chokidar 通过 OS 事件观察单个文件或目录的直接子项，不使用轮询或递归监听。文件使用筛选到目标的父目录监听，因此就绪时也能接收起初缺失文件的创建事件。父目录保持存在时，文件监听覆盖原地写入、原子替换、删除和同路径重建。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本地后端背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

后端建立在三个想法之上：

- **Realpath 身份。** `targetKey` 是文件的 `realpath`，因此经符号链接到达同一文件的两个输入路径共享一个身份，写入落在链接目标上，同时保留链接。
- **原子发布。** 写入先写入目标旁私有暂存目录内的独占临时文件，执行 fsync 后发布；现有文件的 mode 会保留，Windows 上的 DACL 在替换后也会保留。
- **单一变更临界区。** 每目标 FIFO 锁串行化读取→防护→写入窗口，并发写入与编辑因此被确定性排序——一方胜出，其余操作看到新版本后因版本陈旧而被拒绝。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务接线：`LocalFileSystem`、`Config`、每目标变更锁 |
| [`src/fsio.ts`](src/fsio.ts) | 不依赖 Cordis 的原始 I/O：探测、读取、原子写入、字面量编辑、行尾处理 |
| [`src/win32.ts`](src/win32.ts) | 原子替换的 Windows 专属 DACL 保留 |

<a id="opened-file-reads"></a>
### 已打开文件的读取

内容读取、编辑预读与覆盖差异基础只打开一次，检查已打开的普通文件，并只通过该句柄读取。POSIX 打开使用 `O_NOFOLLOW`；Linux 从 `/proc/self/fd` 获取最终路径，macOS 使用 `F_GETPATH`。Windows 使用 `FILE_FLAG_OPEN_REPARSE_POINT` 打开，拒绝重解析点和非磁盘文件，并从同一句柄获取卷与文件身份及最终路径。强制策略提供方在读取任何内容前检查该路径和身份，包括中间目录链接替换。稳定链接仍通过正常目标解析受支持。句柄在完成、取消、失败或提前终止流时关闭；这不对并发原地写入提供快照。

### 相对目录句柄的操作

在 Linux 上，规范化祖先目录通过 `O_DIRECTORY | O_NOFOLLOW` 逐段打开；后续操作经保留的目录描述符访问单个条目。读取、元数据探测、目录枚举、父目录创建、暂存与发布共用此遍历层。每次变更在预读、发布与写后探测期间保留父目录，并持有独立的暂存目录描述符。将目录替换为链接不能重定向这些操作。部署中的 Worker 以 `process.title === 'dsh-webworker'` 明确标识其虚拟文件系统，并保留路径操作。其他 Linux 进程若缺少 `O_DIRECTORY`，会在加载本后端时、执行文件操作前以 `FS_IO_ERROR` 拒绝；绝不退回路径操作，必须使用支持目录句柄的运行时。macOS 与缺省 Windows 后端仍按路径遍历祖先。实验 Windows 后端保留所有祖先且不共享删除权限，相对目录 HANDLE 打开子项，并在操作拥有的 Worker 上执行同步原生调用。最终名称仅用于身份授权，绝不据此重新打开。目标能力暴露探测、读取、写入与关闭操作，而非 I/O 路径；旧适配器内部保留既有 Linux 描述符路径与发布机制。实验写能力要求通过验收的全句柄暂存、安全继承、元数据保留、发布及清理实现；普通改名不能替代覆盖元数据保证。

内部 `DirectoryCapability` 还提供单段 `walk` 与 `stage`；`OwnedStage` 拥有文件 I/O、同步、元数据准备、发布、丢弃与关闭。子目录及暂存对象保留父级所有者。兼容入口 `openDirectory` 与 `openDirectoryTarget` 的 `path` 仅保留原始展示身份，调用者通过方法执行 I/O。旧后端独立暂存明确不可用；既有提供方写事务及其描述符相对原语不变。

Windows 变更装配仅加载固定同级模块：源码中的 `win32-write-backend.ts` 或构建产物中的 `win32-write-backend.js`。导出为 `createWindowsWriteExtension` 与 `createWindowsWriteHandler`，类型由 `win32-handle-types.ts` 的 `WindowsWriteModule` 定义。主线程工厂获得保留的句柄标识、明确的自身／子项引用及读回调；Worker 工厂获得原生所有者的 get/adopt/inspect/release 操作。共享消息覆盖目录创建、暂存 I/O、元数据、发布、删除及清理。包构建在该同级源码存在时纳入它。模块缺失、无效或失败时拒绝变更，不退回路径。写模块实现自有暂存、部分写入、先同步后发布、不覆盖的相对硬链接与句柄 disposition 清理。新文件在目标目录中独占暂存，不传入安全描述符，由 Windows 继承权限与完整性标签，并在同步后通过句柄相对的不覆盖硬链接发布，绝不退回路径操作。清理失败或进程异常终止可能留下继承目标目录权限的暂存文件，这些文件不是仅所有者可访问的私有残留，只尽力清理。句柄后端缺省仍为 `disabled`。覆盖仅接纳属主为当前进程用户的普通文件：DACL 未受保护、非空且所有 ACE 均继承，且无显式完整性标签。继承自所在文件夹的完整性标签照常接纳，例如工作区写授权加上的标签。旧文件仅以普通读与 `READ_CONTROL` 打开，不请求 `ACCESS_SYSTEM_SECURITY`；`NtQuerySecurityObject` 只查询属主、组、DACL 与完整性标签，不查询审核信息；审核设置既不检测也不保留。显式权限、断开继承、不同属主、显式完整性标签、不支持的 ACL 格式及检测失败均在暂存前拒绝：“This file has individually configured permissions; direct replacement is not supported yet / 该文件有单独设置的权限，暂不支持直接覆盖”。替换文件在同一目标目录中独占创建，不传入安全描述符，由 Windows 自动继承权限，不执行权限合成或安装。`OpenProcessToken` 与 `GetTokenInformation` 查询进程用户及默认属主，两者均须与旧属主一致。缺少访问能力即拒。编辑与差异预读使用已授权的打开句柄。元数据准备后，通过带 POSIX 与 replace-if-exists 标志的 Native `FileRenameInformationEx` 发布；访问拒绝提示“File is in use by another program; close it and retry / 文件被其他程序占用，请关闭后重试”，不重试 Win32 改名或 `ReplaceFileW`。已提交清理只关闭发布文件，不将其标记删除。元数据准备复制旧创建时间与压缩格式，仅合并已观测的 hidden/system/archive 组合，并复制缺失命名流，不回放主数据、安全信息、EA 或 ObjectId。只读、未知属性或备份流、EFS、安全资源属性及企业保护均拒绝；检测失败也拒绝。两种句柄属性观测均拒绝加密位，保留 EFS 或企业保护拒因，并附“Encrypted / possibly enterprise-protected file / 已加密 / 可能受企业保护”。替身测试执行原生调用适配器并核替换内容可读，不代表真实 Windows 验收。短名和 ObjectId 不保留，也不作为拒因；这与 `ReplaceFileW` 不同。目录创建和删除使用相对原生句柄；缺省旧后端行为不变。

### 写入路径

每次写入先探测目标、执行可选防护（`createIfAbsent` 或 `replaceIfVersion`）、在两侧都足够小时捕获有界的 `before` diff 基础、把新内容暂存到目标旁、fsync，然后原子发布。带防护的创建使用绝不替换并发创建者的硬链接发布，并以 `FS_NOT_OBSERVED` 拒绝它。

### 编辑路径

每次编辑先探测、在字面量匹配前校验版本防护（陈旧编辑因此报告 `FS_STALE_VERSION`，绝不会给出误导性的无匹配）、读取文件、以 LF 规范化执行字面量替换、恢复文件主要的行尾风格，然后重新发布——全部在每目标锁内完成。

### 归属与不变式

原始 I/O 不依赖 Cordis，在 `src/fsio.ts` 中独立单元测试；`src/index.ts` 保持为轻量接线。`config.cwd` 只是解析默认值——约束是 `fs-sandbox` 或 `tools/execute` 权限插件的工作。取消是尽力而为的 `AbortSignal`，在每次异步探测前后检查。对于监听，signal 取消初始化；就绪后，调用方必须等待返回的关闭函数完成。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从约定逐步进入相邻的后端、工具与策略。

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——穷尽式提供方约定、策略事件与错误分类体系。
- [dsh-fs](../fs/README.zh.md)——本后端实现的 `ctx.fs` 约定。
- [fs-sandbox](../fs-sandbox/README.zh.md)——扩展本后端的沙箱强制后端。
- [tool-fs](../tool-fs/README.zh.md)——消费 `ctx.fs` 的面向模型工具。
- [fs-observation-policy](../fs-observation-policy/README.zh.md)——通过 `fs/*` 事件防护变更的策略插件。
- [Windows DACL 保留笔记](../../../.agents/notes/archived/bug-fix/2026-07-19-windows-atomic-write-dacl-preservation.md)——原子替换为何复制目标的访问策略。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-fs` 间接产生影响；该消费方把本提供方带行窗口的 UTF-8 内容、变更确认与提供方消息原文渲染为有保留上限的结果，而版本、原子写入机制与目录元数据仍属内部细节。

#### KV Cache 影响

不会直接使缓存失效；具名消费方负责请求前缀的任何变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本地后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用文件系统对比或任务积压。

- **`config.cwd` 不是沙箱**：它是解析默认值，而非约束；绝对路径和 `..` 可以逃逸。请使用更严格的 `ctx.fs` 后端或 `tools/execute` waterfall（瀑布式事件）上的权限插件实施约束。
- **Linux 父目录重建**：父目录删除并重建后的监听恢复仍延期；父目录保持存在时，同路径文件重建仍受支持。
- **版本 token 依赖文件系统元数据**：它们组合设备、inode、大小、纳秒级 mtime 与纳秒级 ctime；如果存储层在重写时无法更新其中任何一项事实，仍可能绕过陈旧防护。
- **`editText` 会把整个文件及编辑后的副本保存在内存中**：只有读取路径支持流式处理。
- **低于上限的覆写仍会缓冲上下文基础**：`writeText` 除调用方持有的替换内容外，最多还会保留略低于 `config.diffBasisMaxBytes` 的旧文本；该上限不限制返回的 `after` 值，也不限制整文件展示回退。
- **二进制检测不对称**：读取只对前 8192 字节执行 NUL 采样，编辑则扫描整个 buffer，因此 NUL 出现在后部的文件可以读取，但编辑会被拒绝。
- **每目标变更锁仅限进程内**：即使跨进程，带防护的创建仍采用原子且不替换的发布方式；但只有当可选版本防护观察到元数据变化时，系统才能发现其他进程中的替换写入方，且绝不会将其串行化。
- **带防护的创建要求支持硬链接**：拒绝硬链接发布的文件系统或挂载点无法支持 `createIfAbsent`；后端会使目标保持缺失状态并报告 `FS_IO_ERROR`。
- **提交后清理采用尽力而为语义**：如果移除仅所有者可访问的暂存目录失败，成功发布仍视为成功，并留下私有残留供运维人员后续清理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
