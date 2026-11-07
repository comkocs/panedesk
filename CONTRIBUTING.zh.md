# 贡献

[English](CONTRIBUTING.md) | 中文

Panedesk 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立分叉，采用自己的产品身份与插件组合。

本仓库目前不接受外部 PR（Pull Request）；你可以分享可复现的问题报告、以 `dsh-plugin` 话题发布插件，并帮助其他用户。

## 修复回上游

1. 确认问题是否也影响上游 DeepSeek Harness，并找出最小受影响上游组件。
2. 面向上游拆出聚焦补丁，排除 Panedesk 品牌、私有集成、本地配置与无关改动；需要转换包名时使用[改名重放流程](scripts/panedesk/rename/README.zh.md)。
3. 附最小复现与相关点名检查，依上游当前贡献政策提 PR；若上游不接 PR，则报告修复。
4. 在 `scripts/panedesk/fork-divergences.json` 登记本地差异，填写唯一 `id`、简明 `description`、公开 `origin`、说明上游适用性与 PR 状态的 `reason`，以及 `match.type` 和精确 `match.paths` 或现有风格的通配路径。
5. 上游更新包含修复后，在本地重放，仅删除过时差异条目或路径模式，并运行[台账检查器](scripts/panedesk/README.zh.md#fork-divergence-ledger)，确保未覆盖与过期计数均为零。
