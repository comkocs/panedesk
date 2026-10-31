# Usage

English | [中文](usage.zh.md)

## What this pack contains

This portable AI collaboration pack contains 215 selectable rules in 16 modules, from safeguards, decisions, and authoritative sources to review and rule storage. You need not adopt all of them or remove them individually: describe the project, then let its first AI window select a sufficient set by scale and work type.

It differs from a process-only pack in two ways:

- **Every rule includes a rationale**, identifying the actual problem it prevents and the decision maker's intent, rather than an unexplained instruction.
- **Rules are reduced to the project**, with unused rules removed and explicit conditions for restoring them. Novel writing does not need the software-development rule set, and a one-person video channel does not automatically need a review role.

## Starting a new project

1. Copy the complete directory into the new project, not a single rule document. Python 3.11 or later is the only tool requirement; the AI window can run it for you.
2. In the first AI window, request: **“Read getting-started.md in the workflow pack, check my requirements, then start work.”** In host application, the bundled `workflow-pack` skill provides the same entry. Describe the desired project next.
3. Answer its questions, at most ten: audience, output, concurrent windows, responsibilities, and whether code, deployment, or bulk assets are involved. Accept recommended answers when uncertain; unspecified choices remain reported assumptions.
4. The window creates `requirements.toml`, selects rules, and explains retained rules, removals, and restoration conditions in plain language. It may recommend up to five project-specific requirements, such as historical-source references, but **only individually approved suggestions are added**. Approve or request changes without reading code.
5. After approval, generated rules go into the project root. Each later window reads `开窗必读.md` and follows its order rather than relying on AI memory. The first window also creates matching three-line `CLAUDE.md` and `AGENTS.md` entries, appending to existing entries without replacing their content.

Handwrite project-specific requirements, such as consistency with earlier fictional settings, in `本项目自定.md`, each with a reference to original wording. These override generic rules. The trimming tool never generates, moves, or overwrites that file, including during regeneration.

## How many rules remain

The source pack reports trials with four simulated projects: a first window followed the guide, another reviewed from the project owner's perspective, two revision rounds followed, and an independent audit checked the result. The following are historical source-pack results, not measurements of a current host application session. Review-role and rule-repository features were off:

| Project | Scale | Retained | Constitution + operational rules (UTF-8 bytes) |
| --- | --- | ---: | ---: |
| One author writing a 600,000-character serial novel, one or two windows | Small | 27 | 9,946 B |
| One creator making historical-trivia short videos, two or three windows | Small | 31 | 11,686 B |
| One person developing a mobile bookkeeping app with frontend, backend, and test responsibilities | Medium | 96 | 30,853 B |
| An online collaboration platform with ten windows and three code repositories | Large | 186 | 61,028 B |

The large-research profile with every feature enabled retains all 215 rules.

## Growing or shrinking the project

When windows or responsibilities increase, or code, deployment, or bulk asset work starts, consult `拆掉清单.md`. It groups removals by restoration conditions, such as reaching medium scale or starting programming. Individual conditions remain in [entries](entries.md). Update the requirement card and regenerate rather than editing generated rules. Individual additions and removals require reasons. Removing a required dependency causes an error; the tool never silently restores it.

Regeneration moves old generated files into `_旧版/` without deleting them. Retain earlier cards and reasons so past selections remain traceable. Recheck shrinking projects too rather than retaining an obsolete large-project rule set.

## Five starting profiles

| Profile | Suitable projects |
| --- | --- |
| `large-research.toml` | Long-running collaboration with many windows and responsibilities, potentially including code, deployment, assets, values, and multiple models. |
| `medium-software.toml` | Several responsibilities developing software intended for deployment and maintenance. |
| `small-software.toml` | One or two windows making a tool or prototype without maintaining an online product. |
| `novel-writing.toml` | Serial chapters based on a setting reference and outline. |
| `short-video.toml` | Finished videos based on a topic collection, scripts, and assets. |

Profiles are starting points, not permanent labels. Check large first: concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and owners >=4. Otherwise medium means windows >=4, owners >=2, or repositories >=2 with deployment; everything else is small. Repositories may hold code or office material. Publishing articles, finished videos, or public code does not itself count as deployment. Adjust the card to actual conditions, asking for a recommendation when uncertain.

Review and rule-storage modules do not activate solely because scale is large. The separate `审查岗` and `规矩库` features mean an independent read-only review role, and structured storage of rules and original wording with daily exports. Both default to false; only the large-research profile enables them.
