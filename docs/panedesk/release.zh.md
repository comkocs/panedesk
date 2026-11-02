# Panedesk 发布脚本

[English](release.md) | 中文

本页说明根 [package.json](../../package.json) 中的 npm 发布脚本。本地排练入口是 `release:check`；继承的版本递增与发布命令不属于这条排练链。桌面打包与上传命令独立于 npm 发布链。

## 本地排练

`release:check` 校验并打包 DSH 发布族，扫描 tarball，对公共 registry 执行 `npm publish --dry-run`，并查询包名。它不会发布包，也不会创建发布版本。先准备原生扩展和 official 构建产物；普通开发构建不能满足全部 official 产物检查。在仓库根目录运行，输出目录必须不存在，且其父目录已存在：

```sh
pnpm run build:native-system
pnpm run build:artifacts --profile official
pnpm run release:check --out ./release-rehearsal
```

输出目录包含 tarball、逐步骤日志和 `report.json`。报告分别统计第一方可执行代码、第一方文档与第三方 vendor 文本，并应用仓内的[扫描豁免清单](../../scripts/panedesk/release-check-exemptions.json)。dry-run 成功或包名查询结果不证明拥有发布权；`pdesk` 是 `panedesk` 包的 bin 别名，不是第二个启动器包；作用域命名空间发布前还需建立组织。

只有通过可重复的 `--from` 参数提供额外的 vendor 与原生 tarball 目录时，才会校验打包后安装。不提供时，报告明确记录没有运行此项。Linux 排练已通过 tarball 扫描和 npm dry-run，但缺少 CMake 的宿主仍无法完成打包后安装校验：安装使用 `--omit=optional`，省略了 Koffi 的可选平台二进制包，随后转为源码构建。应在具备所需原生构建工具的宿主上完成这项检查；不能把 dry-run 当成已安装包的验证。

## 脚本对照

“在用”表示本地排练会调用该脚本，包括可选的打包后安装步骤。“上游遗留”表示继承的命令仍然保留，但本地排练不选用；不表示实现损坏，也不表示继承的工作流没有使用它。

| 脚本 | 状态 | 能不能用 | 行为与限制 |
| --- | --- | --- | --- |
| `release:check` | 在用 | 可以，用于 official 构建后的本地 dry-run。 | 校验、打包、扫描并执行 npm dry-run；要求新的 `--out` 目录及 registry 网络。仅提供 `--from` 时调用打包后安装校验；不发布。 |
| `release:verify` | 在用 | 可以，用于只读校验发布族。 | 检查版本与发布顺序；`RELEASE_PUBLISH=true` 还会启用可发布性与标签检查。排练不启用发布模式。 |
| `release:pack` | 在用 | 可以，需已有构建产物并独占输出目录。 | 打包并校验所选发布族。单独调用会删除并重建其 `--out` 目录；排练使用自己目录下的 tarball 子目录。 |
| `release:verify-packed-install` | 在用 | 有条件可用；需完整 DSH、vendor、原生 tarball 及原生构建前置。 | 在隔离消费方中安装并检查已安装的可执行程序。在 `release:check` 中为可选项；上述 Linux Koffi/CMake 阻塞不算通过。 |
| `release:dsh` | 上游遗留 | 只适用于有意调整版本，不用于就绪检查。 | 递增 DSH 统一发布版本，更新锁文件并创建 Git 提交；支持 `--dry-run`。`release:check` 不调用。 |
| `release:vendor` | 上游遗留 | 只适用于有意调整 vendor 版本。 | 递增所选 vendor 包的版本，更新锁文件并创建 Git 提交；支持 `--dry-run`。`release:check` 不调用。 |
| `release:publish` | 上游遗留 | 仅在明确获准发布、备齐发布输入与凭据时可用。 | 校验版本与完整性后，把指定 tarball 发布到 npm。这是真实发布器，不是 dry-run，`release:check` 从不调用它。 |
| `publish:npm-baseline` | 上游遗留 | 不作为公共 registry 排练入口。 | 独立的按提交寻址构建、打包、安装与验证流程，默认使用内部 registry。其 `release` 与 `publish` 子命令会真实发布；`release:check` 从不调用。 |

预设组合与提供方配置见 [Panedesk 架构](architecture.zh.md)。继承的发布族机制见 [npm 发布序列](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.zh.md)。
