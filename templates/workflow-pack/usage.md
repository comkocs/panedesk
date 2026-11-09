# Usage

English | [中文](usage.zh.md)

## What this pack contains

This portable AI collaboration pack contains 225 selectable rules in 16 modules, from safeguards, decisions, and authoritative sources to review and rule storage. You need not adopt all of them or remove them individually: describe the project, then let its first AI window select a sufficient set by scale and work type.

It differs from a process-only pack in two ways:

- **Every rule includes a rationale**, identifying the actual problem it prevents and the decision maker's intent, rather than an unexplained instruction.
- **Rules are reduced to the project**, with unused rules removed and explicit conditions for restoring them. Novel writing does not need the software-development rule set, and a one-person video channel does not automatically need a review role.

## Three entry points: choose one

- **Requirements review**: for a new project without product documents, design the product first. Optional; any chat window can do it. Opening request: **“/workflow-pack Read requirements-review.md in the workflow pack and help me design the product development documents; revise them over several rounds until finalized.”**
- **Workflow setup**: for a project with product documents or a completed requirements review, use a programming window that can run commands. Opening request: **“/workflow-pack You are this project's first window. Read getting-started.md in the workflow pack and follow it to set up the workflow before starting work.”**
- **Workflow checkup**: review the workflow of an existing project. Opening request: **“/workflow-pack Read workflow-checkup.md in the workflow pack and give this project a workflow checkup.”**

## Starting a new project

1. Copy the complete directory into the new project, not a single rule document. Python 3.11 or later is the only tool requirement; the AI window can run it for you.
2. Open the first AI window with the workflow-setup request above, then describe what you want to make.
3. The window first finds product documents: use those you supplied or placed under `需求/`; otherwise scan the project directory read-only for product, requirements, development, PRD, or prototype materials. If none exist, ask three questions: what to make, for whom, and what the first version must include. For a full requirements review first, use `requirements-review.md`. With documents, derive the ten answers directly and ask only the few missing questions affecting scale. Accept recommendations when uncertain.
4. The window creates `requirements.toml`, selects rules, and presents one report for approval covering retained rules, removals, restoration conditions, profile, window count, duration (AI work, traditional human work ÷ 15; for example 150 days → 10 days), and autonomous assumptions. Programming projects default to just two windows: coordinator and technical lead. It may recommend up to five project-specific requirements, but **only individually approved suggestions are added**. After approval, programming projects also receive initial feature assignments, each with one acceptance sentence stating what users can see when opening the result.
5. After approval, generated rules go into the project root. Each later window reads `开窗必读.md` and follows its order rather than relying on AI memory. The first window also creates matching three-line `CLAUDE.md` and `AGENTS.md` entries, appending to existing entries without replacing their content.

Handwrite project-specific requirements, such as consistency with earlier fictional settings, in `本项目自定.md`, each with a reference to original wording. These override generic rules. The trimming tool never generates, moves, or overwrites that file, including during regeneration.

## How many rules remain

The source pack reports trials with four simulated projects: a first window followed the guide, another reviewed from the project owner's perspective, two revision rounds followed, and an independent audit checked the result. The following are source-reported regeneration results for the current pack version, not measurements of this host application session. Review-role and rule-repository features were off:

| Project | Scale | Retained | Constitution + operational rules (UTF-8 bytes) |
| --- | --- | ---: | ---: |
| One author writing a 600,000-character serial novel, one or two windows | Small | 29 | 10,948 B |
| One creator making historical-trivia short videos, two or three windows | Small | 33 | 12,688 B |
| One person developing a mobile bookkeeping app with frontend, backend, and test responsibilities | Medium | 105 | 34,262 B |
| An online collaboration platform with ten windows and three code repositories | Large | 196 | 64,871 B |
| A deployed small software product with two windows and one code repository | Medium | 105 | 34,001 B |

The last row illustrates the new scale inference: even with few windows, writing and deploying software starts at medium scale so the programming rules are available together.

The large-research profile with every feature enabled retains all 225 rules.

## Growing or shrinking the project

When windows or responsibilities increase, or code, deployment, or bulk asset work starts, consult `拆掉清单.md`. It groups removals by restoration conditions, such as reaching medium scale or starting programming. Individual conditions remain in [entries](entries.md). Update the requirement card and regenerate rather than editing generated rules. Individual additions and removals require reasons. Removing a required dependency causes an error; the tool never silently restores it.

Regeneration moves old generated files into `_旧版/` without deleting them. Retain earlier cards and reasons so past selections remain traceable. Recheck shrinking projects too rather than retaining an obsolete large-project rule set.

## Five starting profiles

| Profile | Suitable projects |
| --- | --- |
| `large-research.toml` | Long-running collaboration with many windows and responsibilities, potentially including code, deployment, assets, values, and multiple models. |
| `medium-software.toml` | One coordinator and one technical lead developing software up to 200,000 lines for deployment and maintenance. |
| `small-software.toml` | One window completing a tool or prototype without maintaining an online product; use only when the decision maker explicitly requests one window throughout. |
| `novel-writing.toml` | Serial chapters based on a setting reference and outline. |
| `short-video.toml` | Finished videos based on a topic collection, scripts, and assets. |

Profiles are starting points, not permanent labels. Check large first: concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and owners >=4. Otherwise medium means windows >=4, owners >=2, repositories >=2 with deployment, or programming; everything else is small. Projects expected to involve programming start at medium scale. Repositories may hold code or office material. Publishing articles, finished videos, or public code does not itself count as deployment. Adjust the card to actual conditions, asking for a recommendation when uncertain.

Review and rule-storage modules do not activate solely because scale is large. The separate `审查岗` and `规矩库` features mean an independent read-only review role, and structured storage of rules and original wording with daily exports. Both default to false; only the large-research profile enables them.
