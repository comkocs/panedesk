# Entries

English | [中文](entries.zh.md)

Entries SHA-256: `9bbd18e6118c3f79f0beceb982dc5b20f90a309aa8f106e5252cb593e097da0e`

Generated from `entries.jsonl`; edit the data before regenerating this table.

## Safeguards

**Rules define limits, not scripts**〔G-0001〕{{规矩总件}} defines limits, responsibilities, and minimum safeguards, not an operating script. Distinguish enduring limits from current requirements, marking them in the same document if useful. Choose methods locally; do not promote volatile methods into permanent rules or add approval and delivery checkpoints.
> Rationale: Rules limit authority without limiting creativity; improve through correction rather than accumulating checks.

Layer: constitution; Scale: small–large; Features: ; Dependencies: ; Source count: 3.

Restore condition: Keep when there is at least one task.

**Act and report outside four exceptions**〔G-0002〕Ask first only about money, irreversible actions, secrets and safety, and {{决策者}}'s direction or aesthetics. Irreversible actions include permanent deletion, public release, and changes to {{规矩总件}}. Within current authorization, perform other reversible actions and report afterward; corrections are not grounds for blame. Record the action and reversal in {{留痕处}} without another approval step. Money means spending by the project itself (buying services, paid APIs, or external payments); charging features within the product are requirements. Public release means publication and listing for the public, not submitting applications to platform operators on behalf of {{决策者}}.
> Rationale: Act independently where authorized, report afterward, and correct problems rather than waiting for permission on every action.

Layer: constitution; Scale: small–large; Features: ; Dependencies: G-0049; Source count: 2.

Restore condition: Keep when there is at least one task.

**Update small-project safeguards directly**〔G-0003〕At small scale, changes to {{规矩总件}} require an explicit decision by {{决策者}}. The responsible window updates its text, version, and date through the existing entry, without a separate amendment relay.
> Rationale: A few windows can update the current entry directly; this reflects experience in the source project.

Layer: constitution; Scale: small–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Keep when there is at least one task.

**Synchronize safeguard amendments**〔G-0004〕Changes to {{规矩总件}} require an explicit decision by {{决策者}}. {{总协调}} writes the amendment, updates its version and date, and synchronizes all active entry pointers.
> Rationale: Prevent entry pointers from referring to obsolete versions after amendments, as observed in the source project.

Layer: constitution; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Separate disclosure and distribution limits**〔G-0005〕Never disclose code, assets, credentials, or private materials explicitly marked confidential. Exclude content explicitly barred from distribution from the public {{成品}}; including it is a delivery failure.
> Rationale: Prevent confidential or distribution-restricted content from crossing its permitted limits, as observed in the source project.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Keep when there is at least one task.

**Move obsolete files before deletion**〔G-0006〕Distinguish active from inactive files. Move unused working copies, temporary files, old outputs, and assets into pending-deletion or retired directories, recording old and new locations in {{留痕处}}. {{决策者}} performs permanent deletion personally.
> Rationale: Collect obsolete files first and let their owner decide whether to delete them permanently; collection must not itself destroy them.

Layer: constitution; Scale: small–large; Features: ; Dependencies: G-0049; Source count: 4.

Restore condition: Keep when there is at least one task.

**Keep credentials in protected storage**〔G-0007〕Store passwords and tokens only in dedicated protected records, never in chat, assignments, receipts, ordinary documents, command lines, logs, or version repositories.
> Rationale: Ordinary records must not become channels for spreading credentials; this reflects experience in the source project.

Layer: constitution; Scale: small–large; Features: ; Dependencies: ; Source count: 3.

Restore condition: Keep when there is at least one task.

**Stop only processes you started**〔G-0008〕Record identifiers of background processes you start. Before stopping helpers or closing a window, reclaim only processes identified in your own records; never terminate all same-named processes on the machine.
> Rationale: Reclaim orphaned processes without terminating other work.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 2.

Restore condition: Restore when maintaining at least one code repository.

**Allow recoverable repository deletion**〔G-0215〕Within current task authority, files protected by complete version history may be deleted after confirming recovery from history. Do not extend this exception to unversioned local files or permanent deletion.
> Rationale: Reliable version-history recovery differs from permanent loss, but that exception does not cover ordinary files.

Layer: constitution; Scale: small–large; Features: code; Dependencies: G-0006; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

## Decisions and original wording

**Use plain Chinese with the decision maker**〔G-0009〕Address {{决策者}} in plain Chinese, explaining rather than substituting jargon. Use Chinese filenames and prompts, reserving English for internal artifacts and code.
> Rationale: The recipient must understand the message; the sender's belief that it is complete is insufficient.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Keep when there is at least one task.

**Separate requirements from methods**〔G-0010〕{{决策者}} alone decides requirements, direction, aesthetics, and final disputes. Executors choose methods within their authorization using current leading practice. Method suggestions from the decision maker are not commands: explain and decline with professional grounds, but follow and record the original wording if the decision maker insists after reviewing them.
> Rationale: Provide professional evidence without turning every method suggestion into a permanent requirement.

Layer: constitution; Scale: small–large; Features: ; Dependencies: ; Source count: 6.

Restore condition: Keep when there is at least one task.

**Explicit decisions take effect immediately**〔G-0011〕An explicit decision by {{决策者}} in any conversation or window takes effect immediately, without requiring a new task, archive entry, or confirmation first.
> Rationale: Prevent extra procedures from delaying explicit decisions, as observed in the source project.

Layer: constitution; Scale: small–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Keep when there is at least one task.

**Preserve original wording and references**〔G-0012〕Append {{决策者}}'s original wording verbatim with its time, recording window, and stable identifier; never overwrite it and retain original images. Separate wording from interpretation, and trace transcribed statements and table values to their originals without inventing decisions. Answer questions about existing decisions from records; one record file suffices without building a system.
> Rationale: Original wording is evidence. Consultation is not a decision, later interpretation must not overwrite it, and references must remain traceable.

Layer: constitution; Scale: small–large; Features: ; Dependencies: ; Source count: 8.

Restore condition: Keep when there is at least one task.

**Explain questions without exceeding authority**〔G-0013〕Ask at most five questions per exchange, explaining consequences and a recommendation. Separate direction questions from autonomous assumptions and never decide direction without authority. Make authorized technical choices yourself, stating what was done and how to reverse it; deliver unrelated work normally. Record decisions in {{留痕处}}, not consultation assumptions as decisions.
> Rationale: Questions must be understandable; consultations and assumptions must not masquerade as settled direction.

Layer: operations; Scale: small–large; Features: ; Dependencies: G-0049; Source count: 6.

Restore condition: Keep when there is at least one task.

**Check evidence before claiming a decision**〔G-0014〕Before reporting that {{决策者}} decided something, check the original wording. Before reporting no decision, inspect all registered {{真源件}} and related tasks. Mark unsupported decisions uncertain; for reversible actions outside the exceptions, follow common practice or the recommendation and report afterward.
> Rationale: Prevent declaring a decision absent after an incomplete search, or settled without original wording, as observed in the source project.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 3.

Restore condition: Keep when there is at least one task.

**Forward unanswered direction questions unchanged**〔G-0015〕List direction questions individually with options and authorized defaults, separately from autonomous assumptions. {{总协调}} forwards them unchanged to {{决策者}}. Finish work that does not depend on the answer and adjust afterward; never treat unauthorized direction as decided.
> Rationale: Prevent mixing direction questions with assumptions or making unrelated work wait, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Do not change an accepted result**〔G-0216〕Do not change a result that {{决策者}} personally inspected and explicitly accepted. For optimization, including performance, first explain in plain language what will change and how usage will differ; then start without waiting for approval. Stop or revert if {{决策者}} declines. If the result is worse, first recover the accepted version and use it as the reference. Internal rewrites that do not change appearance or feel do not count as changing the result.
> Rationale: Later optimizations can silently damage an accepted result and make recovery harder than the original work. Explaining first lets the decision maker object without requiring approval.

Layer: operations; Scale: small–large; Features: ; Dependencies: G-0012; Source count: 1.

Restore condition: Keep when there is at least one task.

**Estimate schedules in AI work time**〔G-0224〕Always estimate schedules in AI work time: first estimate traditional human-work days, divide by 15 (for example 150 days → 10 days), and state the conversion. Do not discourage a design on the basis of human engineering effort.
> Rationale: Human-work estimates can turn a day of work into a reported two weeks and cause good designs to be rejected for excessive effort.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Keep when there is at least one task.

## Authority and completion

**Maintain one authoritative value**〔G-0016〕Keep one authoritative {{真源件}} for each rule or value; implementations, tables, and historical archives do not establish separate definitions. Link documentation instead of copying values. When restatement is necessary, register its source; whoever changes a value synchronizes affected statements.
> Rationale: Repeated values drift after changes unless the changing party also owns affected statements.

Layer: operations; Scale: small–large; Features: values; Dependencies: ; Source count: 2.

Restore condition: Restore when centrally maintaining at least one set of rules or values.

**Change implementation and descriptions together**〔G-0017〕When the current implementation is designated to determine a rule's final value, tables and descriptions follow it. After {{决策者}} approves a change, align implementation, tables, and descriptions in the same change. Correct inconsistent derived descriptions rather than introducing another final value.
> Rationale: Changing implementation while retaining old values in tables and descriptions creates conflicting answers.

Layer: operations; Scale: small–large; Features: code, values; Dependencies: G-0016; Source count: 1.

Restore condition: Restore when maintaining at least one code repository and centrally maintaining at least one set of rules or values.

**Maintain shared requirements once**〔G-0018〕Maintain shared requirements only in {{作业件}}; each role adds only its particular responsibilities rather than another set of shared rules. Resolve conflicts first through {{规矩总件}}, then {{作业件}}; role descriptions cannot override shared requirements.
> Rationale: Prevent copied shared requirements from expiring independently, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 6.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Verify the actual delivery target**〔G-0019〕When delivering only a draft to {{决策者}}, check that it opens and is complete; publication is not required first. When delivering {{成品}} to {{受众}}, check acquisition and use through the agreed entry. Before claiming a file was saved, verify it exists and is nonempty; inventories and verbal claims do not replace inspection.
> Rationale: Lists and active labels do not establish actual delivery, and a write notification alone does not establish a saved file.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 4.

Restore condition: Keep when there is at least one task.

**Check existing resources before reporting gaps**〔G-0020〕Before reporting a missing delivery resource, inspect existing libraries. If it remains missing, report to {{决策者}} rather than presenting an inadequate substitute as {{成品}}.
> Rationale: An existing resource may simply not have been found; do not report absence before checking or substitute an inadequate item.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Keep collaboration progress in one place**〔G-0021〕Maintain quantities, progress, and completion requirements only in {{留痕处}}, based on actual delivery. Elsewhere provide locations rather than copies. Use structured data only when software must read it; history is not current progress.
> Rationale: Prevent contradictory progress copies or historical records being presented as current state, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: G-0049; Source count: 6.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Explain product integration at code delivery**〔G-0022〕Code delivery requires the agreed tests to pass and identifies integration into behavior perceptible to {{受众}}. Explicitly state when no such behavior exists. Purely internal tasks finish at merge.
> Rationale: Prevent tested code from being delivered without integration into actual use, as observed in the source project.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Identify the real consumer before assignment**〔G-0023〕Before assigning work, state who reads or uses the output on the actual {{成品}} delivery path. Do not assign a task whose real consumer cannot be identified.
> Rationale: Prevent unused outputs from being counted as effective delivery, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Deliver the agreed transcription**〔G-0024〕When transcription is agreed, original expressions count as an executable {{真源件}} only after that transcription is complete. Retain the original materials as evidence.
> Rationale: Prevent an untranscribed draft from being treated as an executable authority, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Resolve copying differences against authority**〔G-0025〕Assignments containing values include a repeatable verification method. When drafting reveals a mismatch between a question and {{真源件}}, report each item rather than changing the question. During execution follow the authoritative source for copying discrepancies, recording them at delivery without adding a work-stoppage prerequisite.
> Rationale: Prevent copying errors from replacing authoritative values or causing unnecessary stoppages, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Keep small-project delivery reports short**〔G-0026〕At small scale, verify and briefly report the deliverable and its location. Add remaining work, autonomous assumptions, or takeover operations only when they exist; do not complete three questions after every edit. Helpers may draft, but the responsible window verifies facts. Correct record-format errors without representing them as failed outputs.
> Rationale: Delegating writing does not transfer verification responsibility, and procedural errors must not unnecessarily stop work.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 4.

Restore condition: Keep when there is at least one task.

**The delivery owner verifies the report**〔G-0027〕Write reports yourself or delegate drafting, but the delivery owner checks files, key values, and actual results; drafts are not verified evidence. Report failures honestly and explain missing measurements. Do not claim acceptance without an accepting person; state necessary caveats, uncertainty, and autonomous assumptions.
> Rationale: Drafting is not fact verification; completion claims require actual outputs, not a one-off delegated draft.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 6.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Distinguish matches from actual reads**〔G-0028〕When surveying files, distinguish comment matches from actual reads and references. Registry entries and resource-root names follow the starting revision, not old reports presented as current facts.
> Rationale: Prevent comment matches and obsolete reports from substituting for current consumption, as observed in the source project.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Missing records do not mean zero assets**〔G-0029〕When an inventory is empty or classification is unregistered, report missing records only; do not infer that the asset count is zero.
> Rationale: An empty inventory or absent classification means no statistical record, not no assets.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Leave unsettled values blank**〔G-0030〕When adding terms about rules or values, leave values blank during the placeholder stage; do not publish undecided values as formal content.
> Rationale: Prevent unsettled values from becoming official definitions, as observed in the source project.

Layer: operations; Scale: small–large; Features: values; Dependencies: ; Source count: 1.

Restore condition: Restore when centrally maintaining at least one set of rules or values.

**Check descriptions after their authority is ready**〔G-0031〕Check descriptions derived from rules after the rules are complete; do not treat rules still being written as a completed checking authority.
> Rationale: Prevent checking descriptions against unsettled rules and producing obsolete statements, as observed in the source project.

Layer: operations; Scale: small–large; Features: values; Dependencies: ; Source count: 1.

Restore condition: Restore when centrally maintaining at least one set of rules or values.

**Approve rule changes before implementation**〔G-0032〕When {{真源件}} for rules or values changes, {{决策者}} first decides and records the ruling; implementation is assigned afterward.
> Rationale: Prevent implementation of rules before approval, as observed in the source project.

Layer: operations; Scale: small–large; Features: values; Dependencies: G-0016, G-0012; Source count: 1.

Restore condition: Restore when centrally maintaining at least one set of rules or values.

**Keep shared helper definitions authoritative**〔G-0033〕Designate one {{真源件}} for shared helper definitions. Synchronize necessary copies with it and verify them by the agreed method; copies cannot evolve into separate definitions.
> Rationale: Prevent shared definitions from diverging after independent edits, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Search relevant locations first**〔G-0034〕Find reference material, earlier text, or settings by searching relevant directories and files, then read matching passages. Narrow an overly broad or slow search rather than searching the entire disk without limits.
> Rationale: Narrow searches avoid sustained memory and disk use merely to locate a passage.

Layer: methods; Scale: small–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Keep when there is at least one task.

## Responsibilities and authority

**Separate authority at large scale**〔G-0035〕Large collaborations distinguish {{决策者}}, {{总协调}}, and role owners; each owns its corresponding change area. A role owner's window is the construction window, directly assigning helpers and integrating delivery. Add a separate execution window only under G-0085; no permanent employee tier. Concrete execution responsibility is not global command authority.
> Rationale: Prevent execution responsibility from turning into global command authority, as observed in the source project.

Layer: constitution; Scale: large–large; Features: ; Dependencies: G-0085; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**One window delivers small tasks end to end**〔G-0036〕At small scale, one window owns a task from input through complete {{成品}}, including supporting work. If helpers are needed, assign directly and integrate acceptance; do not create lasting stage-specific roles or relay-only layers.
> Rationale: Another relay layer makes one-off work more complicated; one responsible window should deliver it completely.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 7.

Restore condition: Keep when there is at least one task.

**One owner completes each responsibility**〔G-0037〕Name one owner for each responsibility at a time. That owner delivers complete outputs and supporting work and coordinates contributors. On replacement, state completed work, remaining work, and next steps, and update responsibility records; scale growth alone does not justify permanent roles.
> Rationale: Prevent divided ownership, missing supporting work, and discontinuity during handover, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 3.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**The coordinator records rather than approves**〔G-0038〕{{总协调}} registers shared interfaces, writes shared rules and decisions, and coordinates direction without approving work. When absent, each role decides within existing limits and records one line in {{留痕处}}; adjust afterward if necessary.
> Rationale: Shared bookkeeping is not permission to start; a coordinator's absence must not stop authorized work.

Layer: constitution; Scale: medium–large; Features: ; Dependencies: G-0049; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Respect shared protocol ownership**〔G-0039〕Roles must not change shared protocols without authority. Refer necessary changes to {{总协调}} or the role responsible for that protocol.
> Rationale: Prevent unilateral shared-protocol changes from breaking collaboration, as observed in the source project.

Layer: operations; Scale: medium–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when programming starts.

**One contact receives decisions per domain**〔G-0040〕One role receives {{决策者}}'s decisions for each domain, records original wording in {{留痕处}}, and assigns work according to impact. Other roles do not create separate definitions; send changes to the owning role.
> Rationale: A decision in one domain should be told once to a contact who records and distributes it, not repeated to every role.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0049; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Custody does not grant decision authority**〔G-0041〕A role maintaining {{真源件}}, rules, or their database manages inclusion, deduplication, archival, validity, queries, exports, and pointers only according to confirmed rulings. Storage or custody does not transfer amendment rights or grant content, review, or supervision authority; original authorizers still approve.
> Rationale: Prevent custody of authoritative material from being mistaken for authority to decide its content, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 3.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Distinguish repairs from new capabilities**〔G-0042〕Repair restores something intended but broken; a new capability supplies something absent. Assign both through existing responsibilities. For unclear overlapping ownership, align directly first and involve {{总协调}} only if agreement fails.
> Rationale: Related windows previously failed to communicate about overlaps; identifying task type supports direct coordination first.

Layer: operations; Scale: medium–large; Features: code; Dependencies: ; Source count: 2.

Restore condition: Restore when programming starts.

**Main windows retain coordination and conclusions**〔G-0043〕The main window concentrates on dispatch, decisions, integration, and reporting to {{决策者}}. Delegate large-file reading and high-output commands to helpers, receiving verifiable conclusions rather than duplicating all raw output.
> Rationale: Prevent raw output from crowding out main-window coordination and decisions, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Use authorized entries for restricted operations**〔G-0044〕Operations explicitly restricted to particular executors must be performed personally by authorized execution windows, if any, through the unified entry. Different evidence-gathering purposes do not justify bypassing execution permissions or creating another entry.
> Rationale: Prevent evidence-gathering purposes from bypassing execution permissions, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Time-box small-project diagnosis**〔G-0045〕At small scale, if diagnosis of one failure reaches its agreed time limit without a cause, record the confirmed failure and unknown cause and report to {{决策者}}. Deliver the task as agreed rather than investigating indefinitely.
> Rationale: Diagnosis needs a limit and an honest unresolved report rather than blocking delivery without end.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Hand over diagnosis at its time limit**〔G-0046〕When diagnosis of one failure reaches the agreed limit without a cause, record confirmed facts and the unknown cause and ask {{总协调}} to arrange continuation. Deliver the current task as agreed rather than continuing indefinitely.
> Rationale: Prevent one unbounded investigation from blocking delivery, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Separate asset production and use responsibilities**〔G-0047〕If asset creation, organization, and use in {{成品}} have different owners, each maintains only the agreed inventory. Notify actual consumers of new assets with locations and purposes. Do not modify another owner's inventory, output video, or program without authorization; one person doing all work needs no handover role.
> Rationale: Prevent asset producers and consumers from overwriting each other's work or missing delivery, as observed in the source project.

Layer: operations; Scale: medium–large; Features: assets; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts) and assets are involved.

**Temporary tier changes do not alter defaults**〔G-0048〕Maintain helper types and default capability tiers centrally; individual roles do not create or modify them. State temporary overrides only in the current assignment, recording deviations in {{留痕处}} without changing shared defaults.
> Rationale: Prevent temporary tier overrides from contaminating shared defaults, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0049; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Optional read-only consultation window**〔G-0221〕When useful, open a consultation window with all memory that only reads and answers, allowing {{决策者}} to ask about status and align requirements at any time. It assigns no work and edits no files; pass resulting tasks to their responsible windows.
> Rationale: The decision maker can understand the whole project without interrupting active windows or changing their work through conversation.

Layer: methods; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Start with two windows; add only under strain**〔G-0222〕Projects default to only two windows: {{总协调}} (requirements window) handles planning, checks requirements with {{决策者}}, and evaluates delivery against what users can see when opening the result. One technical lead owns all technical work: directly assigns implementation helpers, merges their work, and assigns independent audits. Add windows only when strain signals appear: if the technical window routinely waits more than one hour for requirements, add a requirements-liaison window; if {{决策者}} reports the same kind of problem at least three times after personal testing, add a testing window; if a work category exceeds the technical window’s capacity, add a dedicated window for it. Merge added windows back to the two-window setup after a full week without work.
> Rationale: Most projects can be completed by one requirements window and one technical lead. Splitting frontend, backend, and testing into separate windows from the start adds more handoffs and waiting than work; layers of approval requirements can then produce something the decision maker cannot understand.

Layer: operations; Scale: medium–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when programming starts.

## Records and channels

**Record tasks and requirements once**〔G-0049〕{{留痕处}} holds tasks, deliveries, decisions, progress, and blockers centrally; one file suffices and other places do not copy it. Timestamp new requirements and distinguish {{决策者}}'s requirements from self-chosen arrangements. Notify relevant people directly instead of creating a task for a single message.
> Rationale: State needs a record, but coordination needs no extra procedure; copying current values destroys their single authority.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 8.

Restore condition: Keep when there is at least one task.

**Record state and coordinate directly**〔G-0050〕Record matters requiring status or a reply in {{留痕处}} and notify the relevant working window directly; informational messages need only a record. Contact one or two direct collaborators rather than broadcasting, relaying up hierarchies, or creating tasks for one sentence. Involve {{总协调}} only if agreement fails.
> Rationale: Direct contact avoids waiting and distorted relays when work overlaps or conflicts.

Layer: operations; Scale: medium–large; Features: ; Dependencies: G-0049; Source count: 3.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Execution windows comment only on their tasks**〔G-0051〕Execution windows, if any, comment only on tasks they handle and do not coordinate through unrelated task records.
> Rationale: Prevent execution windows from coordinating unrelated tasks beyond their authority, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Maintain an owned coordination channel**〔G-0052〕Each role keeps one explicit coordination conversation. Send defects and requirements concerning the channel itself to the party maintaining it.
> Rationale: Prevent collaboration without a fixed entry or unowned channel failures, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Timestamp key progress and its baseline**〔G-0053〕Record only agreed key milestones. Each segment includes the current time and shared code-baseline identifier at that moment, allowing other windows to identify the version underlying the work.
> Rationale: Prevent handovers that cannot identify the version associated with progress, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Define counting before measuring**〔G-0054〕When a task explicitly requests statistics, agree on counting first: a command from start to exit is one run, valid only when completed with a determinate result; one test round is the agreed set, and one returned conflict edit is one exchange. Report counts separately and reconcile them with records; do not add counts without a requirement.
> Rationale: Prevent different definitions of the same run count, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Report stagnation without waiting**〔G-0055〕If agreed quantitative measures fail to move toward the target for two consecutive rounds, or an execution window has run four hours, report the current value, gap, and next step to {{总协调}} and record them in {{留痕处}}. Continue working rather than waiting for an answer.
> Rationale: Progress reports reveal stagnation rather than becoming permission checkpoints; act-and-report still follows current authorization.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0049; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Check current requirements before small deliveries**〔G-0056〕At small scale, check new conversation requirements and the active {{口径件}}, if any, before delivery; use the latest effective decision when they conflict. Record receipt time and content of changes and update affected work without a separate receipt report.
> Rationale: A few windows can check current requirements directly; this reflects experience in the source project.

Layer: operations; Scale: small–large; Features: ; Dependencies: G-0121; Source count: 2.

Restore condition: Keep when there is at least one task.

**Check latest requirements before delivery**〔G-0057〕Before delivery, inspect relevant new messages and {{口径件}} once at the same milestone. Record receipt time, content, and impact of changes and follow the latest effective requirements; do not count messages or requirement revisions.
> Rationale: Prevent delivery based on expired requirements, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: G-0121; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Keep detail outside the main report**〔G-0058〕Save detailed tables and subsidiary reports separately as data artifacts. Main reports and progress records contain paths and counts, not duplicated full text. Where a body limit exists, do not evade it by declaring appended sections uncounted.
> Rationale: Prevent repeated detail from inflating main reports, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

## Assignments and dispatch

**Deliver within current authorization**〔G-0059〕Perform only the currently authorized work without expanding scope. Preserve required items and explain each reportable adjustment. Perform authorized operations yourself rather than passing them to {{决策者}}. Ask first for exceptional actions and follow current permissions and delivery requirements.
> Rationale: Prevent authorized operations from being pushed back onto the decision maker, as observed in the source project.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 5.

Restore condition: Keep when there is at least one task.

**One window owns a complete module**〔G-0060〕Assign complete outputs. If one window can deliver the whole task, it verifies authorities, organizes helpers, integrates, and delivers without permanent stage-specific roles. List explicitly authorized cross-role changes at delivery for relevant owners to review; do not withdraw them merely because files have different owners.
> Rationale: Prevent stage-by-stage transfers from leaving no one responsible for complete delivery, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Assign cross-role diagnosis to sufficient capability**〔G-0061〕Cross-role diagnosis and ownership decisions belong to a role with sufficient capability; do not hand an undiagnosed problem directly to an insufficiently capable execution window, if such windows exist.
> Rationale: Prevent unresolved cross-role problems from being handed to underqualified executors, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**One active task per execution window**〔G-0062〕Each execution window, if any, handles only one active task at a time. Transfers keep the original record and history rather than creating a replacement task.
> Rationale: Prevent multitasking windows and task-history loss during transfers, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Save assignments before dispatch**〔G-0063〕Save a cross-window assignment first, then send its path with one instruction explicitly identifying the executor. Keep task, handover, and archival detail in the assignment; send opening instructions intended for {{决策者}} separately.
> Rationale: Prevent verbal assignments without recoverable complete requirements, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**State the output and acceptance conditions**〔G-0064〕Small and medium assignments state who works, the output, frozen items, location, and completion requirements. Check chapters against settings and videos against script, duration, and final footage. State numerical targets and tolerances when present without inventing them; list unchecked items separately and do not automatically promote temporary opinions into requirements.
> Rationale: Explain what to deliver and how to judge it without adding multiple documentation layers or ad hoc criteria.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 7.

Restore condition: Keep when there is at least one task.

**Keep substantial large-task requirements**〔G-0065〕Large assignments state the executor, authorities and settled requirements, delivery effect, checking methods, editable and frozen scope, raw-data sources, destination, independent checks, and unchecked items. Check only relevant content; numerical requirements and tolerances are predetermined. Link standing rules and let the responsible window record arrangements in {{留痕处}}.
> Rationale: Prevent large assignments from omitting authorities, limits, or completion requirements, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0049; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Match capability without downgrading**〔G-0066〕A model capability tier is a minimum capability, not a unique model. Match helpers to task difficulty and known ability, using suitable capabilities for complex judgment, light rewriting, and reading or transcription. If an entry is unavailable, choose another available entry without downgrading. Do not assign visual tasks to incapable types; start reports with the actual model name.
> Rationale: Prevent capability mismatch or downgrading because an entry is restricted, as observed in the source project.

Layer: operations; Scale: small–large; Features: multiple-models; Dependencies: ; Source count: 3.

Restore condition: Restore when delegating to at least two model providers.

**Keep model arrangements in one place**〔G-0067〕{{决策者}} selects the main-window model. Maintain current helper models, tiers, and platform entries in {{口径件}}, read at window opening and before each dispatch; {{作业件}} only links it. Do not derive another order from old tables or quota snapshots or repeatedly ask {{决策者}}.
> Rationale: A shared entry prevents fragmented model arrangements and repeated questions across windows.

Layer: operations; Scale: small–large; Features: multiple-models; Dependencies: G-0121; Source count: 3.

Restore condition: Restore when delegating to at least two model providers.

**Name an owner for deferred work**〔G-0068〕Complete continuation work owed by the current task or explicitly transfer it to a registered task. Do not substitute statements about doing it later or outside the current batch for an ownership arrangement.
> Rationale: Prevent future-work language from hiding unowned obligations, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Assignment length follows clarity**〔G-0069〕Make assignments as long as necessary to explain the work. Do not delete items, merge paragraphs, or alter references to meet an invented size; add no hard length limit.
> Rationale: Prevent necessary requirements from being deleted to fit an arbitrary length, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Draft only from current authorities**〔G-0070〕Draft new assignments from the assignment requirements in {{作业件}} (G-0065, G-0069, G-0082), current facts and decisions, named {{真源件}}, and the role's responsibilities. Do not read entire old assignments, progress records, audits, or other roles' materials, or import unrelated original statements. Consult old similar tasks only for needed conclusions and remaining work.
> Rationale: Prevent old task requirements and unrelated original wording from entering a new task, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0065, G-0069, G-0082; Source count: 4.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Delegated drafting does not transfer verification**〔G-0071〕The dispatcher verifies raw data and supplies precise sources. Helpers transcribe and mark verification pending; the responsible window checks versions and applicability when starting. Reuse values already verified for the same version without measuring again; drafting does not establish verified facts.
> Rationale: Prevent delegated transcription from being treated as fact verification, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Fix measurement arrangements before large studies**〔G-0072〕For concentrated measurements, state each value's source and predetermine repetitions, result location, configuration, and sample size; absent a count, measure once. Explain repetitions and reruns and reuse the same arrangement in later tasks. Renaming a task does not reset counts; the owner decides and records any excess over agreed limits.
> Rationale: Previously measured parameters can be reused without repeating measurements.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Record explicit changes after dispatch**〔G-0073〕The dispatcher states delivery destination and completion requirements. Changes after dispatch require explicit authorization and a record in {{留痕处}}; executors do not change them privately. Reuse checked results when content and conditions are unchanged.
> Rationale: Prevent executors from changing agreed requirements or repeating checks unnecessarily, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: G-0049; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Give helpers only necessary context**〔G-0074〕Give helpers the current task, named passages from {{作业件}}, and necessary materials rather than the entire {{规矩总件}}. Maintain shared behavior constraints only in helper definitions, not copied into assignments.
> Rationale: Prevent irrelevant authorities from consuming context and creating copied rule sets, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Explain assignment difficulty with evidence**〔G-0075〕Before dispatch, list changed files, modules, repositories, and whether data migrates, then choose sufficiently capable executors. If difficulty tiers exist, include their numerical thresholds; otherwise state the actual difficulty without citing undefined tiers. Executors may request stronger capability and record it in {{留痕处}}, but cannot lower requirements.
> Rationale: Prevent underestimated difficulty and capability without an explicit measure, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: G-0049; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Separate responsibilities before parallel work**〔G-0076〕Before parallel execution, list subtasks, owned files, dependencies, and parallel groups. Dispatch a group together only if responsibilities do not conflict; helpers modify only their assigned files.
> Rationale: Prevent parallel tasks from overwriting files owned by one another, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Record only verified model capabilities**〔G-0077〕Capability tables distinguish verified abilities, known limitations, and unverified states. Keep unverified claims marked unverified; related models' behavior and old dispatch order are not evidence for this model.
> Rationale: Adding a path-writing instruction does not establish successful writing, and neighboring model results cannot substitute for a direct measurement.

Layer: operations; Scale: small–large; Features: multiple-models; Dependencies: ; Source count: 1.

Restore condition: Restore when delegating to at least two model providers.

**State helper authority and handback**〔G-0078〕Helper assignments state their execution level, task type, whether further delegation is allowed, waiting rules, output location, and report format. Helpers must not guess their authority or delivery method.
> Rationale: Prevent helpers from guessing permissions and handback requirements, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Dispatch independent tasks together**〔G-0079〕Dispatch independent subtasks together. Put all dependency-ordered steps into the same instructions rather than making helpers wait for supplementary instructions.
> Rationale: Prevent serial waiting between independent tasks and idle helpers awaiting further instructions, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Wake on events and end after handback**〔G-0080〕Wake work windows only for new tasks or collaboration events rather than periodic polling. Helpers rely on completion notifications, not sleep polling. Submit ruling questions and end the turn, resuming after answers; finish and return without background jobs merely waiting for messages.
> Rationale: Background sleep tasks left after handback accumulate useless processes.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 3.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Adjust only the affected relay arrangement**〔G-0081〕When a task is expected to span owner-window replacement, or hallucination rework or a broken relay has occurred, adjust that task's execution levels and handover. Do not generalize a local rollback into a permanent process for all tasks.
> Rationale: Prevent continued use of an ineffective arrangement after a broken relay, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Assignments contain facts and settled decisions**〔G-0082〕Write facts and settled rulings in assignments rather than pasting discussion as executable requirements. Verbatim delivery copy is an exception and still follows the original {{真源件}}.
> Rationale: Prevent discussion wording from masquerading as settled requirements, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Give model defaults explicit exceptions**〔G-0083〕Model arrangements specify a default and exceptions: the default is queued or rate-limited, another model is materially better with one recorded reason, or {{决策者}} names one for the current task. Dispatch by those rules rather than requiring each window to calculate proportions.
> Rationale: A default and a few exceptions use periodically resetting resources more simply than per-window proportional calculations.

Layer: operations; Scale: small–large; Features: multiple-models; Dependencies: G-0067; Source count: 1.

Restore condition: Restore when delegating to at least two model providers.

**Medium-project owners dispatch directly**〔G-0084〕At medium scale, existing frontend, backend, and testing owners directly assign helpers and integrate their tasks. Do not add layers that only relay messages and collect reports.
> Rationale: Relay-only roles increase communication without increasing delivered work.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Add large-project execution layers only when needed**〔G-0085〕Even large collaborations default to task owners directly assigning helpers and integrating delivery. Only when a task needs prolonged continuous relay and {{决策者}} is absent may its assignment add one person who actually organizes execution, never a relay-only layer. Helpers responsible for rewriting may delegate only read-only research.
> Rationale: Prevent needless layers of task redistribution when relay is unnecessary, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Combine rework without opening another window**〔G-0086〕When audit rework can join the next task on the same work line, combine it instead of opening another execution window.
> Rationale: Prevent duplicate windows for rework that can be combined, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Do not invent concurrency ceilings**〔G-0087〕When a model is confirmed to have no concurrency limit, do not invent window, round, or total-call limits merely to conserve usage. Still respect real budgets, device resources, and provider quotas.
> Rationale: Concurrency ceilings follow confirmed provider limits and actual budgets and devices; neither limits nor unlimited quota may be invented.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Assign modifications to authorized roles**〔G-0088〕If a helper's role explicitly permits only reading or diagnosis, assign subsequent modification to a role allowed to modify. Reading does not always require changing helpers, and small projects need no separate role-switch procedure.
> Rationale: A diagnostic-only helper was previously reused for repair, wasting a turn when its permissions required refusal.

Layer: methods; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Replace models within fixed slots**〔G-0219〕List available models in {{口径件}} under fixed slots, such as top tier, A, B, C, reading, and audit. Keep slot names stable and replace only model names. When a model exhausts its quota, record “<model> quota stopped <time>” in {{留痕处}} and switch to the next model in the same slot without asking {{决策者}} or editing the policy file.
> Rationale: Daily quota changes must not halt dispatch while waiting for the decision maker or a complete reassignment table.

Layer: operations; Scale: small–large; Features: multiple-models; Dependencies: G-0067; Source count: 1.

Restore condition: Restore when assigning work to at least two model providers.

**Request concise work from overdefensive models**〔G-0220〕When assigning implementation to models known to add defensive code, unrequested tests, or excessive wrappers, include: make only the requested changes; reuse existing functions; add no unrequested null checks, retries, fallback branches, wrapper layers, or tests; use existing validation for external input. When assigning audits to these models, include: missing defensive handling, missing fallbacks, and potential robustness improvements are not defects; report only incorrect functionality and actual errors.
> Rationale: Some models turn small changes into extensive defensive code and extra tests, widening scope, breaking full test runs, and distracting the lead window.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when programming (code) starts.

**One owner delivers each feature slice**〔G-0223〕Split implementation assignments by feature. One person delivers data, logic, interface, and tests together instead of splitting frontend and backend layers. Before dispatch, ask whether one person can finish it; if so, keep one assignment with one owner throughout.
> Rationale: Layer-based assignments wait on each other and coordinate interfaces, yet may deliver every layer without producing a usable feature.

Layer: operations; Scale: medium–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when programming starts.

## Audit and acceptance

**Publish acceptance requirements before use**〔G-0089〕Write shared completion requirements into {{规矩总件}} or {{作业件}}, and role-specific requirements into that role's responsibilities. Do not fail someone against unannounced criteria or let checking opinions replace current {{真源件}} descriptions.
> Rationale: Prevent retroactive rejection using unset criteria, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Check outputs without adding procedures**〔G-0090〕Check only agreed outputs and necessary quality, such as draft-outline consistency or script-video consistency. Perform necessary self-checks and list unchecked items. Do not add reports, repeated reading, or duplicate checks as delivery prerequisites; one agreed reread means one without unjustified repetitions.
> Rationale: Checks reject unfinished outputs rather than creating layers of obstacles; self-checking and substantive acceptance remain necessary.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 7.

Restore condition: Keep when there is at least one task.

**Never weaken failing checks**〔G-0091〕When validation, tests, or builds fail, do not disable established warnings, weaken assertions, alter verification anchors, or skip failures for a passing result. Repair incorrect implementation; if criteria may be wrong, retain the failure and record the blocker in {{留痕处}}.
> Rationale: Prevent weakened checks from hiding real failures, as observed in the source project.

Layer: operations; Scale: small–large; Features: code; Dependencies: G-0049; Source count: 3.

Restore condition: Restore when maintaining at least one code repository.

**Keep acceptance independent of production command**〔G-0092〕When independent acceptance is assigned, the reviewer owns checking conclusions and production owners cannot decide them. Large scale alone does not require a permanent acceptance role.
> Rationale: Prevent production command from deciding independent acceptance conclusions, as observed in the source project.

Layer: constitution; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Accept small projects directly as agreed**〔G-0093〕At small scale, {{决策者}} accepts {{成品}} and necessary verification results without permanent independent audits or extra reviewers based on platform. High-risk work still requires checks; name any independent checking in the assignment.
> Rationale: Low-risk work need not receive dedicated review, but reduced procedure cannot exempt high-risk work.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 4.

Restore condition: Keep when there is at least one task.

**Use one risk-based independent audit**〔G-0094〕Default to no audit for low risk. For other work, follow risk and assignment: ordinary tasks may use reduced review of changes and existing evidence without rerunning or blocking continuation; high-risk work receives complete review before delivery. {{总协调}} assigns a non-author with fresh context, at most one audit, with explicit capability requirements; platform or quota does not justify extra reviewers or downgrading.
> Rationale: Risk-based review avoids obstructing progress through repeated escalation while preserving sufficient capability for high risk.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 6.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Review large code tasks by risk**〔G-0095〕Fully audit high-risk code, deployments, data security, and validation-tool changes before delivery or integration, with capability suited to risk. Review ordinary code after integration with reduced scope, without blocking delivery, and repair discovered defects afterward. Low-risk tables, assets, documents, small single-file fixes, and test-only changes default to no audit unless named.
> Rationale: Review actual risk rather than repeatedly auditing low-risk tasks or blocking delivery through added layers.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 4.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Reduced audits read existing evidence only**〔G-0096〕Reduced code audits read differences, completion reports, and existing test evidence, checking behavior, truthful results, cross-task effects, and scope. Do not rerun builds or tests, inspect procedural paperwork, or add the out-of-scope checklist used for full audits.
> Rationale: Reduced review uses existing results to find defects rather than repeating verification and unrelated paperwork.

Layer: operations; Scale: large–large; Features: code; Dependencies: G-0094; Source count: 2.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Limit full-audit reading to the question**〔G-0097〕Full audits gather evidence for current criteria, test scope, exclusions, changes, completion reports, and corresponding data. Use process records only to locate conflicts, autonomous assumptions, authorization, and rework; do not read all assignments and history.
> Rationale: Prevent unrelated history from crowding out the current review, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0094; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Support audit assertions with evidence**〔G-0098〕List each assertion, locatable evidence, necessary unmodified output, and judgment. Record rework items and rounds in {{留痕处}}. Mark missing evidence unverified with a reason; guesses and old reports cannot substitute for current verification.
> Rationale: Prevent unsupported assertions from being treated as verified facts, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: G-0049, G-0094; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Rework addresses unmet outputs**〔G-0099〕Judge audits by agreed outputs and behavior. Correct harmless typos in process counts, times, line numbers, signatures, or paragraph formatting without classifying them as output defects or demanding rework. Still investigate false actual results and completion claims.
> Rationale: Prevent harmless formatting errors from being classified as output defects, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0094; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**List environment limitations separately**〔G-0100〕List matters unverifiable because of permissions or environment as environment limitations. Explain that they are not output defects; do not mix them into unchecked-item counts or demand output rework on that basis.
> Rationale: Insufficient checking conditions do not mean poor work; separate records avoid misclassifying environmental failures.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0094; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**State cross-task checks in full audits**〔G-0101〕A full audit lists other tasks and active paths potentially affected by the change, marking each checked or unchecked even if unmodified. State no impact only when none is related, not when impact was not investigated.
> Rationale: Prevent unexamined effects from being reported as absent, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0097; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Check scope and shared edits**〔G-0102〕Code audits compare actual changes individually with agreed limits and list scope expansion with or without authorization records. Shared content changes only the task's owned lines and keys, never other roles' changes or related existing tests by mistake.
> Rationale: Prevent unauthorized scope expansion or accidental changes to others' shared content, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: G-0094; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Recheck only preceding rework items**〔G-0103〕Rechecks examine only preceding rework items in {{留痕处}} and counterevidence. Do not rerun the full checklist or expand to similar edge cases. Do not add tests, thresholds, audit rounds, or documentation through rework.
> Rationale: Review should reduce work rather than expand every recheck into an entirely new audit.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0049, G-0098; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Separate newly discovered recheck issues**〔G-0104〕Rechecks cover preceding rework items. Newly discovered high-risk issues are exceptions included in current rework; record other issues as existing backlog for {{总协调}} to arrange separately, not as additions to this round.
> Rationale: Prevent non-high-risk discoveries from expanding a recheck, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0103; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Change approach after three rework rounds**〔G-0105〕After three rework rounds following independent checking of one task, stop stacking patches. The task owner changes approach or explicitly states remaining issues and delivers as agreed.
> Rationale: Prevent endless patch accumulation across repeated rework, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0098; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Reuse unchanged verified results**〔G-0106〕Owners and helpers reuse results when content and conditions are unchanged. Unless otherwise agreed, check once and explain repeats. After draft or video edits, check affected parts only; perform repair rechecks and agreed device changes or independent reviews, then deliver once all requirements pass.
> Rationale: Reuse completed verification and parameters rather than delaying delivery through another delegation layer.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 6.

Restore condition: Keep when there is at least one task.

**Match verification scope to changes**〔G-0107〕Code verification follows the assignment and runs only new, changed, and neighboring tests directly referencing changed symbols, data, or fixtures. Run special environments only when named; do not add full suites, specialist checks, or screen evidence. Audits examine unjustified excess verification.
> Rationale: An executor's belief that more checks would help does not authorize extra verification; reuse existing measurements.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 3.

Restore condition: Restore when maintaining at least one code repository.

**Keep test results with named failures**〔G-0108〕Save each full test-round output separately. {{留痕处}} contains only its path, pass/fail counts, and failure names. Distinguish new failures from pre-existing failures outside the change scope by name and handle as agreed. Read names from existing logs rather than rerunning the suite; recheck only failed items after repair.
> Rationale: Existing out-of-scope failures are not introduced by the current task, and saved output already supplies their names.

Layer: operations; Scale: small–large; Features: code; Dependencies: G-0049; Source count: 2.

Restore condition: Restore when maintaining at least one code repository.

**Remeasure only affected quantitative targets**〔G-0109〕Keep assignment targets unchanged. During iteration, remeasure directly affected target items once; perform the full measurement only once on the final output. Without agreed quantitative criteria, do not use this rule to add measurements or rounds.
> Rationale: Quantitative targets do not authorize repeatedly measuring all items or adding criteria where none were agreed.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Use separate test environments only as needed**〔G-0110〕Start an independent environment only when a named test actually requires it, keeping test data outside the repository. Do not start extra environments for tests that need none.
> Rationale: Prevent unnecessary additional test instances, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Allow diagnostic information in evidence**〔G-0111〕Runtime acceptance evidence may retain diagnostic information. Do not deduct acceptance credit solely because diagnostic text appears in captured evidence.
> Rationale: Prevent output rejection merely because diagnostic text is visible, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Keep diagnostics out of permanent presentation**〔G-0112〕Collect traceable time and state evidence through diagnostic acquisition rather than forcing the {{受众}} interface to display prescribed debugging markers permanently.
> Rationale: Prevent diagnostic markers from permanently occupying the product interface, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Automate functional checks; review experience separately**〔G-0113〕Verify functions determined by assertions, logs, counts, or exports automatically first; do not make {{决策者}} assist testing or repeat screenshots instead. If appearance or experience still seems wrong after passing checks, or complete work needs real-use review, {{决策者}} decides that review separately.
> Rationale: Automation handles function; human experience review concerns issues in free use rather than repeating tool-verifiable checks.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 2.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**State numerical consistency tolerances**〔G-0114〕For consistency measurements, the dispatcher supplies numerical tolerances in advance rather than vague terms such as approximately consistent. Audits check that criteria exist and tolerances are fixed values.
> Rationale: Vague consistency descriptions let makers and reviewers apply incompatible pass conditions.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Arrange aggregate verification separately**〔G-0115〕When cross-module regression is agreed, the existing test owner arranges it centrally. An established review role may coordinate within authorization, but each task delivery does not wait for an additional aggregate round.
> Rationale: Prevent every task delivery from waiting for aggregate verification, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Approved prototypes become acceptance authorities**〔G-0116〕After {{决策者}} finalizes an interaction prototype, include it in the requirements as an acceptance authority. Make subsequent changes in requirements, not the finalized prototype. Field meanings, priorities, and other behavior follow written requirements, not deductions from diagrams.
> Rationale: Prototypes affect later development and need approval first rather than an unconfirmed version becoming delivery authority.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Run expensive acceptance only on final input**〔G-0117〕For offline batch computations, perform acceptance computation once on final inputs rather than repeating construction and integration verification for intermediate versions.
> Rationale: Prevent intermediate inputs from repeatedly consuming acceptance computation, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

## Rule lifetime

**Separate safeguards, operations, and methods**〔G-0118〕{{规矩总件}} holds authority, exceptional actions, and project-level criteria. Shared operational requirements belong in {{作业件}}. Roles maintain volatile methods and parameters locally or in tools rather than promoting each to shared rules.
> Rationale: Rules limit authority without restricting methods; volatile methods should not all become shared constraints.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Fix tools before creating rules after incidents**〔G-0119〕After one incident, fix tools or defaults rather than creating a permanent rule. Correct the erroneous item once and record it in the task, not enduring templates or memory. Consider a rule only after at least three similar incidents when automation is infeasible; first turn lessons into tools or a one-time task check.
> Rationale: One mistake must not become a burden repeatedly imposed on all later tasks.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Automate executable constraints first**〔G-0120〕Use tools, automated checks, or defaults for constraints they can implement. Rules retain entry pointers rather than making execution windows repeatedly perform long written procedures.
> Rationale: Prevent repeated manual performance of automatable checks, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Give temporary rules an expiry**〔G-0121〕{{口径件}} collects current decisions. New checks, locks, and trial rules state their purpose, expiry (seven days by default), and numerical removal condition, such as zero real problems caught before expiry. Expired rules lapse and archive unless renewed with measurements and a new date. Remove current-window instructions and task-local checks after use rather than waiting seven days. A few windows can use a section in existing records without a new review process.
> Rationale: Limits need removal as well as addition; one incident does not justify a rule unless problems recur and tools cannot address them.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 3.

Restore condition: Keep when there is at least one task.

**Keep history out of current rules**〔G-0122〕Current text contains effective requirements only. Edit it directly and record version changes separately. Store repealed entries, replacement relationships, and historical versions elsewhere instead of accumulating supplements, overrides, or repeal notices.
> Rationale: Prevent current text from retaining expired requirements, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Current requirements do not become permanent rules**〔G-0123〕Record current requirements, exceptions, criteria, and local rollbacks only with current wording and time; remove them after use rather than applying them to other tasks or routines. Change enduring scope only when {{决策者}} explicitly makes it general, orders a complete rollback, or changes rules directly. Treat uncertain cases as task-local.
> Rationale: One arrangement does not establish future default authority or requirements.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 4.

Restore condition: Keep when there is at least one task.

**Remove old text before exceeding byte limits**〔G-0124〕If the project limits rule and {{接管件}} lengths, state each numerical ceiling at the file's start and count UTF-8 bytes consistently. When adding above the limit, remove or archive at least as many old bytes in the same change, not an approximate number of sentences or paragraphs.
> Rationale: Prevent already oversized documents from continuing to grow, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0137; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Register revisions centrally without read receipts**〔G-0125〕{{总协调}} registers revisions of {{作业件}} centrally. Roles reference only the current version; citation of the new version in the next assignment counts as read without a separate acknowledgment.
> Rationale: Prevent duplicate read acknowledgments after revisions, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Do not rewrite running or historical assignments**〔G-0126〕Do not retrospectively edit active or completed assignments. State new execution requirements and authorizations separately in {{留痕处}}, then continue under the latest effective decisions. Update responsibilities and shared templates for future assignments without rewriting history.
> Rationale: Prevent retrospective changes from obscuring the authority in force at the time, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0049; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Centralize authority for operational-rule edits**〔G-0127〕{{总协调}} or an explicitly authorized person revises {{作业件}}. An established review role may suggest or revise within authorization; otherwise existing owners handle it. Retain decision records and leave direction questions to {{决策者}}.
> Rationale: Prevent unauthorized parties from independently changing operational rules, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Separate rule changes from ordinary requirements**〔G-0128〕On receiving a requirement, identify whether it changes an existing rule. Refer rule changes to {{总协调}}; record other requests as task requirements in {{留痕处}} rather than automatically promoting them into rules.
> Rationale: Prevent ordinary requests from becoming permanent rules, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0049; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Historical decisions do not replace current authority**〔G-0129〕Use historical decisions only for tracing. Consult current {{作业件}} for operations and latest effective entries in {{口径件}} for current decisions. Check repealed content against repeal records rather than reviving it from history.
> Rationale: Prevent expired rules from being restored from historical ledgers, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0121; Source count: 12.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Shared rules retain authoritative pointers only**〔G-0130〕Entries, responsibility descriptions, and assignments reference current {{规矩总件}}, {{作业件}}, related {{真源件}}, and {{口径件}} rather than copying provisions into another safeguard set. Keep local methods and parameters separately. For actual deviations, state the original provision, change, and reason individually, not mixed with compliance, inapplicability, or historical bookkeeping errors.
> Rationale: Prevent copied shared rules from establishing another authority, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0121; Source count: 12.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Keep local criteria pointers when condensing**〔G-0131〕When condensing role descriptions, retain pointers to that role's criteria. Reducing body text does not mean deleting the criteria themselves.
> Rationale: Prevent condensation from also removing criteria entries, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Follow wording without creating rules**〔G-0217〕When {{决策者}} speaks in any window, that window records the wording verbatim and follows it within its responsibilities. Do not expand it into future, universal, or ask-first rules, or notify every role. A cross-role rule requires {{决策者}} to explicitly call it a rule or name a window to transcribe it verbatim; otherwise {{总协调}} writes it. Rules independently written by individual roles are invalid and must be removed when found.
> Rationale: When each window expands a local instruction into a rule, rules accumulate and conflict until the actual original decision becomes unclear.

Layer: operations; Scale: medium–large; Features: ; Dependencies: G-0012; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

## Memory and handover

**Use one handover entry at each level**〔G-0132〕Execution windows, if any, resume from task records; role owners resume from responsibilities and {{接管件}}, without parallel memories. Record current state, active work, omissions, existing defects, and next steps only in the corresponding handover location; use pointers elsewhere and keep history separate.
> Rationale: Prevent multiple handover-state copies from expiring independently, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: G-0137; Source count: 15.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Memory does not establish rules**〔G-0133〕Memory holds facts and pointers within the window's responsibilities, not copied or newly established rules. Read current authorities for rules and treat shared memory as reference material rather than personal experience.
> Rationale: Separate authoritative rules, this window's facts, and reference material to avoid false memories and conflicting rules.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 3.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Keep a one-page entry and read active assignments**〔G-0134〕Keep the main-window entry at most one page, naming identity, responsibilities, exclusions, and current-authority pointers. Read entry, {{规矩总件}}, {{作业件}}, and the current task in order. Execution windows read complete assignments and handovers rather than summaries. Temporary helpers read named authorities; consult history as needed and reread active authorities after compaction.
> Rationale: Limiting entry size does not justify omitting execution authorities; this reflects experience in the source project.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 6.

Restore condition: Keep when there is at least one task.

**Layer context by responsibility**〔G-0135〕Execution windows, if any, load task records; role owners load their responsibilities and task; {{总协调}} loads {{规矩总件}} and the global overview. Do not put every level's materials into every window.
> Rationale: Prevent unrelated organizational context from filling every window, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Search long references before reading**〔G-0136〕Search historical and lengthy reference material before reading relevant passages. Switch to search if reading an entire long reference. Execution windows still read complete current assignments and handovers.
> Rationale: Prevent whole-reference reading from consuming task context, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 3.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Update continuation records on events**〔G-0137〕{{接管件}} records current state, unfinished work, running helpers, and next steps; update on dispatch, return, or requirement changes and combine with existing records if useful. Record only locations and remaining work for out-of-scope issues. Window replacement is not completion: ensure the next window can continue, and never claim completion with work or helpers still active.
> Rationale: Save state promptly rather than reconstructing it before compaction or calling a window replacement completion.

Layer: operations; Scale: small–large; Features: ; Dependencies: ; Source count: 20.

Restore condition: Keep when there is at least one task.

**Centralize shared-memory indexing**〔G-0138〕{{总协调}} maintains the shared-memory index centrally; each role keeps one entry. Put local state and tasks in {{接管件}} rather than another state list in the index.
> Rationale: Prevent shared indexes from retaining a second obsolete current-state copy, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0137, G-0132; Source count: 3.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Review medium-project memory lightly**〔G-0139〕At medium scale, mark new shared-memory items temporary with a seven-day default expiry. The responsible window checks sources, meaning, and duplicates before making them permanent, without a new role. Remove unpromoted expired items from shared memory while retaining originals.
> Rationale: Shared memory must not grow by independent additions from every window; small amounts can be checked directly by the owner.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Review permanent shared memory by responsibility**〔G-0140〕Keep new shared-memory items temporary for seven days. If a review role exists, it checks sources, meaning, and duplicates before {{总协调}} confirms permanent inclusion; otherwise existing owners verify without creating roles. Remove unpromoted expired items from shared memory while retaining originals.
> Rationale: Temporary storage followed by verification prevents unchecked long-term growth from every window's additions.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Hand over helpers near context limits**〔G-0141〕When a helper approaches its agreed usable context limit, return existing results and a handover. Assign a fresh helper to continue from it rather than relying indefinitely on the old context.
> Rationale: Prevent context exhaustion from breaking the relay, as observed in the source project.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Close idle windows independently**〔G-0218〕A window with no active work, work in transit, or unanswered requests closes itself. Add one line to {{留痕处}} recording closure and the next reopening condition, without waiting for {{决策者}}.
> Rationale: Idle windows consume resources and otherwise require the decision maker to close each one.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

## Cross-window collaboration

**Role owners are not prior approvers**〔G-0142〕Role owners are not approvers. Other roles may make minimal reversible fixes within the owner's change area without prior permission; revert if the relevant owner disagrees on returning.
> Rationale: Prevent prior approval from blocking small reversible fixes, as observed in the source project.

Layer: constitution; Scale: medium–large; Features: ; Dependencies: ; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Coordinate directly before escalation**〔G-0143〕Relevant active windows align dependencies, overlapping changes, conflicting conclusions, and scope questions in the same turn, each recording one line in {{留痕处}}. Do not wait for contact or relay through {{总协调}}; ask for coordination only if agreement fails. If the other party is offline, record authorized reversible actions outside exceptions, follow the recommendation, and adjust after a reply.
> Rationale: Direct communication avoids waiting, repeated relays, and misunderstandings in related work.

Layer: operations; Scale: medium–large; Features: ; Dependencies: G-0049; Source count: 3.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Record procedural corrections without blocking outputs**〔G-0144〕Deliver all agreed outputs; announce samples and remaining volume before partial delivery. Record harmless record-format, path-notation, and copy-update issues in {{留痕处}} for the owner to correct without stopping other work. Still address missing necessary authority, broken integration, and unmet outputs.
> Rationale: Pending review and nonbusiness procedure must not become work-stoppage prerequisites, while real business defects still need repair.

Layer: operations; Scale: medium–large; Features: ; Dependencies: G-0049; Source count: 1.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Keep cross-role blocking fixes minimal and reversible**〔G-0145〕If a real out-of-scope defect blocks local work and a recommendation exists, make the smallest reversible repair and record it in both parties' {{留痕处}}; revert if the owner disagrees. Refer agreed-design questions or cases without recommendations to the owner rather than choosing for them.
> Rationale: Prevent prolonged blocking waits and unauthorized choices on another role's behalf, as observed in the source project.

Layer: operations; Scale: medium–large; Features: code; Dependencies: G-0049, G-0142; Source count: 2.

Restore condition: Restore when programming starts.

**Notify only affected parties of changes**〔G-0146〕Deliver changes to dispatched-task requirements, defaults, or active pointers to affected roles and record them in {{留痕处}}. Name module ownership when uptake is needed rather than distributing unrelated work. A local note alone is not delivery; do not broadcast unrelated windows.
> Rationale: Prevent local records from being mistaken for delivered notifications, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: G-0049; Source count: 3.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Deliver usable interface materials**〔G-0147〕For inter-role code interfaces, supply usable, verifiable documentation or a minimum implementation using the agreed technology and timing, such as definitions, examples, or a stub. Deliver it to the agreed location and notify consumers. Do not require same-day branches universally or describe undelivered agreements as available.
> Rationale: Prevent verbal agreements from being treated as usable interfaces, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Order tasks sharing changes or dependencies**〔G-0148〕Merge or sequence code tasks that change the same configuration or scripts, depend on measurement baselines, or rely on unintegrated outputs; do not start them in parallel.
> Rationale: Prevent collisions from shared edits or dependency-parallel execution, as observed in the source project.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Resolve same-file conflicts in the owning role**〔G-0149〕When several tasks under one role edit the same file, that role combines them before delivery. Integration performs mechanical merging only; send semantic disagreements back to the owner rather than letting integration decide.
> Rationale: Prevent integration from deciding semantics or losing changes, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Check channels that do not push notifications**〔G-0150〕Report change scope once in the role's {{留痕处}} at startup and again before integration, actively checking collaboration records. On channels without push, a message is not delivered until checked; writing is not receipt.
> Rationale: Without push notification, a written message does not establish that its recipient received it.

Layer: operations; Scale: large–large; Features: ; Dependencies: G-0049; Source count: 1.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

**Register and refer out-of-scope issues**〔G-0151〕Record symptoms, location, and likely owner for out-of-scope issues and refer them to {{总协调}} or an existing owner without incidental repair. Do not assume an operations role or a same-day dispatch deadline. Handle explicitly urgent issues first; cross-role repairs blocking current work still require authorization.
> Rationale: Prevent unowned external defects and incidental scope expansion, as observed in the source project.

Layer: operations; Scale: medium–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts.

**Give shared asset parameters one owner**〔G-0152〕One role changes asset parameters affecting several roles. Notify affected roles through {{留痕处}} before editing.
> Rationale: Prevent simultaneous shared-parameter changes from overwriting one another, as observed in the source project.

Layer: operations; Scale: large–large; Features: assets; Dependencies: G-0049; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: assets.

**Regenerate assets only for relevant source changes**〔G-0153〕Derived assets record the {{真源件}} version and relevant fields used for generation. Notify the asset owner in {{留痕处}} to regenerate affected parts only when changes affect asset content or output. Unrelated topics, punctuation, and unused fields do not require full regeneration.
> Rationale: Prevent derived assets from missing updates to relevant source fields, as observed in the source project.

Layer: operations; Scale: medium–large; Features: assets; Dependencies: G-0049, G-0194; Source count: 1.

Restore condition: Restore when (concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts) and assets are involved.

**Notify reporters after cross-role repairs**〔G-0154〕After fixing a code defect reported by another role, leave a repair receipt and notify the reporter through {{留痕处}}.
> Rationale: Prevent reporters from remaining unaware of completed repairs, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: G-0049; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**State frozen interfaces and scope explicitly**〔G-0155〕Responsibilities list externally frozen interfaces and role limits. Do not change frozen interfaces without authority. Cross-role changes require task authorization or the permitted exception for minimal reversible repairs of blocking defects.
> Rationale: Prevent unauthorized frozen-interface changes from breaking collaboration, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 2.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Take over offline owners under existing authority**〔G-0156〕If an offline code owner has a designated replacement, take over under that authorization; otherwise an existing owner arranges coverage without a mandatory permanent deputy. Read {{接管件}} and relevant {{留痕处}} before resuming.
> Rationale: Prevent defects from becoming unowned when an owner is offline, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: G-0049, G-0137; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Queue shared devices by actual occupancy**〔G-0157〕When shared equipment genuinely requires exclusive use, coordinate by request order and actual start time rather than interrupting work at a reserved clock time. Continue normal work before occupancy and do nonconflicting short tasks between uses. Do not create queues or batches without shared exclusive equipment.
> Rationale: Actual start times vary; coordination addresses real device conflicts rather than interrupting active work according to optimistic schedules.

Layer: operations; Scale: large–large; Features: ; Dependencies: ; Source count: 2.

Restore condition: Restore when concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4.

## Code and repositories

**Isolate resources between projects**〔G-0158〕Do not read or write another project's directories, ports, or credentials, or upgrade system toolchains without authority. Repair credential issues separately for each project's remote, without cross-project changes.
> Rationale: Prevent accidental cross-project resource or shared-environment changes, as observed in the source project.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Centralize pushes and never force-push**〔G-0159〕In multi-role collaboration, the agreed role owns remote pushes. Execution windows, if any, do not push independently or use force-push.
> Rationale: Prevent unauthorized pushes or overwriting remote history, as observed in the source project.

Layer: operations; Scale: medium–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when programming starts.

**Get authorization before public pushes**〔G-0160〕Obtain explicit authorization from {{决策者}} before pushing changes to a public repository.
> Rationale: Prevent public disclosure of changes without authorization, as observed in the source project.

Layer: constitution; Scale: small–large; Features: code; Dependencies: ; Source count: 2.

Restore condition: Restore when maintaining at least one code repository.

**Scan full history before first publication**〔G-0161〕Treat a repository's first public push as external publication. Scan its entire history for secrets and internal paths, documents, and personal names; publish only after confirming zero relevant findings.
> Rationale: Repository history can leak secrets and internal material even when current files are clean.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Keep environment dependencies outside core rules**〔G-0162〕Core rule calculations use pure functions without global-state reads, direct clock or randomness reads, or imports from runtime-environment implementations. Keep environment-specific code outside the rule layer.
> Rationale: Prevent environment state from leaking into core rule calculations, as observed in the source project.

Layer: operations; Scale: large–large; Features: code, values; Dependencies: ; Source count: 2.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code, values.

**Commit and push only as authorized**〔G-0163〕Do not commit or push without explicit current-task authorization; code editing does not imply it. Stage and make independent phase commits only for the task's allowlist. Limit files explicitly each time; commit only owned lines and keys in shared files without others' or other tasks' changes.
> Rationale: Prevent unauthorized commits and unrelated changes from entering them, as observed in the source project.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 3.

Restore condition: Restore when maintaining at least one code repository.

**Verify actual interface workflows**〔G-0164〕Build interactive interfaces before delivery and verify the workflows {{受众}} actually uses in the real runtime. Outputs made solely for grading are not a substitute.
> Rationale: Verification belongs on real user paths rather than introducing artifacts that exist only for grading.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Read interaction keys from configuration**〔G-0165〕Read interaction keys and shortcuts through one configuration entry rather than hardcoding them. Choose that entry for the project's technology; programs need not read explanatory documents.
> Rationale: Prevent obsolete hardcoded keys from still firing after reconfiguration, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Centralize adjustable operational values**〔G-0166〕Keep values that may change during operation and affect {{受众}} in a parameter table or named single entry. Consumers read centrally distributed values; compile-time constants are fallback defaults only. Small changes do not require redistributing {{成品}}.
> Rationale: Operational tuning should not force redistribution; distributed values are authoritative while compiled constants supply defaults only.

Layer: operations; Scale: large–large; Features: code, deployment, values; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code, deployment, values.

**Check remote state after push failures**〔G-0167〕After a push failure, inspect actual remote state before reporting truthfully. Do not infer remote results solely from the local command's result.
> Rationale: Prevent local errors from being mistaken for an unchanged remote, as observed in the source project.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Explain implementation deviations locally**〔G-0168〕When implementation differs from established documentation, identify the deviation and its reason at the corresponding code location.
> Rationale: Prevent unexplained implementation deviations from becoming untraceable, as observed in the source project.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Verify production-mirror refreshes as behavior**〔G-0169〕A downstream mirror parsed as {{真源件}} by production code changes behavior when refreshed. Verify it as a behavior change rather than treating it only as data movement.
> Rationale: Production directly parses mirror contents, so refreshing a nominal mirror affects behavior and cannot skip behavioral verification.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Read the agreed authoritative revision**〔G-0170〕Read drafting, dispatch, and verification values from the agreed shared baseline or named authoritative revision, not unsettled workspace edits or unmerged copies. Give helpers the same requirement.
> Rationale: Prevent unsettled workspace changes from becoming authoritative baseline values, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 2.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Preserve both parties' required conflict changes**〔G-0171〕Resolve only the task's content during conflicts, preserving others' content unchanged without incidental repairs and retaining all required changes from both sides. Build afterward and pass both parties' relevant tests.
> Rationale: Prevent conflict resolution from losing changes or repairing unrelated content, as observed in the source project.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Keep regression assertions for behavior changes**〔G-0172〕Each business-behavior change has at least one behavior assertion. If an old test fails because of the task's confirmed new behavior, update expectations rather than deleting the test. Pin behavior, not formatting.
> Rationale: Prevent untested behavior changes and deleted tests that hide defects, as observed in the source project.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Check existing capabilities before rebuilding**〔G-0173〕Before choosing an implementation, check whether existing tools already provide the capability being rebuilt manually. Compare mature approaches before deciding what needs custom implementation.
> Rationale: Prevent existing tool capabilities from being misidentified as gaps and rebuilt manually.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Keep commit identity out of shared configuration**〔G-0174〕When a separate commit identity is needed, use settings limited to the current command or isolated working copy rather than shared identity configuration. Follow established project attribution, without assuming role-name authorship or rewriting commits to change identity.
> Rationale: Prevent individual commit identity from contaminating shared configuration, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 2.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Hand over merge and conflict work explicitly**〔G-0175〕The agreed owner or authorized helper performs merges, builds, tests, and conflict resolution; no fixed main/helper split is required. Handovers identify pending changes, conflicts, changes each side must retain, and completed checks; the next executor may differ. Do not modify unrelated code or add procedures through merging.
> Rationale: Prevent unclear merge handovers and unrelated changes made during integration, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Check locally, then check the assembled result**〔G-0176〕Development windows build and test only modified modules. After assembly, the existing integration owner builds the complete project once and runs the assignment's named tests without adding a role. Do not build concurrently in the same workspace. Reuse results under unchanged conditions; after repair recheck failed items only.
> Rationale: Concurrent builds collide on intermediates; local checks followed by one assembled check avoid duplicate full builds.

Layer: operations; Scale: medium–large; Features: code; Dependencies: ; Source count: 3.

Restore condition: Restore when programming starts.

**Verify final small-project changes centrally**〔G-0177〕At small scale, the responsible window collects final changes, builds, and runs named tests once. No separate merge role is required and builds do not run concurrently in one workspace.
> Rationale: Central final verification avoids intermediate-artifact conflicts and repeated builds.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 2.

Restore condition: Restore when maintaining at least one code repository.

**Apply code conventions to tools too**〔G-0178〕Project code and auxiliary tools follow established code conventions without self-exemptions by purpose or directory. After building, run agreed convention checks and record exit results in {{留痕处}}; self-checking does not become an additional delivery checkpoint.
> Rationale: Prevent auxiliary tools from being exempted from coding standards without authority, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: G-0049; Source count: 2.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Schedule existing-failure cleanup separately**〔G-0179〕Do not run bulk existing-test-failure cleanup alongside other changes. Wait until the batch is integrated and the target branch is stationary. Already active cleanup tasks finish against the acquired combined revision rather than chasing later integrations.
> Rationale: Concurrent integration and cleanup constantly move the target; cleanup should finish against its acquired combination.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Wait only for actual integration dependencies**〔G-0180〕Integration into a shared branch waits only for actual prerequisites, not unrelated tasks. If several people can write the same branch or intermediate artifacts, use established isolation or brief mutual exclusion; not waiting for unrelated tasks does not permit overwrites. Build and verify the determined combination as assigned.
> Rationale: Coordination is needed for prerequisites and shared-state writes, not unrelated work.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Retire working copies with their tasks**〔G-0181〕The role creating a working copy owns its retirement when the task ends. Derived caches and copies generated for import or verification are not deliverables and retire with it.
> Rationale: Prevent work copies and derived artifacts from remaining after tasks end, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Audit the candidate revision independently**〔G-0182〕Independent code audits use differences and files in the current candidate commit, not the current workspace. For shared content inspect only the lines and keys claimed by this task.
> Rationale: Prevent auditing a workspace instead of the actual candidate revision, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Separate current changes from existing issues**〔G-0183〕Evaluate code-change hygiene by differences from the starting baseline only. Do not count pre-existing issues as introduced by the current task.
> Rationale: Prevent existing hygiene issues from being attributed to the current change, as observed in the source project.

Layer: operations; Scale: small–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository.

**Separate reusable capabilities and private data**〔G-0184〕Layer reusable capabilities separately from project-specific data. General code contains no project content or secrets; keep specific data private and separate, sharing only the general portion externally.
> Rationale: Separating reusable capability from project content prevents accidental disclosure of private material and secrets.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Do not move shared checkout state**〔G-0185〕In a shared checkout, do not commit from copies, transplant commits, rebase, hide shared edits, reset state, or rewrite commits. Organizing local changes must not move another person's shared state.
> Rationale: Prevent local change organization from damaging shared state, as observed in the source project.

Layer: methods; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

## Release and deployment

**Release authority does not grant production command**〔G-0186〕If a separate merge/release owner exists, its authorization covers packaging, distribution, and deployment, not production command or independent acceptance rulings, nor takeover of active work without authority. Otherwise existing authorized people release without mandatory separation between development and release roles.
> Rationale: Prevent release permissions from being mistaken for production or acceptance command, as observed in the source project.

Layer: operations; Scale: large–large; Features: code, deployment; Dependencies: ; Source count: 3.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code, deployment.

**Separate development delivery and deployment rights**〔G-0187〕Assignments explicitly state version-only delivery or authorized deployment. Only authorized people deploy, restart, or change live permissions through established procedures. Existing development or testing owners may do so; assume no operations or batch-release role. Without authority, deliver only agreed outputs.
> Rationale: Prevent production operations after authorization only to deliver a version, as observed in the source project.

Layer: operations; Scale: medium–large; Features: code, deployment; Dependencies: ; Source count: 5.

Restore condition: Restore when programming and deployment are involved.

**Never bypass release checks**〔G-0188〕Run established checks and parameter self-checks before release. Do not skip tests or remove checks to bypass failures.
> Rationale: Prevent releasing failed versions by skipping established checks, as observed in the source project.

Layer: operations; Scale: medium–large; Features: code, deployment; Dependencies: ; Source count: 2.

Restore condition: Restore when programming and deployment are involved.

**Handle release failures according to reversibility**〔G-0189〕Stop release when builds or release checks fail; do not push past failures. Revert a deployed server only when it can be replaced safely immediately. Do not claim instantaneous rollback of clients already held by users; stop distribution, fix the next version, and state actual results.
> Rationale: Prevent pushes after failure or false claims of safe rollback, as observed in the source project.

Layer: operations; Scale: medium–large; Features: code, deployment; Dependencies: ; Source count: 2.

Restore condition: Restore when programming and deployment are involved.

**Use batch cutoffs only for batch releases**〔G-0190〕If batch releases are chosen, follow published cutoffs and move unready tasks to the next batch without ad hoc waiting or repeated questions about published times. On-demand projects follow their own release arrangements without an extra fixed batch system.
> Rationale: Prevent unready tasks from delaying an established release batch, as observed in the source project.

Layer: operations; Scale: large–large; Features: deployment; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: deployment.

**Check ordinary usage of shared release tools**〔G-0191〕After changing shared release tools, verify ordinary release without task-specific settings still passes unchanged and retain evidence. Explain effects on other releases. The current responsible window performs this; existing independent audits inspect evidence without an additional audit. Without tool changes, do not expand checking or add prior approvals.
> Rationale: Prevent task-specific settings from hiding damage to shared release paths, as observed in the source project.

Layer: operations; Scale: large–large; Features: code, deployment; Dependencies: ; Source count: 2.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code, deployment.

**Deployment requires the decision maker's announcement**〔G-0225〕Only an announcement from {{决策者}} counts as formal deployment. Before that, external platform listings and public playtests follow development procedures; do not introduce approval requirements or checks solely because of them.
> Rationale: Treating any external listing as deployed invites extra checks and approvals that delay development.

Layer: operations; Scale: medium–large; Features: deployment; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts) and deployment is involved.

## Assets and naming

**Keep style references separate from production assets**〔G-0192〕External finished images may guide generation style. Store references separately from production assets; permission to reference does not authorize inclusion of another party's original assets in {{项目名}}.
> Rationale: External work can establish aesthetic direction without copying its assets.

Layer: operations; Scale: small–large; Features: assets; Dependencies: ; Source count: 1.

Restore condition: Restore when producing at least one type of asset in bulk.

**Record asset inventory and generation versions**〔G-0193〕Use one inventory for locations, sources, verified counts, working/production/retired status, and use in {{成品}}; do not mark unverified claims confirmed. Derived assets record source versions and relevant fields. Mark updates only when those fields affect content or results, not for unrelated full regeneration.
> Rationale: Classify assets, separate working from production files, and update derivatives with their sources.

Layer: operations; Scale: small–large; Features: assets; Dependencies: ; Source count: 7.

Restore condition: Restore when producing at least one type of asset in bulk.

**Give the asset inventory one owner**〔G-0194〕One named existing collaborator maintains the current asset inventory without a mandatory new asset-management role. Others supply file locations and sources through the agreed entry. Responsibilities link its location; mark old inventories historical and do not copy current counts into multiple documents.
> Rationale: Old inventories are not current stock, and copied current values drift; this reflects experience in the source project.

Layer: operations; Scale: medium–large; Features: assets; Dependencies: G-0193; Source count: 8.

Restore condition: Restore when (concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts) and assets are involved.

**Keep asset sources and uses traceable**〔G-0195〕Register new asset sources and use locations centrally, tracing each file actually used in {{成品}} to its original source. Follow agreed handovers if production and organization have different owners; a single owner records and verifies independently without another role's approval as a prerequisite.
> Rationale: Separate actual production assets from personal material and keep sources traceable without turning registration into extra approval.

Layer: operations; Scale: medium–large; Features: assets; Dependencies: G-0194; Source count: 2.

Restore condition: Restore when (concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts) and assets are involved.

**Register asset inputs before processing**〔G-0196〕Before bulk compression, packaging, or delivery, check inputs are active and included in the current inventory. Register newly generated assets before further processing; registration itself is exempt from that prerequisite. Do not consume personal reference material or retired files directly.
> Rationale: Personal material needs proper placement first, while old files still used by production cannot be removed.

Layer: operations; Scale: small–large; Features: assets; Dependencies: G-0193; Source count: 4.

Restore condition: Restore when producing at least one type of asset in bulk.

**Keep restoration indexes for retired assets**〔G-0197〕When retiring assets, retain a restoration index mapping old and new locations so retired files remain traceable and restorable.
> Rationale: Prevent retired assets from losing their original restoration locations, as observed in the source project.

Layer: operations; Scale: medium–large; Features: assets; Dependencies: G-0006, G-0194; Source count: 1.

Restore condition: Restore when (concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts) and assets are involved.

**Commit only agreed deliverable assets**〔G-0198〕If a repository is designated for runtime/delivery assets only, commit only agreed delivery formats and sources. Keep source projects, candidates, and render intermediates in the agreed external archive. If a separate source-asset repository or joint editing is required, follow that repository's inclusion rules rather than universally excluding sources.
> Rationale: Prevent intermediate source files from entering repositories intended only for runtime delivery, as observed in the source project.

Layer: operations; Scale: small–large; Features: code, assets; Dependencies: ; Source count: 1.

Restore condition: Restore when maintaining at least one code repository and producing at least one asset type in bulk.

**Confirm style before batch production**〔G-0199〕If a batch requires style confirmation first, deliver a sample, obtain and record confirmation from {{决策者}} or an explicitly authorized person, then produce in bulk. {{决策者}} specifies what pauses and when it resumes. Do not add a freeze process to projects without this arrangement.
> Rationale: Prevent batch production before style approval and resulting rework, as observed in the source project.

Layer: operations; Scale: medium–large; Features: assets; Dependencies: G-0200; Source count: 1.

Restore condition: Restore when (concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts) and assets are involved.

**Decide aesthetics only under explicit authority**〔G-0200〕{{决策者}} decides asset direction. If explicitly delegated, the authorized person specifies style and references consistently and retains authority and confirmation records, without mandatory aesthetic/execution/coordination roles. Makers follow confirmed requirements. Check file specifications, visibility, and usability in {{成品}} separately; technical self-checks are not aesthetic approval and aesthetic rework has no extra round cap.
> Rationale: Respect explicitly delegated aesthetic expertise without adding another aesthetic ruler; absent authority, do not decide on another's behalf.

Layer: operations; Scale: medium–large; Features: assets; Dependencies: ; Source count: 8.

Restore condition: Restore when (concurrent windows >=4, responsibility owners >=2, repositories >=2 with deployment, or programming starts) and assets are involved.

**Separate small-project aesthetics and specifications**〔G-0201〕At small scale, {{决策者}} confirms aesthetics directly or explicitly delegates to one person; makers and helpers do not change direction. When common style is agreed first, confirm samples before bulk production. Check specifications, visibility, and usability in {{成品}} separately. Self-checking does not replace aesthetic approval; do not cap aesthetic rework or add roles or freeze procedures.
> Rationale: Confirm samples first and distinguish aesthetic authority from technical specifications; maker self-checking is not aesthetic approval.

Layer: operations; Scale: small–large; Features: assets; Dependencies: ; Source count: 10.

Restore condition: Restore when producing at least one type of asset in bulk.

## Load and performance

**Load substantial runtime assets progressively**〔G-0202〕If many runtime assets would impair use when loaded together, load immediate needs first and the rest progressively or on demand. Do not impose the same architecture on small asset sets.
> Rationale: Prepare currently needed assets first to avoid stalls from loading everything.

Layer: operations; Scale: large–large; Features: code, assets; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code, assets.

**Address load in code, not routine stress tests**〔G-0203〕Implement load requirements in code without routine stress tests for every task. Concurrent online operations avoid global locks, full-table locks, and unrelated-record locks; frequent cycles avoid full-table scans and full broadcasts each cycle. At delivery describe new lock scopes, durable writes, scans, broadcasts, and blocking I/O. Audit established forbidden patterns immediately rather than waiting for stress tests.
> Rationale: Load governance should constrain costly locks, writes, scans, and blocking operations rather than burden every task with stress testing.

Layer: operations; Scale: large–large; Features: code, deployment; Dependencies: ; Source count: 2.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code, deployment.

**Keep blocking I/O off main execution threads**〔G-0204〕Never perform synchronous blocking I/O on interactive main threads or periodic-processing threads. Return such code for repair immediately rather than waiting for load tests.
> Rationale: Prevent blocking I/O from stalling interaction or periodic processing, as observed in the source project.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Measure performance away from construction load**〔G-0205〕Measure performance in one concentrated round after relevant changes are merged. Do not run interfering builds, tests, or imports during measurement. Nonperformance tasks do not stop universally under this rule.
> Rationale: Measurement must not interfere with builds or imports; resource avoidance applies to actual performance measurement, not all evidence gathering.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 2.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

**Accept devices only for their agreed purpose**〔G-0206〕If {{决策者}} explicitly designates a device for functional checks without performance targets, ensure {{成品}} opens, does not crash, and completes agreed checks there. Do not add tuning or comparative measurement. Without that explicit arrangement, established functional and performance targets still apply.
> Rationale: A functional-only device does not regain unpromised performance requirements, but other devices retain their established targets.

Layer: operations; Scale: large–large; Features: code; Dependencies: ; Source count: 1.

Restore condition: Restore when (concurrent windows >=7, responsibility owners >=6, or repositories >=2 with deployment and responsibility owners >=4) and these features are enabled: code.

## Review role

**Keep review independent, read-only, and reporting-only**〔G-0207〕If a review role exists, it is independent of production command, reads production artifacts only, and reports to {{总协调}} without directing changes. Send role opinions through the agreed coordination entry; reviewers may exchange facts. Otherwise existing owners organize independent checks by task without adding a role merely because scale is large.
> Rationale: Prevent read-only review from turning into direct production command, as observed in the source project.

Layer: operations; Scale: large–large; Features: review-role; Dependencies: ; Source count: 3.

Restore condition: Restore when the decision maker requests a review role.

**Review blockers and removable procedures only**〔G-0208〕When rule or process review is assigned, report actual blockers and rules or procedures that can be deleted or combined; do not add restrictions through review. Without such an assignment, do not create another report system.
> Rationale: Review should reduce rules rather than become a continuing source of additional process.

Layer: operations; Scale: large–large; Features: review-role; Dependencies: G-0207; Source count: 1.

Restore condition: Restore when the decision maker requests a review role.

**Consolidate agreed rule-reduction reviews**〔G-0209〕If periodic rule review is agreed, collect deletion, combination, archival, renewal, or automation proposals at that frequency with usage figures. {{决策者}} decides centrally and {{总协调}} implements, prioritizing contributors' reduction suggestions. The project sets frequency; weekly review is not universal.
> Rationale: Consolidated removal, combination, and renewal keep rules from having only an entry path and no exit.

Layer: operations; Scale: large–large; Features: review-role; Dependencies: G-0207; Source count: 2.

Restore condition: Restore when the decision maker requests a review role.

**Evaluate fewer checks using rework and long waits**〔G-0210〕If a task agrees on quantitative process comparisons, count rework and waits for others longer than one hour over the same period. When long waits decrease, increased rework alone is not failure. Investigate specific processes when metrics move oppositely rather than declaring success or failure from two values. Do not add daily reports without agreement.
> Rationale: When delivery before correction is allowed, consider both rework and waiting rather than increasing waits solely to minimize rework.

Layer: operations; Scale: large–large; Features: review-role; Dependencies: G-0207; Source count: 1.

Restore condition: Restore when the decision maker requests a review role.

**Retain audits according to actual defect yield**〔G-0211〕If evaluating independent checking is agreed, record checks, real defects found, and time spent over the agreed period. Reduce checks primarily according to actual defect yield, not cost alone. Existing owners may compile results without a review role; do not default to weekly forms for every project.
> Rationale: The proportion of checks finding real defects indicates value, distinct from time or cost.

Layer: operations; Scale: large–large; Features: review-role; Dependencies: G-0207, G-0094; Source count: 1.

Restore condition: Restore when the decision maker requests a review role.

## Authoritative repository

**Export only currently effective rules**〔G-0212〕Record each rule's effective date, expiry, replacement relationship, and storage location. Generated reading material includes only effective unexpired rules. Unrenewed expired rules leave automatically; replaced rules point to successors, and queries retain when each was valid.
> Rationale: Preserved authorities must distinguish current, expired, and replaced content.

Layer: operations; Scale: large–large; Features: rule-repository; Dependencies: ; Source count: 4.

Restore condition: Restore when the decision maker requests a rule repository.

**Keep rule references queryable**〔G-0213〕Record which documents and roles reference each rule and retain queryable reference relationships.
> Rationale: Prevent rule changes from losing their consumers, as observed in the source project.

Layer: operations; Scale: large–large; Features: rule-repository; Dependencies: ; Source count: 2.

Restore condition: Restore when the decision maker requests a rule repository.

**Keep readable exports aligned with structured authority**〔G-0214〕When using structured {{真源件}}, regularly export readable, diffable text for {{决策者}} and authorized readers. Align text with structured records item by item rather than creating another content set.
> Rationale: Prevent readable exports and structured authority from holding separate content, as observed in the source project.

Layer: operations; Scale: large–large; Features: rule-repository; Dependencies: ; Source count: 2.

Restore condition: Restore when the decision maker requests a rule repository.
