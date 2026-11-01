# Panedesk 分叉维护脚本

[English](README.md) | 中文

`scripts/panedesk/` 下的分叉自有脚本让 Panedesk 相对上游 DeepSeek Harness 源码的分叉可查、可回放。上游导入基线是标题为 `Import DSH (DeepSeek Harness) 0.2.1-rc.2 source` 的提交;`check-fork-divergences.ts` 在运行时从 HEAD 历史里按标题找到该提交——基线识别只靠 checker 里的上游版本常量这一处,维护源里不拼写任何提交哈希。

## 分叉台账

```sh
pnpm exec tsx scripts/panedesk/check-fork-divergences.ts [--head REV]
```

`check-fork-divergences.ts` 对 `fork-divergences.json` 做面向基线的两向核对,任一方向非零就以逐路径、逐条目的清单报错退出:

- 未覆盖(必须为 0):基线里有、HEAD 改动 / 删除 / 改名移走的每个路径,都至少被一条台账 `match.paths` 模式覆盖。改动上游原有文件让本检查变红时,在同一次改动里把该路径加进拥有该分叉的条目,或照现有写法新增条目。
- 过期(必须为 0):每条台账模式仍至少匹配一个与基线不同的路径;HEAD 新增的路径视为因缺席而不同。匹配不到两棵树中任何路径的模式是死引用,同样算过期。

`match.paths` 里 `*` 匹配单个路径段内,`**` 跨段(两侧被斜杠包住的 `**` 也可以跨零段),`?` 匹配一个字符;不含通配符的模式精确匹配该路径。`type`、`test`、`replacements` 与其余 `match` 字段是给人看的分叉说明,不参与匹配。

### 权限位

字节与基线完全一致、只有可执行权限位不同的路径不算内容分叉。checker 把这类路径单列在信息段里;它们无需登记,也不影响退出码。只剩权限位差异可匹配的台账模式,与不再跟踪任何分叉的模式一样算过期。导入提交本身与上游 tag 也只差权限位,所以文件内容才是分叉信号。

### 换基线

上游同步换基线时分两步:先把新版上游源码作为一笔标题为 `Import DSH (DeepSeek Harness) <新版本> source` 的导入提交引入,不改写已公开历史(例如在上游分支上提交该导入后合并进来),再改 `check-fork-divergences.ts` 里的上游版本常量——基线识别的唯一一处仍是该常量。换基线后把两向收敛:被同步成一致的基线路径退出分叉范围(删掉因此过期的条目),被同步出差异的路径补登记。

## 改名零待办与 slim-base 新鲜度

static CI 段同时要求可回放改名零待办、生成的 slim-base 包不过期:

```sh
node scripts/panedesk/rename/rename.mjs --check
pnpm exec tsx scripts/panedesk/gen-slim-base.ts --check
```

改名映射与补丁回放见 [rename/README.zh.md](rename/README.zh.md)。
