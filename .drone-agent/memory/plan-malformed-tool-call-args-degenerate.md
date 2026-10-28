---
key: plan-malformed-tool-call-args-degenerate
tags:
  - plan
  - llm
  - guardrail
  - tool-calling
  - openrouter
  - schema-honesty
created: 2026-10-28T01:51:13.474Z
updated: 2026-10-28T01:51:13.474Z
---

# Plan: Malformed tool-call arguments = degenerate response + schema-honesty sweep

Branch: fix/tool-call-args-parse-swallow (cut from main, 2026-10-28). Language: ASD-STE100.

## Context
Operator incident (2026-10-28): OpenRouter deepseek-v4.1-flash returned tool calls with VALID JSON but MISSING properties — memory.manage store arrived {action,key} sans value; notepad.manage sans content/diff. The model's reasoning narrated sending them. Same failure shape recurred across this session family: ~25 consecutive notepad__manage failures then 8 memory__manage store failures, every one missing the payload-carrying field, correlated with LARGE payloads (a 219-line plan value). See swarm wiki page drone-agent-planning-session-process-lessons (lessons 3-4). Required fields (action/key) were always present; only optional fields vanished — consistent with either (a) args-stream truncation + brace repair into valid JSON, or (b) schema-vs-prose confusion: action-parameter tools (ADR 071) state per-action requiredness in PROSE only (memory required:['action','key']; notepad required:['action']), and a schema-strict model reads value/content/diff as omissible.

Two root causes, two fixes:
1. OURS (latent defect): fromOpenAiResponse (drone-agent/src/shared/openai-compatible.ts ~L157-167) silently converts UNPARSEABLE arguments JSON to {} — hollow calls execute and report success. Fix A: treat a parse failure as a degenerate response (extends ADR 145 broken-response semantics from no-tools-no-text to has-tools-but-unusable-args).
2. THEIRS (live provider bug): valid JSON with missing optional props on large payloads. Step 0 capture decides the upstream report. NOT fixed by this plan.
Fix C complements both: schema-honesty sweep so our schemas stop inviting the confusion.

## Decisions locked (operator-confirmed)
- A: JSON.parse failure OR parsed non-object (null/array/string/number) -> collect tool name into a malformedToolCalls signal -> degenerate tier. Never silently {}.
- Routing principle: degenerate-retry is ONLY for unrecoverable args (unparseable). A missing NAMED optional param stays with per-tool error feedback (the model self-corrected in 1 round in-session when told; degenerate-routing it = 4 retries + abort = regression on a deterministic confuser). The identical-tool-call streak guardrail (hintAfter 2, maxHints 3) already backstops hollow-call loops.
- B (engine-level required-field pre-execution validation + per-action required contract) DEMOTED to a tracked follow-up: inputSchema.required cannot express per-action requiredness, so a plain required check PASSES the incident args {action,key} — blind to the exact incident. Own branch, own grilling, later (this is the ADR 161 completion).
- C: description-only schema-honesty sweep on action-pattern tools (memory, notepad, search, utils, todo per ADR 071). No schema-structure or wire changes. Plus one size-caution clause on the big-payload fields while the provider bug is live.
- Keep notepad `content` and `diff` as SEPARATE schema properties (the operator's in-flight merged-content edit was reverted; its merged wording was ambiguous). Sharpen wording instead of merging.
- Step 0 gates any upstream OpenRouter bug report.
- No console.log debug lines in source (operator's were reverted). Use --debug llm (ADR 082) for captures.

## Steps

### Step 0 (operator): capture decides the upstream report
Reproduce once on deepseek-v4.1-flash with --debug llm. In the [llm:response] debug output read tool_calls[].function.arguments exactly as received (openai-driver.ts ~L292 calls fromOpenAiResponse(data); if the driver does not already log the raw body, temporarily add a console.error there, reproduce, remove). Binary read: complete args incl. value -> model say-do gap; report upstream as model behavior, citing the swarm lessons page. Truncated-then-repaired args -> provider parser bug; report with the raw string as evidence. Record the verdict in project memory (memory__manage edit on this key) BEFORE filing anything.

### Step A1 (coder): drone-core type
drone-core/src/session-types.ts: DroneChatResponse gains optional `malformedToolCalls?: string[]` — names of tool calls whose arguments failed to parse or parsed to a non-object. Then run `pnpm -r run build` BEFORE trusting LSP/typecheck (dependent packages resolve types from dist/).

### Step A2 (coder): adapter
drone-agent/src/shared/openai-compatible.ts, fromOpenAiResponse: inside the tool_calls map — try JSON.parse(tc.function.arguments); on throw OR parsed value null/array/non-object -> parsedArgs = {} AND push tc.function.name into a local malformed-names array. Attach result.malformedToolCalls only when the array is non-empty (absent otherwise — zero change for healthy responses). Additive field; ollama and anthropic drivers are unaffected (they receive arguments as objects natively, no parse step to fail).

### Step A3 (coder): conversation service
drone-agent/src/runtime/conversation-service.ts: add `let malformedToolCallResponseCount = 0` beside the existing per-tier counters (~L242) — OWN counter, per the existing comment that per-tier counters exist so alternating failure patterns cannot conflate limits. In the post-response block (~L1163-1250): if response.malformedToolCalls?.length > 0 -> treat the WHOLE response as broken (assistant text included is discarded with the retry): counter increments; while count <= hintAfter -> notice `Degenerate response (malformed tool-call arguments), retrying (n/2)` + continue; then hint phase -> brokenResponseHintActive = true + notice `Degenerate response (malformed tool-call arguments), retrying with hint (n/2)` + continue; then limit notice + onBrokenResponseLimitReached('malformed tool-call arguments') -> continue-or-abort exactly like the empty tier. Thresholds: reuse resolvedGuardrail.brokenResponses (2/2) — no new config key. Reset the counter in the healthy-response reset block (~L1245) and in resetStuckDetectors (~L124).

### Step A4 (tester, red-first tests)
Adapter tests (extend test/openai.test.ts or new test/openai-compatible.test.ts): (1) invalid-JSON arguments -> parsedArgs {} AND name listed in malformedToolCalls; (2) valid JSON -> malformedToolCalls ABSENT; (3) parsed null / [1,2] / "str" -> malformed; (4) mixed good+bad calls in one response -> only bad names listed. Conversation-service test: scripted provider returning a malformed tool call -> exact notice text, the tool is NOT executed, NOTHING appended to the session, retry count follows brokenResponses 2/2, the abort callback receives the 'malformed tool-call arguments' label after limits.

### Step C (coder): schema-honesty sweep (descriptions ONLY)
Verify each schema by reading it; do not trust this list blindly:
- memory.manage (drone-agent/src/plugins/memory/index.ts): value -> "Text value to store. REQUIRED when action=\"store\"; omit for recall/edit/delete. For very large values, prefer splitting into several stores."; diff -> "Unified diff patch for edit. Provide diff and/or tags when action=\"edit\" (at least one is required)."
- notepad.manage (drone-agent/src/plugins/notepad.ts): content -> "Text content. REQUIRED when action=\"set\" or \"append\"; omit for clear and edit."; diff -> "Unified diff patch. REQUIRED when action=\"edit\" (the @@ hunk header is optional)."
- Survey search (src/plugins/search/index.ts), utils (src/plugins/utils.ts), todo (src/plugins/todo/index.ts): wherever an action enum exists and a property is required-for-some-actions but absent from `required`, state the per-action requiredness explicitly in that property's description.

### Step ADR (coder)
docs/adr/NNN-malformed-tool-call-arguments-degenerate.md — number = next free at merge time (267 or 268; the coordinator-UI duration plan may take 267 first — check docs/adr/ and index.md before writing). Content: the incident shape; the silent-swallow defect; broken-response semantics extension (has-tools-but-unusable-args); own per-tier counter; the routing principle (unrecoverable -> degenerate; named-missing -> tool feedback); the schema-honesty sweep; the B follow-up (ADR 161 completion); upstream-report status per Step 0. Add the index.md row.

### Step V (reviewer): validation

## Validation criteria (all must pass)
1. LSP clean (no errors, no warnings) on: session-types.ts, openai-compatible.ts, conversation-service.ts, every touched plugin file, all new/changed tests.
2. pnpm -r run build: zero errors (run after Step A1 and again at the end).
3. pnpm typecheck: zero errors.
4. pnpm lint: zero errors. Prettier reformats files; re-read each file after lint before further edits.
5. pnpm test passes.
6. Behavior: unparseable args -> retry cycle with the distinct notice, the call never executes; valid args -> malformedToolCalls absent, zero behavior change; new descriptions visible in runtime__list_tools output.

## Explicit non-goals
- No fix for valid-JSON-missing-optional-props (upstream; Step 0 decides the report).
- No engine-level required-field enforcement (B follow-up, own branch later).
- No schema-structure changes (wire risk); descriptions only.
- notepad content and diff remain separate properties.

## Process notes (from swarm wiki drone-agent-planning-session-process-lessons)
- After any memory store, recall the key to verify. A store you did not verify is a store you do not have.
- If a store fails twice, write the artifact into the reply body and tell the operator; do not loop.
- A tool error naming a field is a schema error in the call, not a harness fault.
