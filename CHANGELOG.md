# Changelog

## Unreleased

Adopts `@openbox-ai/openbox-sdk-ts` 2.1.0 (v3 workload identity) and aligns the event sequence with the other OpenBox SDKs.

### Added

- v3 Keycloak workload identity: `workloadPrivateKey` and `identityMethod` in the config input (also read from `OPENBOX_COPILOTKIT_*` / `OPENBOX_*` env vars), alongside the v2 Okta and v1 DID identities.
- OpenRouter provenance: every OpenRouter model call in a governed run is reported as an `llm_call` activity with HTTP spans and an `llm_provenance` span (generation id, upstream provider, model, tokens, cost) from OpenRouter's generation record. On by default; set `OPENBOX_OPENROUTER_PROVENANCE=false` to turn it off.
- `InterruptPersistencePort.hasPending?` (implemented by `InMemoryInterruptStore`).
- `telemetry` option on `createOpenBoxCopilotKit`.

### Changed

- Requires `@openbox-ai/openbox-sdk-ts` >= 2.1.0 < 3.0.0.
- One `SignalReceived` per run (`user_prompt`, the user's text); the after-request `assistant_message` signal is gone.
- `WorkflowStarted`/`WorkflowCompleted`/`WorkflowFailed` use `<run>-wf` activity ids with the agent as activity type, so the dashboard tree shows the agent name and the `user_prompt` row.
- `WorkflowCompleted` carries the answer as `activity_output.result`; failed runs close with `WorkflowFailed` and a duration.
- `withRuntime` shares the bundle's controller instead of building a second one.
- Default telemetry `flushTimeoutMs` is 30 s, so a run's closing events are not dropped on shutdown.

### Fixed

- Approval decisions are accepted only for the approval the run is waiting on (guards against Core returning an older approval's decision for the same activity).
- A tool call refused by the enforcing gate now closes its run.
- Events sent directly (gate, `serverTool`, handoff) wait for the run's queued events, so Core receives them in order.
- An interrupted run is closed with `WorkflowCompleted` once its last interrupt is resolved.
- An oversized hook `spans` field is trimmed in place instead of being replaced by a truncation marker (Core rejected the marker with 400).

## 0.4.0 — 2026-07-17

Full migration onto `@openbox-ai/openbox-sdk-ts` as the base runtime. See [`MIGRATION.md`](./MIGRATION.md) for the complete adopter-facing writeup; summary below.

### Breaking

- Removed the package-root `src/verdict/*` exports (`applyVerdict`, `mapVerdict`, `OpenBoxVerdictSchema`, `OpenBoxConstraintSchema`, `OpenBoxReplacementSchema`, `VerdictMappingError`, `VerdictNotImplementedError`, and the related `OpenBoxVerdict`/`OpenBoxConstraint`/`OpenBoxReplacement`/`Applier*` types). Never wired into real enforcement; `applyVerdict` unconditionally threw for every verdict but `allow`/`block`. The base SDK's `Verdict`/`EvaluationResult` are canonical now.

### Added

- `createOpenBoxCopilotKit(options)` bundle + `bundle.serverTool(tool)` — wraps a server-side tool so a non-allow governance verdict (BLOCK/HALT/rejected-or-expired-or-timed-out approval/CONSTRAIN) prevents `execute` from ever running; an approved call executes exactly once. The one supported pre-execution enforcement seam in this SDK.
- Real `REQUIRE_APPROVAL` waiting: `enforce`-mode evaluation now awaits the base `ApprovalPoller` (`waitForDecision`) instead of passing the verdict through unresolved.
- Explicit `CopilotKitUnsupportedVerdictError` for CONSTRAIN (and any future non-actionable verdict) at the enforcing boundaries (frontend gate, `serverTool()`) — raised before delivery/execution, never a silent allow.
- Truthful interrupt/resume semantics: an interrupt emits `copilotkit_interrupt` and stays pending (no fabricated completion); resume correlates on the interrupt's own `id`; resume-with-no-pending-interrupt is a typed failure. New injectable `InterruptPersistencePort` (bundled `InMemoryInterruptStore` is explicitly non-durable).
- Non-blocking, bounded telemetry queue — AG-UI events forward without awaiting Core even in telemetry-only mode (previously serial `await client.evaluate()` per event throttled the stream to Core latency).
- Opt-in base instrumentation (`middlewareOptions.instrumentation`, off by default) and opt-in startup API-key validation (`validateApiKeyAtStartup`, default `false` — no new default network call).
- New `telemetry.*` bounded-queue config options (`maxPendingEvents`, `maxConcurrentSends`, `flushTimeoutMs`, `overflowPolicy`, `maxPayloadBytes`).
- `scripts/check-no-duplicate-signing.mjs` — CI guard against a second Core-endpoint/signing implementation appearing in production `src/` outside the base-delegating facades. Wired into `ci:check`.

### Changed

- `middlewareOptions.enforceApprovals` (boolean) is deprecated in favor of `middlewareOptions.enforcement` (`OpenBoxEnforcementOptions`); it still works but now maps to frontend-tool-gate enforcement only, plus a one-time warning that server tools are not covered by it. It was never universal server-tool enforcement, in this release or before.
- `RUN_FINISHED.outcome` is modeled explicitly; an interrupt outcome no longer emits a successful `ActivityCompleted`/`WorkflowCompleted`.
- Multi-agent handoff now goes through the base `handoff()` factory (two-field payload; Core derives the receiver from child-signed headers). The default session-id prefix stays `mas:${runId}` (unchanged from `0.3.0`) so the CopilotKit parent and the OpenBox Mastra child, which derive the id from the same forwarded run id, land in one multi-agent session. Wire `source` on the handoff is now the base default (`"workflow-telemetry"`) — every other event type still stamps its own `source`.
- `./client`, `./config`, `./identity`, `./types` subpaths are now thin, base-delegating shims (documented deprecated, removed at `1.0.0`).
- Every `OpenBoxConfigInput` field ever accepted keeps working; deprecated fields now warn once per field name, per process, pointing at their base-SDK replacement (see `MIGRATION.md`'s alias table).

### Fixed

- **B1** — a server tool call could no longer be assumed blocked just because the AG-UI event was blocked; `serverTool()` closes this gap for wrapped tools, and docs now state the observation-only boundary explicitly for unwrapped/MCP/external calls.
- **B2** — `REQUIRE_APPROVAL` now actually waits for a decision instead of passing through.
- **B3** — an interrupted run no longer reports a successful activity/workflow completion.
- **B4** — telemetry-only mode no longer serially blocks the AG-UI stream on Core latency.

### Documentation

- `MIGRATION.md`, `README.md`, and `docs/*.md` updated to remove the implication that blocking an AG-UI event universally prevents a server-side side effect; document the three enforcement boundaries (wrapped server tool / frontend delivery gate / observation-only); state CONSTRAIN is unsupported in `0.4.0`.

### Notes

- `@openbox-ai/openbox-sdk-ts` is consumed from npm, exact-pinned at `1.0.1` (no caret — the base SDK now owns all signing/auth/verdict logic, so it is deliberately pinned rather than range-matched). The `npm publish` of this package itself remains the maintainer-owned next step (see `MIGRATION.md`'s release checklist).

## 0.3.0 — 2026-06-30

### Added — verdict surface (Phase 1)

- `OpenBoxVerdict` 5-case discriminated union (`allow` / `constrain` / `require_approval` / `block` / `halt`) under `src/verdict/`. Companion zod schema `OpenBoxVerdictSchema`.
- `mapVerdict(response, options?)` — single translation point from `GovernanceVerdictResponse` to `OpenBoxVerdict`. Permissive on missing optional fields, strict on shape mismatch (throws `VerdictMappingError`). `strictMode` opt-in turns unknown actions into errors instead of safe-block fallback.
- `applyVerdict(verdict, ctx)` — single enforcement point. `allow` and `block` are wired; `constrain`, `require_approval`, and `halt` audit then throw `VerdictNotImplementedError` (later ship gates: 0.4.0 / 0.5.0).
- Public types `ApplierContext`, `ApplierEvent`, `ApplierGateway`, `ApplierSubject`, `ApplierResult`, `OpenBoxConstraint`, `OpenBoxReplacement`, `OpenBoxHaltVerdict`, `OpenBoxRequireApprovalVerdict`.
- Test matrix: 18 wire-shape fixtures under `test/fixtures/governance-verdict-responses/` cover the (action × field-permutation) grid.

### Added — span foundation (Phase 2)

- `SpanBuffer` — bounded, per-workflow in-memory buffer (`Map<workflowId, SpanData[]>`) with FIFO overflow eviction + TTL eviction. Configurable via constructor opts or env (`OPENBOX_SPAN_BUFFER_MAX_PER_WORKFLOW`, default 1000; `OPENBOX_SPAN_BUFFER_TTL_MS`, default 300000). Plain TS — not an OTel `SpanProcessor`; the drop-OTel posture is preserved.
- `synthesizeToolSpan(triple, opts?)` — pure synthesizer that converts AG-UI `TOOL_CALL_*` event triples into `SpanData` with `openbox.semantic_type:"function_call"`, `tool.name`, `tool.args_hash`, redacted `tool.args_preview` (<= 256 bytes), `tool.result_hash`, `tool.duration_ms`. Optional `redactPaths` (leaf-key `$..key` and dotted `$.a.b.key` shapes) protect args/result previews.
- `attachAuditEnvelope(span, envelope)` — mutates a span in place to add the locked audit-envelope attribute set (`openbox.enforcement_owner`, `openbox.gateway`, `openbox.enforcement_status`, `openbox.idempotency_key`, `openbox.policy_version`, `openbox.trace_id`).
- `idempotencyKey({workflowId, runId, activityId, attempt})` — sha256(workflowId:runId:activityId:attempt). Cross-impl parity with `@openbox-ai/openbox-mastra-sdk` and Core's `setApprovalCache` fingerprint, validated by a golden test.
- AG-UI middleware now accepts `spanBuffer?: SpanBuffer` and `redactPaths?: string[]`. When `spanBuffer` is provided, the middleware synthesizes one `function_call` span per tool call at activity-completed time and appends it to the buffer. When absent, no spans are produced (no behavior change at the AG-UI middleware boundary).
- New env knob `OPENBOX_DISABLE_SPAN_BUFFER=1` skips synthesis entirely (emergency bypass).
- Test fixtures: 4 recorded AG-UI streams under `test/fixtures/agui-streams/` (single tool call, parallel tool calls, streamed args, end-without-result).

### Added — span sibling-event transport

- `function_call` spans now ship to openbox-core when a `spanBuffer` is wired (previously buffered locally only). The middleware synthesizes the span at activity-complete time, emits the original `ActivityCompleted` unchanged, then emits a sibling `ActivityStarted`-shaped hook event (`hook_trigger: true`, `hook_stage: "completed"`, `activity_type: "function_call"`) carrying the span. The same `activity_id` ties the two events together at the openbox-core session UI. This mirrors `openbox-mastra-sdk`'s HTTP/DB hook transport — openbox-core's `ActivityCompleted` schema rejects inline `spans` fields (400 invalid request body), so the hook-event side channel is the validated path.
- New emitter method `emitActivityCompletedHook(input: ActivityCompletedHookInput)` carries the sibling event. The wire shape mirrors `openbox-core/internal/content/governance.go:SpanData` (validated empirically + cross-checked against `openbox-mastra-sdk`'s `createHookSpan`): top-level `semantic_type`, `hook_type`, `kind`, `events: []`, `start_time` / `end_time` as JSON numbers (NOT strings — Go unmarshals into `int64`), `status: { code: "OK"|"ERROR" }` struct, `stage: "completed"`. The internal `SpanData` export (used by `SpanBuffer` consumers) keeps the OTel-style `start_time_unix_nano` (bigint) shape — wire transformation is scoped to the emit boundary via the private `toWireSpan` helper.
- Span nano-time fields (`start_time_unix_nano` / `end_time_unix_nano` / `events[].time_unix_nano`) are coerced to OTel-JSON decimal strings at the wire boundary so the payload is JSON-serializable. The buffer keeps the raw `bigint` shape.
- When `spanBuffer` is absent or `OPENBOX_DISABLE_SPAN_BUFFER=1`, the sibling hook event is suppressed — wire output is byte-identical to the pre-transport buffer-only path. Synthesis errors are swallowed and logged; the original `ActivityCompleted` still ships and no sibling event is emitted.

### Documentation

- Reworked the public README and added project docs.

### Tooling

- Added tag-based npm publish workflow.

### Notes

- Additive only — the existing `Verdict` string-enum, `GovernanceVerdictResponse` class, and AG-UI emitter fanout stay unchanged. No call sites in middleware or emitter are altered by this slice; the applier is exercised by tests + the example demo wiring (Phase 3).
- LLM completion spans remain out of scope for this SDK. `@openbox-ai/openbox-mastra-sdk` owns the `llm_completion` seam; this SDK does not import from `ai` and has no `LanguageModelV1` wrap.

## 0.2.0-beta.0 — 2026-06-29

### Breaking

- Removed `setupOpenBoxOpenTelemetry` public export. OpenTelemetry install is no longer part of the SDK.
- Removed `OpenBoxSpanProcessor` public export. Workflow events flow exclusively via `client.evaluate(payload)`.
- Removed `OpenBoxTelemetryController` type.
- Removed `WorkflowSpanBuffer` type.
- Removed `governance/activity-runtime.ts` — orphan module (zero production callers in `src/`) deleted (Validation Session 1 Option B).
- `OpenBoxRuntimeController.spanProcessor` field removed; controller shape is now `{ client, defaults, logger }`.
- `withOpenBoxRuntime(...).shutdown` is now a hard-coded idempotent `Promise.resolve()` (was: OTel teardown). `OpenBoxClient` has no `shutdown` method; the closure is reserved for future client-side cleanup. Safe to leave SIGINT handlers in place.
- Removed 19 `@opentelemetry/*` runtime dependencies.
- Removed `./otel` and `./span` package subpath exports.
- Removed `opentelemetry` from `package.json` keywords.

### Added

- `scripts/check-no-otel.mjs` — CI guard that fails the build if any `@opentelemetry/*` import re-enters the target source directories (`src/config`, `src/client`, `src/identity`, `src/governance`, `src/types`). Wired into `ci:check` and `prepublishOnly`.
- `test/unit/no-otel-import.test.ts` — regression test asserting the built `dist/` is free of `@opentelemetry/*` import strings.
- `test/integration/evaluate-snapshot-baseline.test.ts` — deterministic AG-UI event sequence captured against a recording `OpenBoxClient`; asserts the `evaluate()` payload sequence stays byte-identical to the committed snapshot under `plans/260629-0501-drop-otel-from-openbox-copilotkit-sdk/snapshots/`. This is the lossless-drop proof, codified.

### Why

The OpenTelemetry install was inherited from a sibling SDK during initial scaffolding but never load-bearing in this SDK. Buffered spans were never flushed; no UI consumer depended on them. The peer-coexistence machinery existed only because OTel was inherited, not because the value justified the cost. See `plans/260629-0501-drop-otel-from-openbox-copilotkit-sdk/` for the full audit and rationale.

### Migration

- If your code imported `setupOpenBoxOpenTelemetry` or `OpenBoxSpanProcessor`: remove the imports. Workflow event emission is automatic via the AG-UI middleware.
- If your code installed OpenTelemetry independently (separate from this SDK): no change. You now own the global TracerProvider without contention from this SDK.
- If your `next.config.ts` `serverExternalPackages` listed `@opentelemetry/api` only because of this SDK: you can remove it.
- If your code relied on `withOpenBoxRuntime(...).shutdown()` to flush OTel spans: the call becomes a no-op resolved promise. Safe to remove or leave in place; the SIGINT pattern continues to work.

## 0.1.0-beta.0 — 2026-06-29 (initial)

- First release. See `plans/260628-2219-openbox-copilotkit-sdk/`.
