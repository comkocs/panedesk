# 可重放的 Panedesk 改名

[English](README.md) | 中文

从仓库根目录使用 Node.js 24 运行；不需要安装依赖。

```sh
node scripts/panedesk/rename/rename.mjs --check
node scripts/panedesk/rename/rename.mjs --apply
node scripts/panedesk/rename/rename.mjs --patch upstream.diff panedesk.diff
```

`mapping.json` 依次应用 A（npm 包标识）、B（主目录路径）、C（选定的用户变量）和 D（精确的运行时产品字面量）。每条规则都有稳定 ID 和英文描述。A3 还覆盖不带斜杠的作用域派生名称，B2 则排除可选属性访问和计算属性访问（`?.dsh`、`).dsh`、`].dsh`）。B2 也跳过 `website/.vitepress/**`、`website/tests/**` 和所有 `*.css` 文件中的文档站点选择器，并保留 `.dsh-build-preview` 域名。A4 更新由作用域派生的包锚点、模板占位符及相应断言；独立启动器的 slug 改为 `panedesk`。D 的计数描述此前规则已运行后的原始输入树。`--apply` 在写入任何内容前校验全部计数；计数漂移会中止操作，不会默默接受上游变化。因此，对同一棵树重复改名会有意失败。`--check` 仅输出尚待处理的匹配计数，并在仍有匹配时以非零状态退出；它不强制基线计数，也不写文件。

树模式读取 `git ls-files`，将所有可严格解码的 UTF-8 文件视为文本，包括含 NUL 字节的文件。UTF-8 解码保留已有 BOM；编码保留所有未改动字节，包括 NUL 和行尾。它跳过符号链接、无效 UTF-8 文件、本工具所在目录、许可证、品牌指南、`.agents/notes/archived/` 下的冻结笔记和私有改名检查清单。`mapping.json` 按路径与该行必含的原文片段列出保留行；`--apply`、`--check` 和 `--patch` 均不改写这些行，让根目录两语 README 对明确拒绝读取的旧名称保留原文。LibreOffice 对外发布的包（包括拆分的路径参数）保留原有作用域。提供商请求头、提供商标识、Python 包名与模块名，以及上游仓库 URL 都不是产品改名目标。DeepSeek 平台账户、API Key、余额和信用额度计费措辞属于模型提供商，有意不改名。`APP_IDENTITY.url` 保留上游 URL，因为现有接口要求如此。不引入对旧主目录或选定旧变量的兼容读取。

完成替换后，树模式直接用 Node 运行仓库的 `scripts/gen-tsconfig-paths.ts` 以重新生成路径别名，再运行 `scripts/gen-dependency-catalog.ts`，依据已记录的 npm 解析结果排序依赖目录。两个生成器均离线运行，无需安装依赖；依赖目录命令不刷新解析结果或已记录的元数据。CLI 帮助中的调用字面量和生成标题会映射，但不重新生成 CLI 帮助文档。`pnpm-lock.yaml` 只接受文本替换：这个无依赖工具不尝试重新序列化 YAML 或解析包。用 `CI=true pnpm install --frozen-lockfile` 验证。任一生成器失败时，生成器输出和替换都会回滚。内容替换后，树模式用 `git mv` 将跟踪文件路径中恰为 `.dsh` 的目录段搬为 `.panedesk`；该路径规则不改文件名或旧主目录迁移导入代码，补足 B1/B2 的内容替换。`--check` 以 `B2-path` 逐条列出待搬路径并汇总计数。对于内容已经改名、只剩路径待搬的树，跳过 D 基线计数校验及生成器；其它应用仍保留原有计数校验。

## 重放改名提交

在单独的 detached 工作树中检出仅含脚本的提交，运行 `--apply`，再将结果与生成的改名提交比较。不要与之后手工调整发布逻辑、启动器帮助或构建失败的提交比较。

```sh
git worktree add --detach /path/to/replay SCRIPT_COMMIT
cd /path/to/replay
node scripts/panedesk/rename/rename.mjs --apply
git diff --stat RENAME_COMMIT
git diff --exit-code RENAME_COMMIT
# Align only the detached worktree's index and HEAD after proving byte equality.
# This preserves generated working files and makes porcelain status meaningful.
git reset --mixed RENAME_COMMIT
git status --porcelain
cd /path/to/original
git worktree remove /path/to/replay
```

## 上游补丁

将上游改动导出为统一文本 diff，用 `--patch` 转换，再通过 `git apply --check` 和 `git apply` 审查并应用转换后的 diff。补丁模式使用同一套规则改写文件头、新增和删除的行以及上下文，但不强制 D 的全树计数，也不运行生成器。它保留行数与 hunk 坐标。不改写二进制补丁载荷；遇到带引号的 Git 路径会拒绝处理，不会猜测。重命名文件或引入全新产品字面量的补丁需要审查。更新上游基线时必须审查 D 的预期计数，不能自动接受新计数。补丁模式不包含另外的手工发布逻辑和启动器帮助提交。
