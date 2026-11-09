# Requirements review · Let AI design the product development documents first

English | [中文](requirements-review.zh.md)

Use this optional guide for a new project with an idea but no product documents. If complete product requirements and a development roadmap already exist, skip to `getting-started.md` in this pack.

Give this file, your idea, and existing materials to any AI conversation window and say, “Help me design the product development documents and revise them over several rounds until finalized.” A web chat, desktop chat, or programming window can do this.

## Instructions for the AI

Design the product using only this file and user-provided materials. Do not require commands, other file reads, tool installation, or network access. Produce product development documents and diagrams now, not business code or project setup. The complete structure below needs no separate template.

If the window can write files, save outputs only under `需求/` in its opening directory. Otherwise present each file as a complete copyable block labeled with its filename, and remind the user to save it under the project's `需求/`. Never claim to have saved a file that was not actually written.

## 1. Design a complete first draft without an interview

Read all user materials first: a sentence, description, requirements list, prototype HTML, annotations, or screenshots. Adopt what is already clear without asking again. In the first round, directly deliver complete `产品研发文档.md` and `流程图.md` files, plus accompanying HTML this window can produce. Do not interview the user first or wait for complete materials before drafting.

For necessary design details absent from the materials, propose a concrete design marked 〔Recommended〕. Do not turn the document into questions or empty tables. Keep irrelevant sections with one line saying “Not applicable to this project,” rather than inventing content. Mark conflicting or uncertain material 〔Open〕 and collect it under “Decisions needed”: state the conflict and sources, give options A and B, their effects, and a recommendation with reasons. The body may follow the recommendation, still marked 〔Recommended〕 rather than presented as decided.

## 2. Give every requirement and decision a status and source

- 〔Decided〕: explicitly stated or approved by the user; retain the original wording or approval evidence.
- 〔Recommended〕: designed or recommended by AI, not yet approved; never treat it as decided.
- 〔Open〕: not decided; identify the open point and its “Decisions needed” identifier.

Every requirement and decision has an identifier, status, and basis. Diagram designs map back to document entries. Separate suggestions from user-confirmed facts; never present AI interpretation as original wording. The document header records version, source materials, and status. Before finalization, say “Discussion draft, not an implementation order.” Accompanying files use the same version.

Record user wording and annotations verbatim in “Original wording and annotations” at the end of the product document, with the document version when received, round, and wording identifier. Multiple passages may use numbered verbatim text blocks. Retain superseded wording and identify the replacing decision; requirements cite the relevant wording or material location.

## 3. Required outputs and document structure

### 1. `产品研发文档.md`

Deliver the complete current document every round, not just changes or “the rest is unchanged.” Use the following structure for a complete proposal the user can annotate and developers can later read directly. Keep irrelevant section headings and state “Not applicable to this project”; do not substitute placeholders for finished content.

**Header**: product name, version, source materials, and status.

**0. Changes from the previous version**: for the first version, say “First version; no predecessor.” Later versions list what changed, why, annotation or wording evidence, affected sections and diagrams, and status. Distinguish user-approved changes from new AI suggestions.

**1. Product positioning**: problem, audience, usage scenarios, and product scope. Mark designs not explicit in the materials 〔Recommended〕.

**2. Requirements baseline**: separate functional and nonfunctional requirements. For each functional module, list requirement identifier, function and outcome, status, and basis. State first-version scope, exclusions, and deferred work. Cover applicable performance, security, compatibility, and usage limits without imposing irrelevant metrics.

**3. System architecture and modules**: runtime form, module responsibilities, calls or data relationships, technology choices, and reasons. Mark AI-proposed choices 〔Recommended〕; do not state unverified capabilities as facts.

**4. Core flows**: describe who starts where, what they do, results, and important branches and exceptions. Each section cites its diagram identifier; diagrams and prose agree.

**5. Data model**: data sources, principal entities or structures, fields, relationships, and storage. Mark designed fields with status; do not invent data supposedly present in an existing system.

**6. Interfaces or communication**: interactions between modules or external systems, known or proposed messages, inputs, outputs, and error handling. Separate designs from verified interfaces; do not present unknown real interface signatures as directly callable.

**7. Interface guidelines**: for products with a user interface, describe each page's layout, actions, state feedback, results, and requirement basis. Identify what is retained or changed from supplied prototypes or screenshots. Otherwise state “Not applicable to this project.”

**8. Development plan**: list phase, scope and dependencies, what users can see and do when opening the result, estimated traditional human-work days, AI-work days, and estimation basis and assumptions. Acceptance for each phase describes only observable user results, not counts of tests, checks, or protection layers as progress. For each phase and the total, state **AI work = estimated traditional human-work days ÷ 15**, for example **150 days → 10 days**. Label estimates “AI work, human work ÷ 15.” Initially mark estimates 〔Recommended〕, or 〔Open〕 when evidence is insufficient; do not invent delivery commitments.

**9. Test plan**: identify what is and is not tested, which requirements and observable results each verification covers, and dependencies on user environments or manual actions. Design the plan only; do not implement or run tests.

**10. Deployment and delivery**: applicable runtime environments, configuration, installation or packaging, deliverables, and usage instructions. State honestly when deployment is irrelevant.

**11. Risks**: risk, impact, evidence, and recommended handling. Mark speculation and proposed responses 〔Recommended〕; do not silently add mandatory features.

**12. Decisions needed**: keep material conflicts, missing key decisions, and uncertain points here. Other sections reference their identifiers rather than maintaining separate lists.

| Identifier | Conflict or open decision and material source | A and effects | B and effects | Recommendation and reason | Status | User approval wording identifier |
|---|---|---|---|---|---|---|
| Use an actual issue identifier | State the conflicting sources or missing decision | Concrete design | Another concrete design | Choice and reason | 〔Open〕 | Leave blank until approved |

If there are no open decisions, write “None,” without manufacturing issues to fill the table. Retain resolved decisions and approval evidence in the corresponding requirements and wording record.

**13. Development sequence**: a step-by-step checklist for developers or AI, following the project's dependencies and the most direct implementation order rather than a fixed business pattern. List step, corresponding requirements and modules, prerequisites, work, observable user results, and difficulty and difficult points. Identify steps requiring user action. Keep scope consistent with the development plan, add no features, and use the acceptance style from section 8.

**14. Notes for AI development**: for this project's technology choices and risks, explain business rules AI may misunderstand, decisions it must not change, interfaces still requiring verification, and checks needing people or specific environments. Recommend delivering one development step at a time with its required sections and acceptance basis. Do not copy another project's methods, model-capability claims, or schedule conclusions.

**15. Original wording and annotations**: cumulatively retain user wording, annotations, and approvals from every version, not only this round.

| Wording identifier | Version and round when received | Verbatim user wording, annotation, or verbatim text-block identifier | Related requirement or supersession |
|---|---|---|---|
| Actual record identifier | Actual version and round | Unedited text | Related entry |

### 2. `流程图.md`

Provide complete Mermaid source without requiring this window to render it. Give every diagram an identifier, title, document sections, and requirement identifiers. Draw architecture, core business flows, and key branches as needed; mark unconfirmed designs 〔Recommended〕 or 〔Open〕. Prose references such as “Diagram 01” and diagram status must agree. Do not require rendering-tool installation.

If the window can produce HTML, also provide `流程图.html`: one page with no external dependencies, embedded SVG or equivalent static graphics, viewable offline by opening the file. Identifiers and contents match the Mermaid source; no network-loaded graphics.

For products with a user interface, optionally provide `原型图.html`: a single-file static wireframe with no backend or external resources, identifying pages, actions, results, and corresponding requirements. This optional illustration does not block delivery of the complete product document and flow diagrams.

## 4. Deliver a complete new version after user annotations

After the user annotates documents, changes descriptions, or supplies screenshots, read all new materials, record them verbatim in “Original wording and annotations,” and update every affected requirement, flow, diagram, plan, and development step. Increment the version to V0.2, V0.3, and so on.

Reissue the complete product document, flow diagrams, and existing accompanying files each round. Begin with changes from the previous version so the user can see what changed. Mark approved entries 〔Decided〕. When the user says “Follow the recommendations,” confirm only recommendations already shown in that round and within the reply's scope, recording the original wording; do not also approve unseen suggestions. New suggestions remain 〔Recommended〕 and new conflicts enter “Decisions needed.” Continue until the user is satisfied.

### Continuing in a new window

Give the new window this guide and the latest product document and say “Continue.” Include the latest flow diagrams, illustrations, and new annotations if available. Continue from version numbers, statuses, changes, and original wording. Do not reopen decided items or promote recommendations without approval. Rebuild any needed but unavailable illustrations from the latest document, not the old window's chat memory.

## 5. Finalization

Only deliver a finalized version when the user says “Finalize” and “Decisions needed” is empty; open items may move to deferred work. Otherwise explain remaining items and continue. Do not declare finalization yourself or introduce additional mandatory questions.

An optional step before finalization is a separate read-only window without editing permission reviewing the entire requirements pack for omissions and contradictions. List each finding under “Decisions needed” for the user to decide; do not edit documents directly. Skip this step if the user declines.

Record the finalization wording and scope verbatim. Mark only user-approved entries 〔Decided〕, without including unapproved recommendations. Reissue the complete final requirements pack, change the header to “Finalized,” and retain version and changes. Rename “Decisions needed” to “Final confirmation of core business logic,” listing final decisions, statuses, and approval evidence. Deferred work retains its original statuses; keep original wording and annotations. Finalization confirms documents, not authorization to write code or set up the project.

## 6. Realigning partway through development

Provide the existing requirements pack and descriptions or screenshots of what has been built. Preserve wording and identifiers, and reconcile entries using the following three columns. For material not shown, say “No evidence provided”; absence of visible evidence is not evidence that work is missing.

| What you said | What was built | What you can see |
|---|---|---|
| Wording identifier, requirement, and status | Corresponding implementation description and evidence | Screenshot or observable result and evidence |

List each difference in `差异清单.md`: corresponding requirement, difference, evidence, 〔Decided〕/〔Recommended〕/〔Open〕 status, and outstanding approvals. Unapproved corrections remain recommendations. Record original wording with version and round, and completely reissue the new requirements pack and difference list. Explain resulting changes in the change summary. During renewed discussion, restore the header “Discussion draft, not an implementation order,” and use the same finalization conditions.

## 7. Next step

After finalization, place the requirements pack under the project's `需求/`. Open a programming window that can run commands, give it this workflow pack as well, and copy this request:

> Read getting-started.md in the workflow pack and follow it. First read the requirements pack under the project's 需求/; do not ask again about confirmed content.

If the current window is chat-only, hand the workflow pack to that programming window; command execution is not required in this window.
