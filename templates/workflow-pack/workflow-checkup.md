You are this project's checkup window. Follow this inventory before making changes.

# Workflow checkup (existing projects)

English | [中文](workflow-checkup.zh.md)

Use this guide for an operating project with its own files and rules, whether introducing this pack for the first time or checking rules previously generated from it. Python 3.11 or later is required. Run commands from the copied workflow-pack directory. The project root is the folder containing the project's main files.

## ⓪ Choose one of two cases

- **A · An existing project not using this pack**: first adoption. Follow ①②③, then ⑤⑥.
- **B · Already trimmed with this pack**: `requirements.toml` or `裁剪记录.json` exists in the project root. Follow ①②④, then ⑤⑥.

For both, explain first that the default is **to fill gaps only**. Existing project rules and names take precedence. Replace everything with this pack only when the decision maker explicitly requests it.

## ① Record the original request

Append this request verbatim to `资料/决策者原话.md` under the project root with the date and time obtained from the current system. Append only; do not overwrite or mix interpretation into the original wording. Do not modify project files before the inventory.

## ② Read-only inventory

Read only rule-related files under the project root: `CLAUDE.md`, `AGENTS.md`, and files whose names suggest constitutions, rules, charters, operations, current policy, memory, handoffs, or work records, plus files explicitly named by the decision maker. Do not inspect directories outside the project or scan code and assets. Change nothing in this step. Show the decision maker a table of file, bytes, and purpose.

## ③ Case A · Compare rules sentence by sentence

Compare the inventoried rules against `entries.md`, dividing them into four classes:

| Class | Criterion | Action |
| --- | --- | --- |
| Existing | The project's sentence covers the same subject as a generic rule | Record the matching identifier; do not rewrite it |
| Project-specific | A project requirement absent from the generic entries | Propose it for `本项目自定.md`, with original-wording evidence for each |
| Conflict | The wording differs from a generic rule | List the original sentence, generic identifier, different outcomes, and recommendation for the decision maker |
| Missing | Applicable to the project's scale and features but absent from its rules | List it and add it through trimming after approval |

Retain existing project terminology in the card's `[称呼]` table so generated prose uses those names. Fill `requirements.toml` from actual conditions using `getting-started.md` ③ (default to two windows: requirements and technical lead), generate into `pending/`, and present the result.

## ④ Case B · Check ten kinds of problem

Check every inventoried rule sentence for the following ten issues. List file:line, original sentence, recommendation (delete, replace with a pointer, choose one, or retain), and basis:

1. Contradictory sentences: two statements disagree about the same matter; the decision maker chooses which remains.
2. Duplicate sentences: retain one copy and replace the others with pointers to it.
3. Expired or superseded wording: an old sentence remains after a newer decision replaced it.
4. Broken references: a referenced file, identifier, or section does not exist.
5. Rules in memory or handoff files: move enduring requirements from temporary records into the rule document.
6. Expanded paraphrases: wording enlarges the original request, such as turning “Ask this time” into “Always ask first.” Restore the original meaning.
7. Added approval requirements: recommend deleting “ask first,” “wait for approval,” or “must first” requirements outside the four safeguards: money, irreversible actions, secrets and security, and the decision maker's direction and aesthetics.
8. Waiting on settled decisions: replace “undecided” when the decision maker has already decided.
9. Changed scale: if project size or work type changed, update the requirement card, regenerate, and list rules to restore or remove.
10. Too many windows: if three or more windows remain open long-term without the strain signals in G-0222, recommend merging back to two windows (requirements and technical lead), leaving the decision to the decision maker.

Only move text, adjust pointers, and remove duplicates yourself. Whether a rule belongs and which conflicting sentence wins remain the decision maker's choices; recommend an answer for each.

## ⑤ One-screen report

Use the following report. “Follow the recommendations” means execute the recommendations shown.

```text
现状一句:……
保留:……
建议补:……
建议删 / 并:……(逐条带文件:行)
冲突待你定:A …… / B ……(各一句影响)+ 推荐 ……
自主假设:……
```

## ⑥ Apply after approval

1. Move complete originals into `_旧版/<date-time>/` under the project root before editing; delete none.
2. For regeneration, follow `getting-started.md` ④⑥: update the card, run `python3 -X utf8 tools/trim.py validate`, then `python3 -X utf8 tools/trim.py generate --card requirements.toml --out pending`, and place generated files in the project root.
3. Append missing lines only to `CLAUDE.md` and `AGENTS.md`, without replacing existing content.
4. Run `python3 -X utf8 tools/trim.py validate` again and confirm zero errors.
5. Add one work-record line describing the change and rollback by copying originals back from `_旧版/`.

## ⑦ When to repeat

Repeat case B when window, responsibility, or repository counts change substantially, or rules become confused or contradictory. After accumulating new decisions, append their original wording to the project-specific requirements and regenerate.
