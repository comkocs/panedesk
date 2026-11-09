You are this project's first window. Check its needs using this guide before starting work.

# Getting started (workflow setup)

English | [中文](getting-started.zh.md)

Python 3.11 or later is required, with no third-party packages. Run the commands below from the workflow-pack directory. The project root is the folder containing the new project's main files. In the host application, invoke the bundled `workflow-pack` skill to read this guide; invoking it does not itself authorize writing project files.

## ⓪ Route the project first

This guide sets up new projects from scratch. For an operating project with its own rules and files, read `workflow-checkup.md` instead.

Find product documents in three steps: ① use documents supplied by the decision maker or under the project root's `需求/`, in any format; ② otherwise scan the project directory and subdirectories read-only for names or contents suggesting product, requirements, development, PRD, or prototypes, and ask “Use this?” before adopting a discovery; ③ if none exist, ask just three questions: what to make, for whom, and what the first version must include. If the decision maker wants a complete requirements review first, mention the optional `requirements-review.md`, usable in any chat window; do not perform that full review in this window.

## ① Record the original request

Append the decision maker's first request verbatim to `资料/决策者原话.md` under the project root, with the date and time obtained from the current system. Append subsequent requests without overwriting or mixing interpretation into the original wording. Do not change rules or start making the deliverable yet.

## ② Check requirements in one exchange

If step ⓪ found product documents, derive and fill the ten answers directly from them instead of asking each question. Ask together only about missing details that affect scale selection. Without documents, restate already clear answers without asking again, then ask the remaining questions from the following ten together. Recommend an answer to each. Follow the recommendations if accepted. For anything not asked, use defaults, act, and report assumptions; never present guesses as original wording.

| Question | Plain-language question | Recommended default | Requirement-card fields |
| --- | --- | --- | --- |
| 1 | What are we making, for whom, and what do they receive? What matters most, and what must never happen? | Derive a project name and summary from the original request. Otherwise begin with a minimal usable result, prioritizing accuracy and editability. Mark unclear restrictions as assumptions, not decisions. | `[项目] 名、一句、受众、成品`; summarize direction in `一句` and retain complete wording and limits in the original-request record. |
| 2 | How many main work windows will run at once? | One. Count concurrent main conversations, not temporary helpers. | `[规模] 同时窗数` |
| 3 | How many lasting responsibilities, such as writing and proofreading, will there be? | Count stated responsibilities, not windows. With two or three windows, ask whether each owns a lasting responsibility. Otherwise use one; if at least four windows are stated without responsibilities, use half the windows rounded down. Exclude the decision maker. This count affects scale. | `[规模] 分工位数` |
| 4 | How many separately managed code or material repositories? | Zero for ordinary creative work, one for software. Several folders do not imply several repositories. | `[规模] 仓数` |
| 5 | Will we write code or check that programs run? | No for ordinary creative work; yes for software. | `[特征] 代码` |
| 6 | Will we deploy a product for online users or operate it continuously? | No for ordinary creation; yes for software deployed and maintained online. Publishing articles or videos, or maintaining public code, does not count as deployment. | `[特征] 上线` |
| 7 | Will we produce images, sound, video, or other assets in bulk? | Yes for short videos; no for plain writing or ordinary software. | `[特征] 素材` |
| 8 | Are there rules or values that must have one authoritative value, such as prices? | No unless the business requires it. | `[特征] 数值` |
| 9 | Will tasks go to several model providers? Is an independent read-only review role wanted? Should rules and original wording enter a structured repository with daily exports? | All three default to no. Several assistants of one type do not count as multiple models. The large-research profile enables the review role and rule repository. | `[特征] 多模型、审查岗、规矩库` |
| 10 | What are the decision maker, coordinator, project authorities, and work records called, and where do they live? | Use the profile's names and one record file. Recommend a ticket-style tool when concurrent windows reach four, active tasks are expected to reach ten, or duration reaches one month. | `[称呼]`; project name, audience, and output default from `[项目]`. |

Append separate requirement-check results and autonomous assumptions to the request record, explicitly distinguishing both from the decision maker's wording. Keep complete direction and restrictions there when they do not fit the summary.

Extract project-specific requirements into the handwritten `本项目自定.md` in the project root, one per line with a reference: requirement followed by `出处:资料/决策者原话.md 第 N 条`. Do not invent or expand them. Project-specific requirements override generic ones. Mark an overridden rule `压 G-xxxx` and remove the same identifier through `[手调] 减` in the requirement card, with reason `本项目自定压掉`.

## ③ Start the requirement card from the nearest profile

List the profiles:

```text
python3 -X utf8 tools/trim.py profiles
```

Copy the closest file from `profiles/` to `requirements.toml` at the pack root. Edit its values from the answers. Keep quotation marks around Chinese TOML table and key names, such as `["项目"]` and `"名"`, and keep the seven feature values as `true` or `false`. Choose `novel-writing.toml` for novels and `short-video.toml` for short videos. For programming projects up to 200,000 lines, choose `medium-software.toml`; choose `large-research.toml` above that size or for continuing development across many responsibilities. Use `small-software.toml` only when the decision maker explicitly requests one window throughout.

Prefer `[规模] 档 = ""` for inferred scale. Check large first: concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4. Otherwise medium means windows >=4, owners >=2, repositories >=2 with deployment, or programming. Everything else is small. Repositories may contain code or office materials. One window, one owner, two repositories with deployment is medium. Novel writing uses two windows and one owner; short video uses three and one; both are small. An explicit scale wins, with a warning when it differs from inference.

Programming projects start at medium scale. Up to 200,000 expected lines, use medium-software with only two windows by default: the coordinator handles planning and requirements checks, and one technical lead owns all technical work (G-0222). Above 200,000 lines, explicitly set `"档" = "大"` and add module leads. Set `"档" = "小"` only when the decision maker explicitly requests one window throughout.

`[称呼]` accepts 项目名, 决策者, 总协调, 受众, 成品, 真源件, 留痕处, 口径件, 规矩总件, 作业件, and 接管件. Missing or blank values use defaults. Project name, audience, and output come from `[项目]`; the remaining defaults are 决策者, 总协调, 项目真源.md, 记录.md, 当日口径.md, 宪法.md, 作业规矩.md, and 接棒记录.md. These names substitute into prose, not fixed output filenames. Explain any mapping to differently named actual files.

`[手调] 加` and `减` default to empty lists. Add or remove specific identifiers from [the entries](entries.md) only with reasons. Additions run before removals, so removal wins if both name an identifier. Replace the example identifier with an actual applicable one:

```toml
["手调"]
"加" = [{"编号" = "G-0001", "理由" = "此项工作现在已经需要。"}]
"减" = []
```

## ④ Validate and generate

```text
python3 -X utf8 tools/trim.py validate
python3 -X utf8 tools/trim.py generate --card requirements.toml --out pending
```

The default input is `entries.jsonl` at the pack root. Use `--entries file.jsonl` to select another input. `table --entries file.jsonl` produces [a readable table](entries.md) beside that input. Chinese commands `出`, `校验`, `表`, and `档案`, and arguments `--条目`, `--卡`, and `--出`, remain available for existing callers.

Stop on validation or dependency errors, explain affected identifiers and causes, and correct the card or entries before regenerating. Never silently restore dependencies. Every retained rule includes its rationale. Generate an empty `当日口径.md` only when retained rule text references it.

If the destination has no handwritten `本项目自定.md`, the tool also writes `本项目自定_样板.md` as a reference. If the handwritten file exists, it writes no template. The tool never generates, moves, or overwrites the handwritten file.

## ⑤ Present the reduced set to the decision maker

Read `pending/裁剪记录.json` and `pending/拆掉清单.md`. Briefly explain the scale, features, retained and removed modules, restoration conditions, and assumptions. Summarize fully removed modules in one line with counts and the most common restoration condition; list partial removals individually. Full rationales remain in [the entries](entries.md), and individual removal reasons and restoration conditions remain in the JSON record. Include rule identifiers without asking the decision maker to read code.

The first window may recommend at most five project-specific requirements based on current practice for that project type, explicitly labeled suggestions rather than original wording, each with a short reason. Examples include historical-source references, financial-data privacy and backups, or tenant isolation. Include suggestions in the report only. Append a suggestion to `本项目自定.md` only after individual approval, citing the decision maker's approval and system-derived time. Do not write rejected suggestions. If a suggestion overrides a generic rule, update `[手调] 减` as in step ②.

Present the complete selection report once using the following template and wait for approval or edits. Acceptance of recommendations means follow them. Change the card and regenerate rather than editing generated files.

### Message to the decision maker

```text
本次规模与特征：……
留下：……
拆掉与加回时机：……
预设与岗位：……（写程序的项目缺省两窗：总协调 + 技术主窗）
工期：……（AI 工时，人类工时 ÷ 15；例：150 天 → 10 天）
自主假设：……

建议写进本项目自定（最多 5 条，无建议写“无”）：
1. 建议(非原话)：……；为什么：……
请逐条确认是否同意；点头的才写入本项目自定.md，出处记“决策者 <时刻> 同意第一窗建议”，不点头的不写。

现在落地还是先停？
```

For programming projects, after approval split the first assignments by feature: one person delivers data, logic, interface, and tests together. Record each assignment title, dependencies, and one acceptance sentence stating what users can see when opening the result (G-0223). Before dispatch, ask whether one person can finish it; if so, keep it as one assignment owned by one person.

## ⑥ Place the results and document the reading order

After approval, save the requirement card and generated files under the project root. If the pack is elsewhere, retain it for future regeneration. Move existing same-named generated files into a new `_旧版/` subdirectory first, without overwriting or deleting them. Do not arbitrarily move the pack's documentation or materials, or move or overwrite the handwritten `本项目自定.md`.

Every new window reads `开窗必读.md`, then `本项目自定.md` if present, `宪法.md`, and `作业规矩.md`; read `做法建议.md` when methods are needed and `当日口径.md` only if generated.

Create matching three-line `CLAUDE.md` and `AGENTS.md` entries in the project root so supported assistants can discover the reading order: address the decision maker in plain Chinese; first read `开窗必读.md` and follow its order; preserve timestamped decisions, cross-window values and time ranges, running helpers, and their waits during context compaction. Append those three lines to existing files without replacing their content. These entries contain pointers and compaction reminders, not another rule set. `拆掉清单.md` explains removals and restoration, while `裁剪记录.json` retains identifiers and input hashes.

## ⑦ Restore rules as the project grows

Periodically consult restoration conditions in `拆掉清单.md`. Its summary for a fully removed module gives the most common condition only; consult the JSON record or [entries](entries.md) for individual conditions without inventing another threshold set. Recheck the card when specified counts or work change: four or seven windows, two or six owners, multiple repositories with deployment or starting programming for medium scale, at least four owners for the large deployment case, or newly enabled code, deployment, bulk assets, authoritative values, multiple models, review, or rule storage. Individual rule conditions determine restoration.

Update counts, scale, and features, validate, and regenerate. Explain what is restored and why. Use reasoned manual additions only when a single rule is actually needed. Recheck shrinking projects too, rather than burdening them with obsolete large-project rules.

Append new enduring project-specific requirements with their original-wording references as in step ②, and update manual removals for generic rules they override.

Regeneration moves existing generated files into `_旧版/第若干次/` before writing replacements, deleting none and leaving other handwritten materials alone. When generating into a pending directory then copying to the project root, archive the root's old generated files too. Append the reason and current system time to work records, retain previous cards and wording, and never rewrite history as though it were the new decision.
