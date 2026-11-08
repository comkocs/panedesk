# 席位编排

[English](seat.md) | 中文

本页拥有[席位包组](../../packages/seat/README.zh.md)声明的类型与服务语义。提供方和消费方保持可选；显式组合归[应用组合包](../../packages/seat/seat-app/README.zh.md)所有。

## 身份与权限

`SeatName` 标识节点本地定义；`SeatOperationId` 标识调用方保留的操作。会话身份仍采用上游 `SessionId`。`SeatCallContext` 包含可信适配器提供的已认证主体、来源与节点身份，不能将请求字段当作权限。可选且仅宿主可用的 `SeatCallContext.localWake.opening` 携带精确的无窗开窗凭证，与原唤醒 `authorization` 并存；两者均为实例拥有的能力，不能取自请求 JSON。`SeatBinding` 是会话日志旁的引擎元数据，区分自由与席位两种变体。

## 定义与准入

`SeatDefinition` 冻结其版本、启动及附加目录、开场文本、模型与权限选择、订阅、检查点文件、规则和本地容量。导入预览保留来源及映射摘要；提交所选行时同时检查原始来源和目录版本。来源权限仅通过获授权操作改变。

`SeatCheckpointFile` 必须包含 `path`、`section`、`maxBytes` 和 `required`，可选 `mode: 'section' | 'file'`。省略时选择唯一 Markdown 章节；`file` 忽略 `section`，在既有字节、token 及必需内容限额内保留完整源文本。

`SeatProjectPolicy` 在显式选择前默认为提醒模式。规则不能放宽项目策略。`SeatQueued` 报告 FIFO 标识与阻塞原因，不声称已取得资源。`ChildAdmissionTicket` 表示非阻塞子任务准入；取消未启动票据不终止运行中的子任务。`SeatTurnAdmission` 仅推迟新轮次，保留排队输入。

## 窗口操作

`OpenSeatRequest.startupDirectory` 可选为手动开窗选择精确的已登记目录。本地提供方冻结该起窗选择，不改档案，也不扩大目录权限；省略时保持档案目录，已接纳的重试须保持原选择。

`OpenSeatResult` 区分已打开、已预填、既有窗口选择、已切换、已取消、排队及拒绝结果。创建不意味着首轮完成。`ReplaceSeatResult` 保留新旧身份与清理状态；替换先开新窗再关旧窗，并保留显式交接许可。`CloseSeatResult` 区分已关闭、忙碌、版本冲突和拒绝。未知活动不能作为空闲证据。

`SeatWindowView` 投影运行时状态、忙碌原因、缓存证据和状态版本。`SeatContextUsage` 表示带时间的当前上下文证据，不是累计计费 token。证据缺失保持未知。`SeatFailure` 携带机器码、说明、替代方案、可重试性及观察到的副作用状态；可选 `details` 通过 `agentPreset` 标识 Session 创建前被拒绝的预设，或通过 `provider` 与 `model` 标识不可用模型。`SeatNodeStatus.failure` 报告受监督的运行时失败，可选 `openingFailures` 按会话身份、工位、预设及细因码独立列出未解决的前置条件失败，模型配置失败还可携带提供方及模型身份。可选 `stage: 'turn'` 标记活窗的 `UNKNOWN_MODEL` 或 `session/model-unavailable` 失败，携带本次尝试请求的模型且不改变回合分类。诊断失效通知触发已授权重读；清除条件由[工位引擎](../../packages/seat/seat-engine/README.zh.md)定义。

`SeatMessageWindow` 包含本地在开绑定的席位、会话、节点身份及主窗选择。可选只读能力 `messageWindows()` 从已提交的换窗进度推导选择，排除已关窗口与尚未解除关闭屏障的窗口，不会激活会话。运行时存活性由[消息提供方](../../packages/session/message-delivery-local/README.zh.md)单独检查。

## 引擎记录与查询

`EngineDecision` 在写入所有权与预期序列比较下提交一个含类型化 `EngineEffect` 记录的有界帧。引擎日志独立于会话、计费与消息日志。回调通过稳定标识与发件箱提供至少一次交付；恢复不重放结果不确定的模型副作用。

`EngineCursor` 按节点、序列和副作用索引排他推进。查询时间范围左闭右开；结果公开完整性与已提交水位。导出默认脱敏，除非另获独立授权。验证不执行导入操作。`SeatBudgetSnapshot` 保留未知成本，不将其视为零；`MicroUsd` 使用十进制整数微美元。

## Issued authorization and node admission

`SeatAuthorizationEntry` captures host-authenticated attribution and current policy. `SeatAuthorizationIssuer` returns process-local `SeatAuthorizationGrant` values bound to `SeatAuthorizationCheck`; wire data cannot recreate them. `SeatAuthorizedAction` combines the grant with matching intent effects. `SeatAuthorizationTransactionRequest` adds the expected sequence and decision identity; `SeatAuthorizationTransactionResult` reports a durable commit, sequence conflict, or refusal. `SeatIssuedAuthorizationQueryRequest` and `SeatIssuedAuthorizationQueryResult` include plugin facts without widening legacy engine effects. Exported facts are evidence, not executable authority; historical records without attribution remain unknown.

`NodePreparedRequest` retains method/result correlation and sender-frozen message identity. `NodeDelegationRequest` omits delegation until a trusted issuer creates a `NodeDelegationResult`. `NodeAuthenticatedPeer` comes from transport authentication; receiving policy intersects retained original authority, configured peer permissions, expiry, and current local admission. `NodeLinkFailure` preserves safe refusals. `ApprovePendingSeatRequest`, `PendingSeatMutationResult`, and `SeatRejected` retain the original approval and refusal semantics. Missing services do not grant authority or enable another routing hop.

`HostSdkInvocation` 标识已登记的命名空间方法及其不可信参数。`HostSdkIdentity` 仅携带宿主签发的主体、可选会话与席位归属以及撤销信号；请求字段不能提供该身份。`HostSdkResult` 区分已编码的 JSON 值与安全拒绝。`HostSessionBinding` 向凭据签发器提供可信的会话与席位事实；`HostSessionCredential` 返回仅所有者可读的端点及凭据路径，并提供须等待完成的撤销操作。未安装相应可选提供方时，这些服务保持缺席。

`PendingSeatItem` 可选携带从保留开窗证据投影的 `windowName`、`nodeId` 和 `budget`。缺失证据保持缺席；`SeatBudgetLimits` 值为整数微美元字符串。待批响应不公开冻结指令正文或来源原始数据。

`PendingSeatObservation` 为不变的持久 `PendingSeatItem` 增加可选只读 `retention` 时间投影：区间起点、期限、剩余毫秒数及引擎拥有的阈值阶段。`ListPendingSeatsRequest.includeRejected` 可选将已提交的保留到限拒绝并入既有有限额顺序分页；旧请求与日志帧仍有效。计时及终局语义见[引擎](../../packages/seat/seat-engine/README.zh.md)。

`SeatEngineOperationResult` 保留既有操作状态，增加可选批准登记及关联的待决、开窗或取消进度。`HostAdminQueryRequest` 分别使用效果与授权游标；`HostAdminQueryResult` 携带脱正文效果及独立限额的已签发授权分页。历史事实与查询均不授予执行权限。

## 等待、报告与策略

`SeatWait` 对明确的 subagent、后台任务、调度或消息对象注册任一或全部观察，在完成前返回。取消只影响观察。`CloseSelfReport` 记录关闭意向、未完工作及下次开窗前置条件，不改变运行时状态。

`GateDefinition` 选择已安装判定器、钩子、版本、排序与到期条件。`GateContext` 包含执行器拥有的事实；`GateResult` 保留允许、拒绝或不适用结果与审计状态。`SeatWorktreeHost` 拥有版本校验持久化与强制授权；`SeatReminderHost` 拥有子任务阈值交付。操作字符串和模型文本均不提供授权。

## Cordis API

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhostadmin--hostadminservice"></a>

### `ctx.hostAdmin` — `HostAdminService`

Administration is optional and never starts a second engine to answer a query.

```ts cordis-catalog
/** Dispatch a fixed method with the transport's permitted methods.
 * @param request - Bounded validated request without caller-defined authority.
 * @param authority - Authenticated operator role narrowed to permitted methods.
 * @returns Provider evidence from the running engine or installed capability.
 */
dispatch(request: HostAdminRequest, authority: HostAdminAuthority): Promise<HostAdminResponse>
```

Source: [`packages/host/host-admin/src/index.ts`](../../packages/host/host-admin/src/index.ts)

<a id="ctxhostadminexecutor--hostadminexecutor"></a>

### `ctx.hostAdminExecutor` — `HostAdminExecutor`

Local executors delegate business operations to the running engine and installed providers.

```ts cordis-catalog
/** Invoke only a locally authenticated capability, never another router.
 * @param request - Validated fixed-method request.
 * @param authority - Transport-derived narrowed authority.
 * @returns Provider evidence for the requested business operation.
 */
execute(request: HostAdminRequest, authority: HostAdminAuthority): Promise<HostAdminResponse>
```

Source: [`packages/host/host-admin/src/index.ts`](../../packages/host/host-admin/src/index.ts)

<a id="ctxhostadminsourceoperator--hostadminsourceoperator"></a>

### `ctx.hostAdminSourceOperator` — `HostAdminSourceOperator`

Optional local source owner; absence never starts another engine or delivery path.

```ts cordis-catalog
/** List source work without changing its state.
 * @param params - Optional page limit from 1 through 200.
 * @returns At most 200 provider items, preserving their full keys.
 */
list(params: { limit?: number }): Promise<{ items: SourceOperatorItem[] }>

/** Delegate abandonment to the source owner.
 * @param params - Operation identity, original key and bounded reason.
 * @returns Provider result after its release decisions.
 */
abandon(params: SourceOperatorWriteParams): Promise<SourceOperatorResult>

/** Delegate directed resend when the source owner supplies this capability.
 * @param params - Operation identity, original key and bounded reason.
 * @returns Provider result after its admission and generation decisions.
 */
resend?(params: SourceOperatorWriteParams): Promise<SourceOperatorResult>
```

Source: [`packages/host/host-admin/src/source-operator.ts`](../../packages/host/host-admin/src/source-operator.ts)

<a id="ctxhostsdkinvoker--hostsdkinvoker"></a>

### `ctx.hostSdkInvoker` — `HostSdkInvoker`

The SDK registry provider supplies this optional adapter without starting stdio.

```ts cordis-catalog
/** Decode, authorize, invoke and encode through the registered namespace.
 * @param request - Validated namespace and method with untrusted method parameters.
 * @param identity - Host-issued caller identity and revocation signal.
 * @returns Encoded result or safe rejection without provider diagnostics.
 */
invoke(request: HostSdkInvocation, identity: HostSdkIdentity): Promise<HostSdkResult>
```

Source: [`packages/host/host-admin/src/sdk.ts`](../../packages/host/host-admin/src/sdk.ts)

<a id="ctxhostsessioncredentials--hostsessioncredentials"></a>

### `ctx.hostSessionCredentials` — `HostSessionCredentials`

Optional host-owned issuance; callers supply trusted creation facts, never wire fields.

```ts cordis-catalog
/** Replace any earlier credential for this session and publish owner-only files.
 * @param binding - Trusted session creation binding.
 * @returns Paths and an idempotent awaited revocation capability.
 */
issue(binding: HostSessionBinding): Promise<HostSessionCredential>

/** Revoke a closed or replaced session before acknowledging closure.
 * @param sessionId - Host-owned session identity.
 */
revoke(sessionId: HostSessionBinding['sessionId']): Promise<void>
```

Source: [`packages/host/host-admin/src/sdk.ts`](../../packages/host/host-admin/src/sdk.ts)

<a id="ctxnodeauthorizedlocaladmission--nodeauthorizedlocaladmission"></a>

### `ctx.nodeAuthorizedLocalAdmission` — `NodeAuthorizedLocalAdmission`

Local admission is explicitly supplied by the journal-owning provider, never synthesized by transport.

```ts cordis-catalog
/** Commit the exact grant with the original action intent before dispatching local effects.
 * @param request - Single-hop operation already checked against the local target.
 * @param authorization - Entry-issued, process-local grant with exact operation evidence.
 * @returns Correlated local result after atomic admission; no rerouting is permitted.
 */
execute(request: NodePreparedRequest, authorization: Seat.SeatAuthorizationGrant): Promise<NodeWireResponse>
```

Source: [`packages/seat/node-link/src/execution.ts`](../../packages/seat/node-link/src/execution.ts)

<a id="ctxnodedelegationissuer--nodedelegationissuer"></a>

### `ctx.nodeDelegationIssuer` — `NodeDelegationIssuer`

Host entry captures original authority and signs or retains evidence bound to the exact method.

```ts cordis-catalog
/** Verify live entry authority, binding, method and target before issuing a single-hop delegation.
 * Capture original kind through its trusted issuer, never principalId/origin string inference.
 * Bind method, payload digest, operation, source/target and call causality to retained evidence.
 * Expiry cannot exceed request.deadline, original authority expiry or configured lifetime;
 * skew never extends the signed deadline. Retry keeps identity/digest, not expired authority.
 * Missing issuer retains cross-node-unsupported or a safe authorization refusal before route().
 * @param request - Prepared request without caller-supplied delegation or role.
 * @returns Narrow delegation or refusal; authorizationRef is an audit reference, not a bearer.
 */
issue(request: NodeDelegationRequest): Promise<NodeDelegationResult>
```

Source: [`packages/seat/node-link/src/delegation.ts`](../../packages/seat/node-link/src/delegation.ts)

<a id="ctxnodedelegationreceivingpolicy--nodedelegationreceivingpolicy"></a>

### `ctx.nodeDelegationReceivingPolicy` — `NodeDelegationReceivingPolicy`

Receiving policy intersects original rights, peer allowlist and current local target permissions.

```ts cordis-catalog
/** Validate authenticated peer, hop=1, local target, expiry, digest and retained issuer evidence.
 * Reject missing mappings and privilege amplification, including free-session write escalation.
 * Returned issuer is bound to this operation and locally records node-delegation attribution;
 * delegatedBy retains the sender's original authorization reference, not its local operator role.
 * @param request - Fully decoded request, including sender-frozen message identity when sending.
 * @param peer - Transport-owned node evidence; matching request strings are insufficient.
 * @returns Local exact-operation issuer or refusal, never permission for another routing hop.
 */
authorize(request: NodePreparedRequest, peer: NodeAuthenticatedPeer): Promise<Seat.SeatAuthorizationIssuer | NodeLinkFailure>
```

Source: [`packages/seat/node-link/src/delegation.ts`](../../packages/seat/node-link/src/delegation.ts)

<a id="ctxnodelinkexecutor--nodelinkexecutor"></a>

### `ctx.nodeLinkExecutor` — `NodeLinkExecutor`

Local provider narrows authenticated node delegations and never calls a router again.

```ts cordis-catalog
/** Check the current binding, principal, target and method rights on the receiving node.
 * @param request - Validated request authenticated to its configured source node.
 * @returns Whether current local policy permits this exact delegation.
 */
authorize(request: NodeWireRequest): Promise<boolean>

/** Execute through the original local provider after durable transport admission.
 * @param request - Authorized fixed-method operation.
 * @returns Correlated local provider result.
 */
execute(request: NodeWireRequest): Promise<NodeWireResponse>

/** Observe current local capacity without starting an engine.
 * @returns Local node self-report.
 */
status(): Promise<Seat.SeatNodeStatus>
```

Source: [`packages/seat/node-link/src/index.ts`](../../packages/seat/node-link/src/index.ts)

<a id="ctxnoderouter--noderouterservice"></a>

### `ctx.nodeRouter` — `NodeRouterService`

Receiver invokes local providers only; delegation is authenticated again and cannot add hops.

```ts cordis-catalog
/** Route one bounded authenticated request without offline user-operation queues.
 * @param request - Fixed method, digest, deadline and narrowed delegation.
 * @param recovery - Trusted local recovery intent and current sender lifetime, never wire authority.
 * @returns Target result or explicit unknown outcome retaining operation identity.
 */
route(request: NodeWireRequest, recovery?: { reconcile: boolean; active: () => boolean }): Promise<NodeWireResponse>

/** Read dated health without initiating a model or opening a window.
 * @returns Node aliases and explicit stale/unreachable evidence.
 */
status(): Promise<readonly NodeLinkStatus[]>
```

Source: [`packages/seat/node-link/src/index.ts`](../../packages/seat/node-link/src/index.ts)

<a id="ctxnodes--nodesservice"></a>

### `ctx.nodes` — `NodesService`

The browser cannot supply a principal, grant, host epoch or arbitrary administrative method.

```ts cordis-catalog
/** Read installed node and live callback providers without starting an engine or sending work.
 * @returns Current provider observations and the configured polling interval.
 */
@Remote async read(): Promise<{ view: NodeHealthView; refreshIntervalMs: number }>

/** Execute one explicitly confirmed action under the authenticated owner's existing local-operator path.
 * @param action - Fixed local tunnel, callback resolution or source-owner action.
 * @returns Provider refusal, uncertainty or committed evidence; a transport failure is never success.
 */
@Remote act(action: NodeAction): Promise<NodeActionResult>
```

Source: [`packages/client/ui-nodes/src/index.ts`](../../packages/client/ui-nodes/src/index.ts)

<a id="ctxnodeworkchain--chainservices"></a>

### `ctx.nodeWorkChain` — `ChainServices`

Explicit composition supplies every security and local-admission dependency.

```ts cordis-catalog
/** Optional restricted outbox entry; absence retains unknown intents without replay.
 * @param request - Complete original request read from the sender's durable store.
 * @returns Captured exact-intent issuer, or absence when this outbox does not own the intent.
 */
outboxIssuer?(request: ChainRequest): Promise<Seat.SeatAuthorizationIssuer | undefined>
```

Source: [`packages/seat/node-link/src/chain-services.ts`](../../packages/seat/node-link/src/chain-services.ts)

<a id="ctxnodeworkchainbusiness--nodeworkchainbusinessregistry"></a>

### `ctx.nodeWorkChainBusiness` — `NodeWorkChainBusinessRegistry`

Optional node-link registry definition; business providers depend only on this declaration.

```ts cordis-catalog
/** Register through a Cordis effect; each business method has one provider globally.
 * @param provider - Owner of one or more business methods, excluding chain.operation.
 * @returns Disposer removing the registration.
 * @throws If any method already has a provider, including registration of the same provider again; no partial registration is allowed.
 */
register(provider: T.NodeWorkChainBusinessProvider): Disposable

/** Resolve the business owner, never transport state or the legacy operation query.
 * @param method - Exact business method excluding chain.operation.
 * @returns Registered provider, or undefined when absent.
 */
resolve(method: T.NodeWorkChainBusinessMethod): T.NodeWorkChainBusinessProvider | undefined

/** Wait for every listed method's provider to finish recovering persisted intents and inboxes.
 * @param methods - Methods whose receiving capabilities may be advertised only after resolution.
 * @returns Recovery barrier; provider recovery failure rejects and missing providers cannot satisfy it.
 */
ready(methods: readonly T.NodeWorkChainBusinessMethod[]): Promise<void>
```

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxnodeworkchainrouter--chainrouterservice"></a>

### `ctx.nodeWorkChainRouter` — `ChainRouterService`

Opt-in router remains distinct from the unchanged legacy router API.

```ts cordis-catalog
/** Send only after both peers advertise this method, retaining unknown intent.
 * @param request - Entry-authorized frozen request.
 * @param authorization - Fresh process-local entry grant matching every delegation field.
 * @returns Correlated result or explicit safe failure.
 */
route(request: ChainRequest, authorization: Seat.SeatAuthorizationGrant): Promise<ChainResponse>

/** Reconcile retained intents before replay; absence leaves uncertain delivery pending.
 * @param issuerFor - Exact durable-intent owner, returning fresh restricted authority per check.
 * @returns Completion of one query-before-replay pass.
 */
recover?(issuerFor: (request: ChainRequest) => Promise<Seat.SeatAuthorizationIssuer | undefined>): Promise<void>
```

Source: [`packages/seat/node-link/src/chain-services.ts`](../../packages/seat/node-link/src/chain-services.ts)

<a id="ctxseatapprovals--seatapprovals"></a>

### `ctx.seatApprovals` — `SeatApprovals`

The authenticated owner may confirm pending work, never bypass engine admission.

```ts cordis-catalog
/** Observe pending confirmations without creating an engine or admitting work.
 * @param signal - Remote stream lifetime.
 * @returns complete queue observations; disabled configuration yields no entries.
 */
@Remote({ mode: 'stream' }) async *watchPending(signal: AbortSignal): AsyncIterable<ApprovalQueueView>

/** Commit approval with the existing transactional engine capability.
 * @param request - Observed queue identity, version and stable operation identity.
 * @returns committed confirmation or the original engine refusal; not an opening receipt.
 */
@Remote approve(request: Seat.ApprovePendingSeatRequest): Promise<Seat.PendingSeatMutationResult>

/** Cancel the observed queue revision without closing an existing window.
 * @param request - Observed queue identity, version and stable operation identity.
 * @returns committed cancellation or the original engine refusal.
 */
@Remote cancel(request: Seat.ApprovePendingSeatRequest): Promise<Seat.PendingSeatMutationResult>

/** Observe durable approval and correlated opening progress without replaying writes.
 * @param request - Exact original operation identity.
 * @param signal - Remote stream lifetime.
 * @returns durable progress, including actual opened metadata or a recorded opening failure.
 */
@Remote({ mode: 'stream' }) async *watchOperation(request: Seat.SeatOperationQuery, signal: AbortSignal): AsyncIterable<Seat.SeatEngineOperationResult>
```

Source: [`packages/client/ui-seat-approvals/src/index.ts`](../../packages/client/ui-seat-approvals/src/index.ts)

<a id="ctxseatauthorizationexports--seatauthorizationexports"></a>

### `ctx.seatAuthorizationExports` — `SeatAuthorizationExports`

Separate JSON export includes issued kinds without widening legacy engine effects.

```ts cordis-catalog
/** Export one bounded page with its physical cursor and committed watermark.
 * @param request - Issued attribution filters and page bound.
 * @returns Versioned JSON page or a structured refusal; grants are never exported.
 */
export(request: SeatIssuedAuthorizationQueryRequest): Promise<{ format: 'seat-authorization/v1' content: string complete: boolean watermark: number } | SeatRejected>
```

Source: [`packages/seat/seat/src/authorization.ts`](../../packages/seat/seat/src/authorization.ts)

<a id="ctxseatauthorizationissuers--seatauthorizationissuers"></a>

### `ctx.seatAuthorizationIssuers` — `SeatAuthorizationIssuers`

Available only to trusted in-process adapters, never exposed as a wire method.

```ts cordis-catalog
/** Capture one authenticated entry; request JSON must never supply this registration.
 * @param entry - Host-owned identity and live-policy closure.
 * @returns Issuer and revocation disposer.
 */
register(entry: SeatAuthorizationEntry): { issuer: SeatAuthorizationIssuer; dispose(): void }
```

Source: [`packages/seat/seat/src/authorization.ts`](../../packages/seat/seat/src/authorization.ts)

<a id="ctxseatauthorizationqueries--seatauthorizationqueries"></a>

### `ctx.seatAuthorizationQueries` — `SeatAuthorizationQueries`

Read-only authorization projection definition; it does not enable a new ledger writer.

```ts cordis-catalog
/** Optional reader for committed authorization facts.
 * @param request - Authorized task, seat and time filters.
 * @returns Redacted facts with watermark or a structured refusal.
 */
query?(request: T.SeatAuthorizationQueryRequest): Promise<T.SeatAuthorizationQueryResult | T.SeatRejected>

/** Read engine facts by task without changing the legacy query method.
 * @param request - Task filter and existing pagination fields.
 * @returns Committed matching effects or a structured refusal.
 */
tasks(request: T.SeatTaskQueryRequest): Promise<T.EngineQueryResult | T.SeatRejected>
```

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatauthorizationtransactions--seatauthorizationtransactions"></a>

### `ctx.seatAuthorizationTransactions` — `SeatAuthorizationTransactions`

Installed only with a compatible journal writer, replay validator and query projection.

```ts cordis-catalog
/** Revalidate current ownership before resuming an already admitted external action.
 * This check is not a commit receipt and cannot replace transactional intent admission.
 * @param request - Exact original operation and causal evidence.
 * @param authorization - Live entry-owned grant, never a historical fact.
 * @returns Null for current allowed authority, otherwise a structured refusal.
 */
validate?(request: SeatAuthorizationCheck, authorization: SeatAuthorizationGrant): Promise<SeatRejected | null>

/** Commit authorization and action effects in one engine decision, never a second audit store.
 * The synchronous builder runs under existing journal serialization after the sequence CAS.
 * Validate grant ownership/current policy and exact operation/digest/call correlation before commit.
 * Allowed actions require matching intent effects; denied facts must not admit action effects.
 * Same decision/operation/call identity and digest returns the original receipt; mismatch rejects.
 * Fsync failure prevents dispatch; ambiguous writes require recovery, never blind resubmission.
 * Reader capability must be negotiated before writing; legacy readers must refuse unknown facts.
 * @param request - Stable decision and action identity with the expected committed sequence.
 * @param build - Synchronous preparation of one issued fact and its corresponding action effects.
 * @returns Durable receipt, sequence conflict or refusal; no result authorizes a second execution.
 */
transact(request: SeatAuthorizationTransactionRequest, build: () => SeatAuthorizedAction): Promise<SeatAuthorizationTransactionResult>

/** Use the original approval transition, committing its issued fact in the same decision.
 * Recheck queue revision and grant policy under journal serialization; do not call legacy
 * approve() after a separate audit commit. Missing capability refuses rather than bypassing it.
 * @param request - Original pending identity, expected version and operation identity.
 * @param authorization - Entry-issued exact-operation grant; attribution is never inferred.
 * @returns Original approval/conflict/refusal after the combined decision is durable.
 */
approve(request: ApprovePendingSeatRequest, authorization: SeatAuthorizationGrant): Promise<PendingSeatMutationResult>

/** Cancel pending work and commit its issued attribution in the same decision.
 * @param request - Exact queue revision, operation identity and optional bounded reason.
 * @param authorization - Entry-issued grant covering the target seat and tasks.
 * @returns Original mutation reply or a structured lifecycle refusal.
 */
cancel?(request: import('./types.ts').CancelPendingSeatRequest, authorization: SeatAuthorizationGrant): Promise<PendingSeatMutationResult>

/** Rebuild the same redacted projection on restart, without reading process-local grant objects.
 * @param request - Authorized task, seat, kind and time filters with an exclusive cursor.
 * @returns Matching facts once each, scanned watermark and explicit completeness or refusal.
 */
query(request: SeatIssuedAuthorizationQueryRequest): Promise<SeatIssuedAuthorizationQueryResult | SeatRejected>

/** Read durable operation progress without admitting or retrying any action.
 * @param request - Stable operation identity.
 * @returns Registration and latest correlated progress, or missing when no fact exists.
 */
operation?(request: import('./types.ts').SeatOperationQuery): Promise<SeatEngineOperationResult>
```

Source: [`packages/seat/seat/src/authorization.ts`](../../packages/seat/seat/src/authorization.ts)

<a id="ctxseatauthorizedengineactions--seatauthorizedengineactions"></a>

### `ctx.seatAuthorizedEngineActions` — `SeatAuthorizedEngineActions`

Optional engine actions preserve their original admission builders and attach issued authority.

```ts cordis-catalog
/** Cancel only while the queue item remains undispatched.
 * @param request - Exact queue revision and optional cancellation reason.
 * @param authorization - Entry-issued grant for this operation.
 * @returns Revision-checked cancellation or structured refusal.
 */
cancel?(request: import('./types.ts').CancelPendingSeatRequest, authorization: SeatAuthorizationGrant): Promise<PendingSeatMutationResult>

/** Renew only after the attempt and authorization commit together.
 * @param request - Original renewal input.
 * @param authorization - Entry-issued grant for the exact input.
 * @returns Original maintenance result or admission refusal.
 */
renew(request: import('./types.ts').RenewSeatRequest, authorization: SeatAuthorizationGrant): Promise<import('./types.ts').RenewSeatResult>

/** Queue replacement and authorization in one decision without acquiring a second owner.
 * @param request - Original replacement input.
 * @param authorization - Entry-issued grant for the exact input.
 * @returns Original replacement result or admission refusal.
 */
replace(request: import('./types.ts').ReplaceSeatRequest, authorization: SeatAuthorizationGrant): Promise<import('./types.ts').ReplaceSeatResult>
```

Source: [`packages/seat/seat/src/authorization.ts`](../../packages/seat/seat/src/authorization.ts)

<a id="ctxseatdefinitionrevisions--seatdefinitionrevisionprovider"></a>

### `ctx.seatDefinitionRevisions` — `SeatDefinitionRevisionProvider`

Immediate observations never create business intents or authorize frozen execution.

```ts cordis-catalog
/** Await local read and authorization recovery.
 * @returns Readiness of this registration, never a withdrawn predecessor.
 */
ready(): Promise<void>

/** Observe current registration ownership synchronously.
 * @returns False before readiness or after withdrawal.
 */
available(): boolean

/** Read one local definition under an independently issued exact read grant.
 * @param request - Complete read scope, including the intended frozen opening method.
 * @param authority - Live receiver-issued authority; historical facts grant nothing.
 * @returns Only the exact node, seat and revision, or a sanitized refusal.
 */
read(request: SeatDefinitionRevisionRequest, authority: SeatCallContext): Promise<SeatDefinitionRevisionResult>
```

Source: [`packages/seat/seat/src/types.ts`](../../packages/seat/seat/src/types.ts)

<a id="ctxseatdirectories--seatdirectoryservice-abstract-seam"></a>

### `ctx.seatDirectories` — `SeatDirectoryService` (abstract seam)

Additional-root tools retain filesystem permission checks and do not widen shell write policy.

```ts cordis-catalog
/** Enumerate only roots authorized for this binding.
 * @param sessionId - trusted caller Session.
 * @returns registered roots and effective writability.
 */
abstract roots(sessionId: SessionId): Promise<readonly T.SeatDirectoryRoot[]>

/** Read within a registered root with explicit truncation.
 * @param request - root identity, relative path and byte bound.
 * @returns bounded content or a filesystem refusal.
 */
abstract read(request: T.SeatDirectoryReadRequest): Promise<T.SeatDirectoryReadResult>

/** Write only after memory ownership and provider permission admission.
 * @param request - registered root and attributed content.
 * @returns committed write or a refusal without permission escalation.
 */
abstract write(request: T.SeatDirectoryWriteRequest): Promise<T.SeatDirectoryWriteResult>

/** Apply an exact edit under the same policy as write.
 * @param request - root identity and old/new content.
 * @returns committed edit or a match/permission refusal.
 */
abstract edit(request: T.SeatDirectoryEditRequest): Promise<T.SeatDirectoryWriteResult>
```

Types: [SessionId](core.zh.md)

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatengine--seatengineservice-abstract-seam"></a>

### `ctx.seatEngine` — `SeatEngineService` (abstract seam)

Engine owns the journal, queues, resources and outbox; local providers depend only on this definition.

```ts cordis-catalog
/** Commit ingress before acknowledging acceptance.
 * @param envelope - authenticated bounded source event.
 * @returns stable accepted, duplicate, coalesced or rejected identity.
 */
abstract accept(envelope: T.TriggerEnvelope): Promise<T.AcceptTriggerResult>

/** Commit frozen admission; never route again.
 * @param request - Frozen source input, route and expected local definition revision.
 * @param authority - Process-local caller identity.
 * @returns Durable acceptance or refusal without source-side execution resources.
 */
acceptFrozen?(request: T.AcceptFrozenTriggerRequest, authority: T.SeatCallContext): Promise<T.AcceptFrozenTriggerResult>

/** Install the local Session executor without coupling engine storage to its implementation.
 * @param executor - trusted local implementation.
 * @returns disposer that drains in-flight recovery before detaching.
 */
abstract registerExecutor(executor: T.SeatOpenExecutor): () => Promise<void>

/** Queue a replacement without bypassing either window's capacity.
 * @param request - old window and retained transaction identity.
 * @returns the durable replacement state.
 */
abstract replace(request: T.ReplaceSeatRequest): Promise<T.ReplaceSeatResult>

/** Commit a flushed close together with release and source callbacks.
 * @param closed - provider-confirmed archive, title and flush result.
 * @returns after all close facts are durable.
 */
abstract recordClosed(closed: import('./events.ts').EngineCloseData): Promise<void>

/** Use the same durable maintenance path as automatic renewal, marked as manual.
 * @param request - local window and caller-retained operation identity.
 * @returns renewed, rejected or uncertain without conversation content.
 */
abstract renew(request: T.RenewSeatRequest): Promise<T.RenewSeatResult>

/** Reevaluate pending work and original open identities.
 * @returns after the current reconciliation batch settles.
 */
abstract drive(): Promise<void>

/** Admit a child through the parent's persistent FIFO capacity.
 * @param request - frozen ticket and resolved parent limit.
 * @returns durable queued or admitted ticket.
 */
abstract admitChild(request: T.AdmitSeatChildRequest): Promise<T.ChildAdmissionResult>

/** Release a settled child and wake queued admission.
 * @param ticketId - original admission identity.
 * @returns after release is durable.
 */
abstract releaseChild(ticketId: T.ChildTicketId): Promise<void>

/** Check a new turn before inbox claim; never interrupts an existing turn.
 * @param sessionId - exact window identity.
 * @returns allow or a durable-policy deferral.
 */
abstract admitTurn(sessionId: SessionId): Promise<T.SeatTurnAdmission>

/** Commit a rejected external-source attempt without admitting it to the opening queue.
 * @param request - bounded source identity, body digest, observation time and sanitized failure.
 * @returns only after the source/rejected audit fact is durable; storage failures reject.
 */
abstract auditSourceRejection(request: { sourceId: T.SeatSourceId digest: T.SeatDigest observedAt: T.SeatTimestamp error: T.SeatFailure }): Promise<void>

/** Register a trusted source without persisting callback code or credentials.
 * @param source - installed source adapter and redelivery horizon.
 * @returns asynchronous disposer that stops ingress and drains accepted calls.
 */
abstract registerSource(source: T.SeatTriggerSource): () => Promise<void>

/** Write one complete decision under journal ownership and sequence CAS.
 * @param request - bounded frame and expected committed sequence.
 * @returns durable frame or a sequence conflict.
 */
abstract transact(request: T.EngineTransactionRequest): Promise<T.EngineTransactionResult>

/** Frame and commit effects under engine-owned canonical encoding and sequence CAS.
 * @param request - stable decision identity, observed facts and expected committed watermark.
 * @returns committed frame, current watermark conflict or explicit refusal.
 */
abstract appendEffects(request: { decisionId: import('./events.ts').EngineDecisionId; expectedSequence: number; observedAt: T.SeatTimestamp; policyRevision: number; effects: readonly import('./events.ts').EngineEffect[] }): Promise<T.EngineTransactionResult>

/** Reconcile original identities without replaying uncertain model side effects.
 * @returns only after recovery barriers and projections are ready.
 */
abstract ready(): Promise<void>

/** Stop ingress and drain owned work without deleting persistent queues.
 * @returns only after journal flush and owner-lock release.
 */
abstract shutdown(): Promise<void>

/** Report local capacity and recovery state.
 * @returns node alias, window count and explicit unlimited capacity.
 */
abstract nodeStatus(): Promise<T.SeatNodeStatus>

/** Select the project mode explicitly, retaining paused work on tightening.
 * @param request - policy revision and new mode.
 * @returns committed modeChosen policy.
 */
abstract setProjectMode(request: T.SetProjectModeRequest): Promise<T.SetProjectModeResult>

/** Restore a previous mode and first-choice flag without overwriting concurrent choices.
 * @param request - original policy fields and the revision owned by the compensating operation.
 * @returns committed restoration or a revision conflict.
 */
abstract resetProjectMode(request: T.ResetProjectModeRequest): Promise<T.SetProjectModeResult>

/** Register the sole synchronous saved-choice resolver used by first admission.
 * @param resolver - product-owned lookup for an admitted seat definition; must not write or await.
 * @returns disposer withdrawing this resolver without deleting committed policy.
 */
abstract registerProjectPolicyResolver(resolver: T.SeatProjectPolicyResolver): () => void

/** Query project mode without changing the first-choice flag.
 * @param projectId - exact policy owner.
 * @returns resolved policy, defaulting to remind and modeChosen false.
 */
abstract projectPolicy(projectId: T.SeatProjectId): Promise<T.SeatProjectPolicy>

/** Read durable pending work without exposing source credentials.
 * @param request - bounded filters and cursor.
 * @returns page, watermark and completeness.
 */
abstract pending(request: T.ListPendingSeatsRequest): Promise<T.ListPendingSeatsResult>

/** Approve only reminder confirmation; all other admission rules still apply.
 * @param request - pending identity and expected version.
 * @returns committed approval or conflict.
 */
abstract approve(request: T.ApprovePendingSeatRequest): Promise<T.PendingSeatMutationResult>

/** Cancel unopened work without closing an existing window.
 * @param request - pending identity and expected version.
 * @returns committed cancellation or conflict.
 */
abstract cancel(request: T.CancelPendingSeatRequest): Promise<T.PendingSeatMutationResult>

/** Reconfigure authorized budget limits without erasing cost evidence.
 * @param request - expected budget revision and authorization reference.
 * @returns reevaluated committed budget.
 */
abstract configureBudget(request: T.ConfigureSeatBudgetRequest): Promise<T.ConfigureSeatBudgetResult>

/** Read reference-price cost, including descendants and maintenance.
 * @param sessionId - local window identity.
 * @returns known or unknown cost with the committed watermark.
 */
abstract budget(sessionId: SessionId): Promise<T.SeatBudgetSnapshot>

/** Aggregate accounting evidence without imposing an account concurrency default.
 * @param request - half-open interval and optional local-node filter.
 * @returns rate-limit counts, unique calls, peak concurrency and unknown-account bucket.
 */
abstract accountUsage(request: T.SeatAccountUsageRequest): Promise<T.SeatAccountUsageResult>

/** Read committed engine effects with exclusive cursor advancement.
 * @param request - bounded filters and half-open time range.
 * @returns effects, watermark and explicit completeness.
 */
abstract query(request: T.EngineQueryRequest): Promise<T.EngineQueryResult>

/** Export stable ordered JSONL; raw authorized data is explicit opt-in.
 * @param request - target file and redaction authorization.
 * @returns exported count and digest or an actionable failure.
 */
abstract export(request: T.EngineExportRequest): Promise<T.EngineExportResult>

/** Verify an offline file without executing its imported operations.
 * @param request - explicit input file.
 * @returns framing integrity, preserved-tail status and watermark.
 */
abstract verify(request: T.EngineVerifyRequest): Promise<T.EngineVerifyResult>

/** Observe admission without blocking the parent tool on capacity.
 * @param ticketId - retained admission identity.
 * @returns committed ticket or null when absent.
 */
abstract ticket(ticketId: T.ChildTicketId): Promise<T.ChildAdmissionTicket | null>

/** Cancel an unstarted child request without terminating running work.
 * @param request - parent authorization and expected version.
 * @returns cancelled or already-admitted state.
 */
abstract cancelTicket(request: T.CancelChildTicketRequest): Promise<T.CancelChildTicketResult>

/** Replay committed decisions then observe new ones; return releases the subscription.
 * @param cursor - exclusive durable resume point, absent starts at retained history.
 * @returns ordered durable frames; storage errors reject iteration.
 */
abstract subscribe(cursor?: T.EngineCursor): AsyncIterable<EngineDecision>
```

Types: [SessionId](core.zh.md)

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatenginequery--seatenginequeryservice-abstract-seam"></a>

### `ctx.seatEngineQuery` — `SeatEngineQueryService` (abstract seam)

Offline observations never acquire ownership, repair storage or start runtime drivers.

```ts cordis-catalog
/** Read verified facts through the last complete frame.
 * @param request - bounded filters and exclusive cursor.
 * @returns facts and watermark, or a structured storage refusal.
 */
abstract query(request: T.EngineQueryRequest): Promise<T.EngineQueryResult | T.SeatRejected>

/** Rebuild pending work without activating it.
 * @param request - bounded pending filters.
 * @returns redacted pending page or a structured storage refusal.
 */
abstract pending(request: T.ListPendingSeatsRequest): Promise<T.ListPendingSeatsResult | T.SeatRejected>

/** Return JSONL content in memory; the requested output path is never written.
 * @param request - selection and explicit raw-data authorization.
 * @returns content, digest and coverage, or a structured storage refusal.
 */
abstract export(request: T.EngineExportRequest): Promise<(Extract<T.EngineExportResult, { status: 'exported' }> & { content: string; complete: boolean }) | T.SeatRejected>

/** Verify a file without importing or repairing it.
 * @param request - explicit input file.
 * @returns framing integrity or a structured storage refusal.
 */
abstract verify(request: T.EngineVerifyRequest): Promise<T.EngineVerifyResult>
```

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatgates--seatgateservice-abstract-seam"></a>

### `ctx.seatGates` — `SeatGateService` (abstract seam)

Registry provider owns deterministic evaluation, durable hit counts and expiration.

```ts cordis-catalog
/** Read the node policy clock's IANA time zone, independently of rule and budget zones.
 * @returns configured node time zone, or UTC when no override is supplied.
 */
getTimeZone(): string

/** Register installed code, never source-provided expressions.
 * @param criterion - typed evaluator with validated parameter ownership.
 * @returns disposer that removes the contribution.
 */
abstract register(criterion: GateCriterion): () => void

/** Evaluate order/id deterministically and commit each stable call's hit once.
 * @param context - executor-owned facts and invocation identity.
 * @returns ordered decisions; deny may short-circuit subsequent gates.
 */
abstract evaluate(context: GateContext): Promise<readonly GateResult[]>

/** Optional batch scope preflight; absence must not downgrade task batches to concurrency without evidence.
 * @param context - Complete task, node, seat and scope evidence.
 * @returns Conservative intersection decision and serial alternative.
 */
evaluateTaskScopes?(context: import('./gates.ts').TaskScopeBatchGateContext): Promise<import('./gates.ts').TaskScopeGateDecision>

/** Read hit counts and expiry by revision.
 * @param request - bounded gate filters.
 * @returns committed counter page.
 */
abstract list(request: T.ListSeatGatesRequest): Promise<T.ListSeatGatesResult>

/** Verify explicit worktree registration without scanning unrelated directories.
 * @param request - tree, policy identity and optional authorized force.
 * @returns registration or executable alternatives.
 */
abstract registerWorktree(request: T.RegisterSeatWorktreeRequest): Promise<T.SeatWorktreeResult>

/** Publish cleanup suggestions without deleting or committing any tree.
 * @param request - authenticated task settlement fact.
 * @returns affected trees and safe alternatives.
 */
abstract onTaskEnded(request: T.SeatTaskEndedRequest): Promise<T.SeatWorktreeResult>

/** Emit one durable next-step handoff reminder per child context epoch and threshold revision.
 * @param request - child-owned context evidence and bounded handoff summary.
 * @returns observable delivery or evidence status; never changes notice semantics.
 */
abstract remindChild(request: import('./gates.ts').SeatChildThresholdRequest): Promise<'sent' | 'below' | 'unknown' | 'unavailable'>
```

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatgatesquery--seatgatesqueryservice-abstract-seam"></a>

### `ctx.seatGatesQuery` — `SeatGatesQueryService` (abstract seam)

Offline gate observations never evaluate policies or acquire engine ownership.

```ts cordis-catalog
/** Rebuild recorded gate revisions without inventing unrecorded policies or limits.
 * @param request - bounded gate filters and snapshot-relative cursor.
 * @returns recorded counters, expiry and limit evidence, or a structured refusal.
 */
abstract list(request: T.ListSeatGatesRequest): Promise<import('./gates.ts').SeatGatesQueryResult | T.SeatRejected>
```

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatlocalcallbackowner--seatlocalcallbackowner"></a>

### `ctx.seatLocalCallbackOwner` — `SeatLocalCallbackOwner`

Optional same-node owner; complete keys are correlation, never authorization. Providers independently recover retained callbacks and validate fresh restricted grants. Publish only after inbox and business recovery; withdrawal stops admission and drains calls.

```ts cordis-catalog
/** Await this provider generation's inbox and business recovery. */
ready(): Promise<void>

/** Report whether this generation accepts new calls.
 * @returns False before recovery or after withdrawal.
 */
available(): boolean

/** Query only source.deliverCallback with a complete callback key.
 * @param request - Retained full business key, including callbackId, and original digest.
 * @returns Exact owner outcome; unready providers must never report missing.
 */
query(request: NodeWorkChainOperationRequest): Promise<SeatCallbackAttemptResult<NodeWorkChainOperationResult>>

/** Deliver only the original callback after independently verifying its retained identity.
 * @param request - Immutable callback, route, evidence and digest.
 * @param key - Complete source.deliverCallback key with callbackId; grants no authority.
 * @returns Committed only after every original owner step completes.
 */
deliver(request: DeliverSourceCallbackRequest, key: NodeWorkChainOperationKey): Promise<SeatCallbackAttemptResult<DeliverSourceCallbackResult>>
```

Source: [`packages/seat/seat/src/types.ts`](../../packages/seat/seat/src/types.ts)

<a id="ctxseatlocalcreation--localseatcreation"></a>

### `ctx.seatLocalCreation` — `LocalSeatCreation`

Trusted adapters scope one confirmed traditional creation, never wire-provided identity.

```ts cordis-catalog
/** Retain a single-use choice for the authenticated caller.
 * @param cwd - requested directory.
 * @param authority - adapter-authenticated caller.
 * @returns one-use traditional confirmation.
 */
confirmTraditional(cwd: string, authority: T.SeatCallContext): Promise<T.DirectoryConfirmation>

/** Execute a traditional create using a previously confirmed choice.
 * @param confirmation - retained single-use capability.
 * @param authority - authenticated adapter caller.
 * @param create - upstream creation operation.
 * @returns upstream result unchanged.
 */
run<R>(confirmation: T.DirectoryConfirmation, authority: T.SeatCallContext, create: () => Promise<R>): Promise<R>
```

Source: [`packages/seat/seat-local/src/create-admission.ts`](../../packages/seat/seat-local/src/create-admission.ts)

<a id="ctxseatlocalread--seatlocalreadaccess"></a>

### `ctx.seatLocalRead` — `SeatLocalReadAccess`

Provider-owned read capabilities for trusted in-process gates and tools, never remote adapters. External SeatService calls still require explicit authority; no mutation facade is exposed.

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatlocalsession--seatlocalsessionaccess"></a>

### `ctx.seatLocalSession` — `SeatLocalSessionAccess`

Provider-owned authorization for tools; read capabilities never grant mutation authority.

```ts cordis-catalog
/** Capture the live Session object supplied by the tool executor.
 * @param session - registered calling Session, not a model-supplied identifier.
 * @returns four operations that reject targets outside this Session.
 */
forSession(session: import('@panedesk/dsh-session').Session): SeatSessionOperations
```

Types: [Session](session.zh.md)

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatlocalwindows--seatlocalwindowsaccess"></a>

### `ctx.seatLocalWindows` — `SeatLocalWindowsAccess`

Provider-owned authorization for explicitly selected windows on this node.

```ts cordis-catalog
/** Capture the executor's live Session and tool call, not a target window identity.
 * @param invocation - trusted executor context; the Session must remain registered.
 * @returns six operations stamped with this invocation's stable operation identity.
 */
forInvocation(invocation: { session: import('@panedesk/dsh-session').Session callId: import('@panedesk/dsh-brand').Branded<'ToolCallId'> }): SeatWindowOperations
```

Types: [Session](session.zh.md) · [ToolCallId](core.zh.md)

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatopeningcontexts--seatopeningcontexts"></a>

### `ctx.seatOpeningContexts` — `SeatOpeningContexts`

Optional opening service definition; no provider is installed by this module.

```ts cordis-catalog
/** Prepare and retain input at the sole source owner without waiting for execution.
 * @param request - Exact source, epoch, task and operation identities.
 * @param authority - Authenticated original caller.
 * @returns Frozen input and reservation or refusal.
 */
prepare?(request: T.PrepareSourceOpeningRequest, authority: T.SeatCallContext): Promise<T.PrepareSourceOpeningResult>

/** Recheck an exact retained reservation without reading source text again.
 * @param request - Original reservation and actual execution node.
 * @param authority - Authenticated restricted caller.
 * @returns Current permission; unknown retains occupancy.
 */
checkAdmission?(request: T.CheckSourceAdmissionRequest, authority: T.SeatCallContext): Promise<T.CheckSourceAdmissionResult>

/** Retain a callback before performing source-owned writeback steps.
 * @param request - Original callback, route and frozen runtime evidence.
 * @param authority - Authenticated execution-node identity.
 * @returns Committed only after all original steps finish.
 */
deliverCallback?(request: T.DeliverSourceCallbackRequest, authority: T.SeatCallContext): Promise<T.DeliverSourceCallbackResult>

/** Install one trusted scope owner; omission retains the existing scope evaluation.
 * @param admission - Owner of serialized checks and durable reservations.
 * @returns Disposer that stops new calls and drains active admissions.
 */
registerScopeAdmission?(admission: T.OpeningScopeAdmission): () => Promise<void>

/** Install the sole trusted source owner; omission preserves the legacy opening service.
 * @param owner - Owner of source preparation, admission checks and callback delivery.
 * @returns Disposer that stops new calls and drains in-flight calls before removing the owner.
 * @throws If a source owner is already registered, including the same owner again.
 */
registerSourceOwner?(owner: T.SeatSourceOwner): () => Promise<void>

/** Register trusted resolver code through a Cordis effect.
 * @param provider - Installed resolver with an exclusive provider identity.
 * @returns Disposer that drains resolutions before removing the provider.
 */
register(provider: T.OpeningContextProvider): () => Promise<void>

/** Open through the existing admission path with a frozen provider reference.
 * @param request - Explicit revision and task associations.
 * @param authority - Authenticated host identity, never wire fields.
 * @returns Existing opening outcomes without bypassing gates or budgets.
 */
open(request: T.OpenSeatWithContextRequest, authority: T.SeatCallContext): Promise<T.OpenSeatResult>

/** Wake an existing window or open through the same trusted context when none exists.
 * @param request - Wake target and revisioned fallback opening reference.
 * @param authority - Authenticated host identity.
 * @returns Original wake outcome without a new opening callback for existing windows.
 */
wake?(request: T.WakeSeatWithContextRequest, authority: T.SeatCallContext): Promise<T.WakeSeatResult>

/** Preflight complete scope evidence before any batch member executes.
 * @param request - Explicit seats and every associated task.
 * @param authority - Authenticated caller.
 * @returns Independent outcomes or a whole-batch preflight refusal.
 */
openBatch(request: T.OpenSeatBatchWithScopeRequest, authority: T.SeatCallContext): Promise<T.OpenSeatBatchResult>
```

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatprofiles--seatprofiles"></a>

### `ctx.seatProfiles` — `SeatProfiles`

Remote profile operations do not accept authority from their request bodies.

```ts cordis-catalog
/** Read the catalog, actual opening history and deletion impact.
 * @param signal - Resource or caller cancellation.
 * @returns Complete local observations or an explicit failure.
 */
@Remote async read(signal?: AbortSignal): Promise<SeatProfileSnapshot>

/** Transfer source-owned editing only after explicit owner confirmation.
 * @param request - Observed revision and affirmative confirmation.
 * @returns Existing audited authority mutation receipt or refusal.
 */
@Remote takeover(request: { expectedRevision: number; operationId: T.SeatOperationId; confirmed: true }): Promise<T.SeatCatalogMutationResult>

/** Save an edited definition without overwriting a changed catalog.
 * @param request - Observed catalog revision and next definition revision.
 * @returns Existing catalog mutation receipt or refusal.
 */
@Remote save(request: { definitionJson: string expectedRevision: number operationId: T.SeatOperationId }): Promise<T.SeatCatalogMutationResult>

/** Delete only after the owner confirms observed windows and approvals.
 * @param request - Confirmed impact and catalog CAS revision.
 * @returns Catalog mutation receipt; windows and approvals are retained.
 */
@Remote deleteProfile(request: RemoveSeatProfileRequest): Promise<T.SeatCatalogMutationResult>

/** Preview a generic mapped Markdown or CSV table without changing the catalog.
 * @param request - Existing source, mapping and explicit defaults.
 * @returns Original row diagnostics and selectable actions.
 */
@Remote preview(request: T.PreviewSeatImportRequest): Promise<T.SeatImportPlan | T.SeatRejected>

/** Commit only selected rows of a current preview.
 * @param request - Stable preview identity, selections and observed revision.
 * @returns Existing import receipt or refusal.
 */
@Remote commit(request: T.CommitSeatImportRequest): Promise<T.CommitSeatImportResult>
```

Source: [`packages/client/ui-seat-profiles/src/index.ts`](../../packages/client/ui-seat-profiles/src/index.ts)

<a id="ctxseatprofileslocal--seatprofileaccess"></a>

### `ctx.seatProfilesLocal` — `SeatProfileAccess`

Local catalog editing and import capabilities.

```ts cordis-catalog
/** Read catalog definitions and complete deletion impact.
 * @returns The current catalog and versioned window and approval observations.
 */
read(): Promise<SeatProfileSnapshot>

/** Transfer source-owned editing authority after confirmation.
 * @param request - Observed catalog revision and replay identity.
 * @returns The saved revision or a structured refusal.
 */
takeover(request: { expectedRevision: number; operationId: T.SeatOperationId; confirmed: true }): Promise<T.SeatCatalogMutationResult>

/** Remove a confirmed definition while retaining its windows and approvals.
 * @param request - Catalog CAS and confirmed versioned impact.
 * @returns The saved revision or a structured refusal.
 */
remove(request: RemoveSeatProfileRequest): Promise<T.SeatCatalogMutationResult>

/** Save a complete definition under catalog CAS.
 * @param request - Definition, observed revision and replay identity.
 * @returns The saved revision or a structured refusal.
 */
save(request: { definition: unknown; expectedRevision: number; operationId: T.SeatOperationId }): Promise<T.SeatCatalogMutationResult>

/** Preview mapped source rows without importing them.
 * @param request - Source path, format, mapping and explicit defaults.
 * @returns A durable import plan or a structured refusal.
 */
preview(request: T.PreviewSeatImportRequest): Promise<T.SeatImportPlan | T.SeatRejected>

/** Commit explicitly selected rows from an existing plan.
 * @param request - Plan identity, selected rows, catalog CAS and replay identity.
 * @returns The import receipt or a structured refusal.
 */
commit(request: T.CommitSeatImportRequest): Promise<T.CommitSeatImportResult>
```

Source: [`packages/seat/seat-local/src/profile-access.ts`](../../packages/seat/seat-local/src/profile-access.ts)

<a id="ctxseatreminderhost--seatreminderhost"></a>

### `ctx.seatReminderHost` — `SeatReminderHost`

Message delivery owns durable idempotency and maps steer to the existing next-step lane.

```ts cordis-catalog
/** Submit an idempotent reminder to the existing next-step lane.
 * @param request - Target Session, stable delivery identity and reminder content.
 * @returns Durable acceptance or refusal without claiming model completion.
 */
send(request: { sessionId: SessionId; id: string; kind: 'steer'; content: string }): Promise<'accepted' | 'rejected'>
```

Types: [SessionId](core.zh.md)

Source: [`packages/seat/seat/src/gates.ts`](../../packages/seat/seat/src/gates.ts)

<a id="ctxseatremote--seatremote"></a>

### `ctx.seatRemote` — `SeatRemote`

Host owner of the seats namespace; absent providers never activate a replacement runtime.

```ts cordis-catalog
/** Preview source rows without mutating the catalog.
 * @param request - source, mapping and defaults.
 * @returns revision-bound row comparisons.
 */
@Remote('import.preview') async previewImport(request: SeatRequestMap['seats/import.preview']['params']): Promise<SeatRequestMap['seats/import.preview']['result']>

/** Commit selected rows against the original preview revision.
 * @param request - preview identity and row selection.
 * @returns committed revision and row outcomes.
 */
@Remote('import.commit') async commitImport(request: SeatRequestMap['seats/import.commit']['params']): Promise<SeatRequestMap['seats/import.commit']['result']>

/** Transfer editing authority only with independent authorization.
 * @param request - observed revision and authorization reference.
 * @returns committed revision or refusal.
 */
@Remote async setAuthority(request: SeatRequestMap['seats/setAuthority']['params']): Promise<SeatRequestMap['seats/setAuthority']['result']>

/** Record all report fields without asserting runtime idleness.
 * @param request - report and stable operation identity.
 * @returns committed report version.
 */
@Remote('report.submit') async submitReport(request: SeatRequestMap['seats/report.submit']['params']): Promise<SeatRequestMap['seats/report.submit']['result']>

/** Register observations without blocking on task completion.
 * @param request - explicit objects and registration identity.
 * @returns committed wait state.
 */
@Remote('wait.register') async registerWait(request: SeatRequestMap['seats/wait.register']['params']): Promise<SeatRequestMap['seats/wait.register']['result']>

/** Cancel observation without cancelling underlying tasks.
 * @param request - wait identity and observed version.
 * @returns committed wait state.
 */
@Remote('wait.cancel') async cancelWait(request: SeatRequestMap['seats/wait.cancel']['params']): Promise<SeatRequestMap['seats/wait.cancel']['result']>

/** List owner-authorized runtime evidence.
 * @param request - local filters.
 * @returns window page including unopened seats.
 */
@Remote async list(request: SeatRequestMap['seats/list']['params']): Promise<SeatRequestMap['seats/list']['result']>

/** Open through the shared provider, forcing remote automatic opening.
 * @param request - seat and retained operation identity.
 * @returns provider result without waiting for the first model response.
 */
@Remote async open(request: SeatRequestMap['seats/open']['params']): Promise<SeatRequestMap['seats/open']['result']>

/** Open an explicit bounded list without wildcard expansion.
 * @param request - names and operation identity.
 * @returns independent provider outcomes.
 */
@Remote async openBatch(request: SeatRequestMap['seats/openBatch']['params']): Promise<SeatRequestMap['seats/openBatch']['result']>

/** Renew once without conversation text.
 * @param request - local session and stable operation.
 * @returns maintenance evidence.
 */
@Remote async renew(request: SeatRequestMap['seats/renew']['params']): Promise<SeatRequestMap['seats/renew']['result']>

/** Close only at the observed idle version.
 * @param request - local session and version.
 * @returns closed or busy evidence.
 */
@Remote async close(request: SeatRequestMap['seats/close']['params']): Promise<SeatRequestMap['seats/close']['result']>

/** Start a recoverable replacement without closing old first.
 * @param request - old session and stable operation.
 * @returns replacement progress.
 */
@Remote async replace(request: SeatRequestMap['seats/replace']['params']): Promise<SeatRequestMap['seats/replace']['result']>

/** Preserve upstream user-title pinning.
 * @param request - explicit title and local session.
 * @returns committed title.
 */
@Remote async rename(request: SeatRequestMap['seats/rename']['params']): Promise<SeatRequestMap['seats/rename']['result']>

/** Deliver the stored wake text or open an unopened seat.
 * @param request - explicit seat and optional session.
 * @returns delivery or open outcome.
 */
@Remote async wake(request: SeatRequestMap['seats/wake']['params']): Promise<SeatRequestMap['seats/wake']['result']>

/** Read metadata outside the Session log.
 * @param request - local session.
 * @returns binding or absent metadata.
 */
@Remote async binding(request: SeatRequestMap['seats/binding']['params']): Promise<SeatRequestMap['seats/binding']['result']>

/** Observe a pending operation without retrying effects.
 * @param request - operation identity.
 * @returns durable operation state.
 */
@Remote async operation(request: SeatRequestMap['seats/operation']['params']): Promise<SeatRequestMap['seats/operation']['result']>

/** Select project policy with revision comparison.
 * @param request - project, mode and observed revision.
 * @returns the durably committed policy.
 */
@Remote async setProjectMode(request: SeatRequestMap['seats/setProjectMode']['params']): Promise<SeatRequestMap['seats/setProjectMode']['result']>

/** Read pending work without admitting it.
 * @param request - page size and filters.
 * @returns a committed queue page.
 */
@Remote async pending(request: SeatRequestMap['seats/pending']['params']): Promise<SeatRequestMap['seats/pending']['result']>

/** Approve pending work without bypassing admission.
 * @param request - queue item and observed version.
 * @returns the committed approval result.
 */
@Remote async approve(request: SeatRequestMap['seats/approve']['params']): Promise<SeatRequestMap['seats/approve']['result']>

/** Cancel pending work without closing a window.
 * @param request - queue item and observed version.
 * @returns the committed cancellation result.
 */
@Remote async cancel(request: SeatRequestMap['seats/cancel']['params']): Promise<SeatRequestMap['seats/cancel']['result']>

/** Read committed gate state.
 * @param request - gate filters and cursor.
 * @returns a gate state page.
 */
@Remote async gates(request: SeatRequestMap['seats/gates']['params']): Promise<SeatRequestMap['seats/gates']['result']>

/** Read local node state without activating providers.
 * @param request - empty parameter object.
 * @returns the node alias and capacity.
 */
@Remote async nodeStatus(request: SeatRequestMap['seats/nodeStatus']['params']): Promise<SeatRequestMap['seats/nodeStatus']['result']>
```

Source: [`packages/seat/seat-remote/src/index.ts`](../../packages/seat/seat-remote/src/index.ts)

<a id="ctxseats--seatservice-abstract-seam"></a>

### `ctx.seats` — `SeatService` (abstract seam)

Unified node-local operations; provider derives authority from authenticated context, never wire tags.

```ts cordis-catalog
/** Derive an operation-local facade from verified server-side authority, never raw request fields.
 * @param authority - principal, node and origin already authenticated by the trusted adapter.
 * @returns a scoped facade with no process-global current identity.
 */
abstract withAuthority(authority: T.SeatCallContext): SeatService

/** Report local placement even when the optional engine is absent.
 * @returns node identity and available engine evidence.
 */
nodeStatus?(): Promise<T.SeatNodeStatus>

/** List authorized definitions without activating Sessions.
 * @param request - local catalog filters and pagination.
 * @returns revisioned catalog page.
 */
abstract definitions(request: T.ListSeatDefinitionsRequest): Promise<T.ListSeatDefinitionsResult>

/** Resolve and freeze all defaults before an operation can produce side effects.
 * @param seat - exact local definition key.
 * @returns validated definition or an actionable rejection.
 */
abstract resolve(seat: T.SeatName): Promise<T.SeatDefinition | T.SeatRejected>

/** Edit only when the catalog is authoritative.
 * @param request - replacement definition and expected revision.
 * @returns committed revision or a conflict.
 */
abstract save(request: T.SaveSeatDefinitionRequest): Promise<T.SeatCatalogMutationResult>

/** Compare source, baseline and local fields without mutating the catalog.
 * @param request - selected source table, mapping and explicit defaults.
 * @returns per-row preview or a source failure.
 */
abstract previewImport(request: T.PreviewSeatImportRequest): Promise<T.SeatImportPlan | T.SeatRejected>

/** Recheck source bytes and revision before applying selected rows.
 * @param request - original preview identity and explicit row selection.
 * @returns committed rows and retained conflicts.
 */
abstract commitImport(request: T.CommitSeatImportRequest): Promise<T.CommitSeatImportResult>

/** Change the sole editing authority only with external authorization.
 * @param request - authorized compare-and-swap request.
 * @returns committed catalog revision.
 */
abstract setAuthority(request: T.SetSeatAuthorityRequest): Promise<T.SeatCatalogMutationResult>

/** List runtime-derived states, including unavailable evidence.
 * @param request - authorized local filters and cursor.
 * @returns windows and unopened definitions with completeness.
 */
abstract list(request: T.ListSeatWindowsRequest): Promise<T.ListSeatWindowsResult>

/** Read committed local open bindings without activating Sessions or mutating engine admission.
 * @returns complete local bindings; omission means the provider lacks this read capability.
 */
messageWindows?(): Promise<readonly SeatMessageWindow[]>

/** Create through one durable intent; bind ledger identity before the first run starts.
 * @param request - caller-stable identity and exact definition.
 * @returns created, prefilled, pending, choice or rejected outcome.
 */
abstract open(request: T.OpenSeatRequest): Promise<T.OpenSeatResult>

/** Consume an authenticated frozen request locally without resolving its source again.
 * @param request - Complete frozen input bound to this facade's live authority.
 * @returns Original opening outcomes; absence denies the negotiated method.
 */
openFrozen?(request: T.OpenFrozenSeatRequest): Promise<T.OpenFrozenSeatResult>

/** Wake locally, consuming the frozen fallback only when no eligible window exists.
 * @param request - Original wake identity and frozen fallback.
 * @returns Original wake outcomes without another routing hop.
 */
wakeFrozen?(request: T.WakeFrozenSeatRequest): Promise<T.WakeFrozenSeatResult>

/** Validate the entire explicit name list before opening any window.
 * @param request - bounded names without wildcard expansion.
 * @returns independent per-seat outcomes.
 */
abstract openBatch(request: T.OpenSeatBatchRequest): Promise<T.OpenSeatBatchResult>

/** Perform one cache maintenance request without adding conversation text.
 * @param request - retained operation identity and local Session.
 * @returns renewed, rejected or uncertain with cache evidence.
 */
abstract renew(request: T.RenewSeatRequest): Promise<T.RenewSeatResult>

/** Close only after an admission barrier and a second complete idle check.
 * @param request - observed state version and operation identity.
 * @returns closed, busy or conflicting state without force-stopping work.
 */
abstract close(request: T.CloseSeatRequest): Promise<T.CloseSeatResult>

/** Open new before closing old; queue until both windows fit all capacity limits.
 * @param request - old Session and replacement operation identity.
 * @returns durable replacement phase, including failed-new cleanup.
 */
abstract replace(request: T.ReplaceSeatRequest): Promise<T.ReplaceSeatResult>

/** Preserve upstream user-title pinning.
 * @param request - title and retained operation identity.
 * @returns the committed upstream title snapshot.
 */
abstract rename(request: T.RenameSeatRequest): Promise<T.RenameSeatResult>

/** Send the definition's wake text or delegate an unopened seat to open.
 * @param request - explicit target when multiple windows exist.
 * @returns mail acknowledgement, open result or candidate choices.
 */
abstract wake(request: T.WakeSeatRequest): Promise<T.WakeSeatResult>

/** Inspect metadata held outside the Session log.
 * @param request - local Session identity.
 * @returns binding, null for absent metadata, or a node refusal.
 */
abstract binding(request: T.SeatBindingRequest): Promise<T.SeatBinding | null | T.SeatRejected>

/** Resolve traditional creation before any Session or directory side effect.
 * @param request - canonical path and optional single-use confirmation.
 * @returns free admission, seat admission or candidate choices.
 */
abstract resolveDirectoryChoice(request: T.ResolveDirectoryChoiceRequest): Promise<T.DirectoryChoiceResult>

/** Record three report fields without treating model claims as runtime state.
 * @param request - bounded report and optional trusted tool attribution.
 * @returns committed report revision.
 */
abstract submitReport(request: T.SubmitCloseReportRequest): Promise<T.CloseReportResult>

/** Invalidate an older automatic-close candidate atomically.
 * @param request - report identity and expected state version.
 * @returns committed revocation or conflict.
 */
abstract revokeReport(request: T.RevokeCloseReportRequest): Promise<T.CloseReportResult>

/** Register observations without awaiting task completion; tools then conclude the turn.
 * @param request - authorized objects, stable wait and operation identities.
 * @returns durable registration, including already-visible terminal observations.
 */
abstract registerWait(request: T.RegisterSeatWaitRequest): Promise<T.RegisterSeatWaitResult>

/** Cancel only observation, never the underlying tasks.
 * @param request - expected wait state and operation identity.
 * @returns cancelled or already settled wait.
 */
abstract cancelWait(request: T.CancelSeatWaitRequest): Promise<T.CancelSeatWaitResult>

/** Observe a wait without causing a second wake.
 * @param waitId - retained registration identity.
 * @returns committed state or null if absent.
 */
abstract wait(waitId: T.WaitId): Promise<T.SeatWait | null>

/** Observe replacement or opening recovery without resubmitting side effects.
 * @param request - caller-retained operation identity.
 * @returns missing, pending or settled state.
 */
abstract operation(request: T.SeatOperationQuery): Promise<T.SeatOperationResult>

/** Read current-context estimates rather than accumulated ledger tokens.
 * @param sessionId - authorized local Session.
 * @returns dated evidence or explicit unknown state.
 */
abstract contextUsage(sessionId: SessionId): Promise<T.SeatContextUsage>
```

Types: [SessionId](core.zh.md)

Source: [`packages/seat/seat/src/index.ts`](../../packages/seat/seat/src/index.ts)

<a id="ctxseatworktreehost--seatworktreehost"></a>

### `ctx.seatWorktreeHost` — `SeatWorktreeHost`

Durable worktree owner supplies authoritative records and authorization to policy.

```ts cordis-catalog
/** Read one complete revision; partial catalogs must reject.
 * @returns The complete catalog and its comparison revision.
 */
read(): Promise<{ revision: number; trees: readonly import('./types.ts').SeatWorktreeRegistration[] }>

/** Atomically persist registration plus force audit before acknowledging success.
 * @param request - Registration and independent force authorization reference.
 * @param expectedRevision - Catalog revision observed by the caller.
 * @returns Committed registration or a revision conflict without mutation.
 */
commit(request: import('./types.ts').RegisterSeatWorktreeRequest, expectedRevision: number): Promise<'committed' | 'conflict'>

/** Resolve repository identity and read-only Git evidence, including recorded activity.
 * @param tree - Registered worktree to inspect without changing its contents.
 * @returns Verified identity, merge and tracked-file state, and last activity time.
 */
inspect(tree: import('./types.ts').SeatWorktreeRegistration): Promise<{ verified: boolean merged: boolean trackedClean: boolean lastChangedAt: number | null }>

/** Validate the authorization reference against the caller, never model prose.
 * @param request - Registration containing the caller authorization reference.
 * @returns Whether independent authorization permits the request.
 */
authorize(request: import('./types.ts').RegisterSeatWorktreeRequest): Promise<boolean>
```

Source: [`packages/seat/seat/src/gates.ts`](../../packages/seat/seat/src/gates.ts)

<a id="seat-events"></a>

### `seat/*` events

<a id="seatdecision--parallel"></a>

#### `seat/decision` — parallel

Published only after a decision is durable; observer failure cannot undo the commit.

```ts cordis-catalog
/** Published only after a decision is durable; observer failure cannot undo the commit.
 * @mode parallel
 * @param decision - committed frame and its complete effects.
 */
'seat/decision'(decision: EngineDecision): void
```

Source: [`packages/seat/seat/src/events.ts`](../../packages/seat/seat/src/events.ts)

<a id="seatdiagnostics-changed--emit"></a>

#### `seat/diagnostics-changed` — emit

Invalidates owner diagnostics after runtime supervision changes; carries no private data.

```ts cordis-catalog
/** Invalidates owner diagnostics after runtime supervision changes; carries no private data.
 * @mode emit
 */
'seat/diagnostics-changed'(): void
```

Source: [`packages/seat/seat/src/events.ts`](../../packages/seat/seat/src/events.ts)

<a id="seatready--parallel"></a>

#### `seat/ready` — parallel

Runtime readiness starts the host-recovery resource-release timing interval.

```ts cordis-catalog
/** Runtime readiness starts the host-recovery resource-release timing interval.
 * @mode parallel
 * @param status - local node state, including the ready timestamp.
 */
'seat/ready'(status: import('./types.ts').SeatNodeStatus): void
```

Source: [`packages/seat/seat/src/events.ts`](../../packages/seat/seat/src/events.ts)
<!-- END GENERATED cordis-surface -->
