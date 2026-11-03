# apps/web browser e2e

English | [中文](README.zh.md)

These tests boot the real web composition in-process and drive it with real browsers over real HTTP. Chromium runs the full lane; the [model and reasoning picker scenario](declared-reasoning.e2e.ts) also runs in WebKit to cover native mouse focus behavior. [Session replay recovery](session-replay-reload.e2e.ts) also runs in WebKit, sharing the `fresh-round-trip` recording and expected output without rewriting them. It covers active-stream reload, completed-turn reload, and reopening a Session. The lane's mechanics — modes, fixtures, goldens, and the deliberate composition divergences from `dsh web` — are documented in [`scaffold.ts`](scaffold.ts) and the [browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

The scaffold keeps mutable owner state and Session persistence in separate child directories of an owned temporary root outside the writable workspace. The home is created with private directory permissions and profile inputs are prepared before sessions start; protected-input validation and authenticated owner approval remain enabled. A second Host may explicitly reuse the first scaffold's home for cross-origin persistence checks, while the first scaffold retains cleanup ownership.

After installing workspace dependencies, install the browsers and their system dependencies from the repository root:

```sh
pnpm --filter @panedesk/dsh-web-frontend exec playwright install --with-deps chromium webkit
```

On Linux, `--with-deps` installs dependencies through the system package manager. The persistent CI VM must provide these dependencies through image maintenance; CI installs only the browser binaries, as required by the [failover runbook](../../../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.md).

Ordinary scenarios begin with no registered Workspace or Session and a durable marker recording a removed default Workspace, so explicit folder-selection scenarios retain control of their cwd. `launchWebScaffold({ firstUse: true })` leaves initialization eligible for startup scenarios. Ordinary fixtures persist an explicit remind-only project choice through product settings before browser boot and for newly registered Workspace paths, including those opened by auxiliary pages; `firstUse: true` excludes automatic choices for new paths, and `projectOpeningPending: true` retains all first-entry guidance. The live Session-menu scenario exercises that pending modal and dismisses it before asserting menu interaction and plugin disposal. Its exact surviving menu includes the shipped right-sidebar entry after the fixture plugin is removed. The independent CLI restart scenario also dismisses guidance through Close without saving a policy before exercising reconnection. Fresh-workspace interaction helpers close first-entry guidance through the localized Close button when it obstructs a later action, without confirming a project policy; onboarding scenarios retain direct control instead of using those helpers.

## Completion observations

State-sensitive cases use Workspace, admission, attachment, and model-stream barriers to separate visible intermediate states from completed operations. Model-picker persistence assertions wait for the saved default, independently of menu closure. Details close waits for frame transitions; archive verification assigns an explicit title to the seeded Session and follows that identity across reload. The [CI test reliability workflow](../../../.agents/skills/dsh-ci-test-reliability/SKILL.md#synchronize-on-state) owns these synchronization rules.

[Idle-submission handoff](idle-submission-handoff.e2e.ts) waits up to the scaffold's 30-second turn-completion budget for Host frames and browser placement. Vitest owns scaffold teardown so a replay-consumption error does not replace the failed scenario assertion.

Plugin-manager switches wait up to `PLUGIN_TOGGLE_SETTLE_MS` (10 seconds) for the Host's profile write and the store's follow-up inventory read, the two steps that republish `aria-checked`; that constant's JSDoc records the measured chain.

Explicit scrolling uses `scrollIntoView` from `support.ts`: it resolves the locator again when its old element detaches and checks connection in the same browser task as native scrolling. Scenarios retain their visibility and geometry assertions after scrolling.

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate, because they read Host services directly: `ctx.connection`, the Host `SessionStore`, and `ctx.sessionProjectionCache`. Driving a browser at runtime does not make a file part of the Client program — the two faces merge Cordis `Context` under the same keys with different services, so one program cannot see both. Moving these files into the Client aggregate makes every Host-service access fail to compile. The ledger statistics browser scenario also belongs to this Host program: it supplies synthetic ledger evidence through the owner bridge while exercising both interface languages.

## Do not import `@panedesk/dsh-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript project, and every project it references, into the **Host build graph**. That has bitten this lane once already: four Client consumer packages reference `api/remotes`' Client face, which cannot compile until Host tsdown has generated `@panedesk/dsh-goal/remote`, so the Host build phase ended up waiting on an artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here instead, next to the commented-out import that names the source module. A drift then surfaces as a missed selector or a stale mirrored value — a loud failure, never a silent pass. `scaffold.ts` follows this rule for the welcome-notice namespace, acknowledgement field, version, and asserted Chinese copy.

The built-client harness is the exception. `assembled-boot.ts` imports `AppWebEntry`, the boot-manifest type, and `RemoteMock`; `assembled-remote.ts` imports the Client test runtime's default responses and `RemoteMock`. These packages are explicit project references for booting the real shell against a test-owned carrier. The fixture supplies the built metadata asset before evaluating plugin bundles and removes that global during teardown. Its settings response includes confirmed remind-only choices for fixture Workspace paths so unrelated component scenarios do not open project guidance. The HMR scenario restores that asset, package and app library outputs, and incremental compiler metadata together; otherwise a later bundle can reintroduce the edited copy from an unrestored `lib/types` emit. Cleanup removes newly generated files and recreates removed originals before validating the build record. The chat scenarios mirror `conversationContextKey` in `support.ts` instead of importing its Client owner.

Nothing mechanically enforces this rule; keep it in review.
