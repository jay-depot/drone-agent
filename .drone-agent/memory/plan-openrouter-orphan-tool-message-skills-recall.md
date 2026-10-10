---
key: plan-openrouter-orphan-tool-message-skills-recall
tags:
  - plan
  - bugfix
  - openrouter
  - skills
  - tool-message-integrity
  - adr-243
created: 2026-10-10T00:52:44.821Z
updated: 2026-10-10T00:52:54.628Z
---

# Plan: Fix orphan tool message from `/skills recall` (OpenRouter 400) + defensive seam (ADR 243)

**Status**: READY FOR EXECUTION · **Assignee**: `code` persona (single agent, all steps) · **Branch**: current branch `feat/swarm-config-startup-underlay` — blocker fix, NO new branch, single commit at the end. **ADR**: new `docs/adr/243-orphan-tool-message-pairing.md` (242 is taken).

## Why

With OpenRouter as the active provider, running `/skills recall <id>` (directly, or inside a macro) makes **every later message** fail:

```
Error: LLM request failed: OpenRouter API error (400): {"error":{"message":"messages[24]: tool messages must include a non-empty string tool_call_id","code":400 ...}}
```

(The real body is visible only because ADR 242 preserved it.)

**Root cause.** `drone-agent/src/plugins/skills/index.ts:443` does:

```ts
ctx.sessionManager?.appendToolResult('skills__recall', raw);
```

This appends a `role:'tool'` session message with **no `toolCallId`** and **no preceding assistant tool-call**. It is an orphan. It persists in the session and is re-sent on every subsequent request. The OpenAI-family wire serializer (`drone-agent/src/shared/openai-compatible.ts:93-95`) sets `tool_call_id` only when `msg.toolCallId` is truthy, so the field is omitted; OpenRouter (strict OpenAI-compat) rejects it with 400. Because the orphan is stored once and never removed, the failure is permanent for the rest of the session.

**Why only OpenRouter.** The anthropic adapter injects a fallback id (`anthropic-adapter.ts:169-170`), the echo driver rewrites `tool`→`user` (`echo-driver.ts:16-21`), and the vanilla openai plugin is not in use. Macros are affected identically because the macro handler re-dispatches with its own `ctx`, which carries `sessionManager` in both hosts (`macros/index.ts:71-74`; TUI `tui/app.tsx:591,611`; readline `interactive.ts:555-561`).

**Correct precedent already exists.** `drone-agent/src/plugins/swarm/session-import.ts:143-162` (`injectChunk`) appends a **paired** assistant tool-call (with an id) immediately followed by the tool result with the matching id. `/skills recall` skips the assistant half.

**Only one orphan producer exists** in `drone-agent/src` (verified): `skills/index.ts:443`. All other `appendToolResult` call sites are valid pairs (`conversation-service.ts:962` with `conversation-service.ts:1350`; `session-import.ts:161` with `session-import.ts:150`). `/tool` and `/exec` built-ins log only and never append.

## Locked decisions (grilled with the user 2026-10-09)

1. **Fix shape = C (both).** Fix the root cause AND add a defensive seam. Rationale: matches ADR 242's "fix the real thing" precedent and the project's sweep-every-consumer principle; the failure mode is a permanent 400, so a cheap guard is worth it.
2. **Root-cause fix = A1 (paired synthetic tool exchange).** `/skills recall` appends an assistant message carrying a synthetic `skills__recall` tool-call **with an id**, then the tool result with the **matching id** — the `session-import` precedent. Extract a shared helper so both sites share one pairing invariant. (Rejected: append-as-user — changes semantics + surfaces in scrollback; synthesize-id-only — still orphan, still rejected by OpenAI validators.)
3. **Defensive seam = B1 (coerce orphan `tool` → `user`), presentation-only.** Content-preserving; a `user` turn is valid on every provider (the echo driver already does this). The seam must NOT mutate the stored session (scrollback/logs/compaction untouched). (Rejected: drop-the-orphan — silently loses the skill body; pair-repair — inserts messages, more complex.)
4. **Detection = narrow, preceding-match.** A `role:'tool'` message is orphan when its `toolCallId` is missing/empty **or** no *preceding* assistant message declares a `tool_calls` entry with that id. Only the orphan-`tool` direction; no dangling-assistant-`tool_calls` handling (pairing holds elsewhere — assistant call + its results live in the same session turn).
5. **Shared append helper** at `drone-agent/src/shared/synthetic-tool-exchange.ts`, used by BOTH `skills/index.ts` and `swarm/session-import.ts`.
6. **Seam placement = inside `prepareRequestMessages`.** It is the single chokepoint both LLM send sites already call — the main tool loop (`conversation-service.ts:1141`) and the `/btw` aside (`conversation-service.ts:1606`). The detection logic lives in an exported pure `coerceOrphanToolMessages` (unit-testable) that `prepareRequestMessages` calls as its first step.

## Steps (sequential; each depends on the previous)

### Step 1 — coder: shared append helper `synthetic-tool-exchange.ts`

New file `drone-agent/src/shared/synthetic-tool-exchange.ts`:

```ts
import type { DroneSlashCommandSessionManager } from 'drone-core';

export type SyntheticToolExchange = {
  toolName: string;
  toolCallId: string;
  arguments?: Record<string, unknown>;
  content: string;
};

/**
 * Append a synthetic assistant tool-call and its matching tool result as one
 * pair. Both halves carry the SAME toolCallId, so OpenAI-family providers
 * (strict about tool_call_id) always accept the exchange. Use this instead of
 * a bare appendToolResult whenever the result stands alone (no real LLM tool
 * call precedes it).
 */
export function appendSyntheticToolExchange(
  sessionManager: DroneSlashCommandSessionManager,
  exchange: SyntheticToolExchange
): void {
  const { toolName, toolCallId, content } = exchange;
  sessionManager.appendAssistantMessage('', [
    {
      id: toolCallId,
      name: toolName,
      arguments: exchange.arguments ?? {},
    },
  ]);
  sessionManager.appendToolResult(toolName, content, toolCallId);
}
```

`DroneSlashCommandSessionManager` is already exported from `drone-core` (`drone-core/src/plugin-system.ts:315`, re-exported from `drone-core/src/index.ts:310`).

### Step 2 — coder: migrate `session-import.ts` to the helper (dedup)

File `drone-agent/src/plugins/swarm/session-import.ts`, function `injectChunk` (~line 143). Replace the two-call body with a delegate:

```ts
import { appendSyntheticToolExchange } from '../../shared/synthetic-tool-exchange.js';

export function injectChunk(
  sessionManager: DroneSlashCommandSessionManager,
  summary: string,
  sessionId: string,
  index: number,
  total: number
): void {
  appendSyntheticToolExchange(sessionManager, {
    toolName: SESSION_IMPORT_TOOL,
    toolCallId: `session-import-${index}`,
    arguments: { sessionId, chunk: index + 1, totalChunks: total },
    content: summary,
  });
}
```

Behavior must stay byte-identical (same id format `session-import-${index}`, same arguments object). Existing `session-import` tests must still pass.

### Step 3 — coder: fix the root cause in `skills/index.ts`

File `drone-agent/src/plugins/skills/index.ts`, the `/skills recall` branch (~lines 425-452). Add two imports at the top of the file:

```ts
import { randomUUID } from 'node:crypto';
import { appendSyntheticToolExchange } from '../../shared/synthetic-tool-exchange.js';
```

Replace the bare `appendToolResult` call (line 443) so the recall branch reads:

```ts
const result = await ctx.engine.executeTool('skills__recall', { id, all: true });
const raw = toToolResultContent(result);
const skill = JSON.parse(raw);

// Append to conversation context as a synthetic, correctly-paired
// tool-call/result so the OpenAI-family wire format stays valid.
if (ctx.sessionManager) {
  appendSyntheticToolExchange(ctx.sessionManager, {
    toolName: 'skills__recall',
    toolCallId: `skills-recall-${randomUUID()}`,
    arguments: { id },
    content: raw,
  });
}

// Tell the user it worked (not the full body)
const skillDef = getSkillById(id.trim().toLowerCase());
ctx.logger.info(
  `Loaded skill: ${skill.name} (${skill.source})${skillDef?.remark ? ` — ${skillDef.remark}` : ''}`
);
return true;
```

Delete the now-unused direct `appendToolResult` line. Keep the `getSkillById` lookup and the `Loaded skill:` logger line unchanged. `randomUUID` guarantees a unique id across repeated recalls in one session (OpenAI only requires each tool message to match its own preceding assistant tool-call).

### Step 4 — coder: pure coercion helper `tool-message-integrity.ts`

New file `drone-agent/src/shared/tool-message-integrity.ts`:

```ts
import type { DroneChatMessage } from 'drone-core';

/**
 * Presentation-only repair of orphan tool messages. A tool message whose
 * toolCallId is empty, or matches no PRECEDING assistant tool-call id, is
 * coerced to a `user` message (content preserved). This keeps the wire
 * representation valid for strict OpenAI-family providers without touching the
 * stored session. Returns a new array; inputs are not mutated.
 */
export function coerceOrphanToolMessages(
  messages: DroneChatMessage[]
): DroneChatMessage[] {
  const declaredIds = new Set<string>();
  const out: DroneChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.id) declaredIds.add(tc.id);
      }
    }
    if (msg.role === 'tool' && (!msg.toolCallId || !declaredIds.has(msg.toolCallId))) {
      out.push({ ...msg, role: 'user' });
      continue;
    }
    out.push(msg);
  }
  return out;
}
```

`declaredIds` is built incrementally as the list is walked forward, so a tool message only "sees" assistant tool-calls that precede it.

### Step 5 — coder: call the coercion inside `prepareRequestMessages`

File `drone-agent/src/runtime/conversation-service.ts`. Add the import:

```ts
import { coerceOrphanToolMessages } from '../shared/tool-message-integrity.js';
```

At the top of `prepareRequestMessages` (definition ~line 1738), run the repair before the image pass and return the coerced list mapped through the existing image logic:

```ts
function prepareRequestMessages(
  messages: DroneChatMessage[],
  targetHasVision: boolean
): DroneChatMessage[] {
  return coerceOrphanToolMessages(messages).map(message => {
    // ... existing body unchanged ...
  });
}
```

This covers BOTH send sites (main loop `:1141`, `/btw` aside `:1606`) via the one chokepoint. Storage/estimator are untouched — the function stays presentation-only.

### Step 6 — coder: tests

(a) **`drone-agent/test/synthetic-tool-exchange.test.ts`** (new) — unit tests for `appendSyntheticToolExchange`: appends exactly two messages; the assistant message has `toolCalls[0].id === toolCallId`; the tool message has matching `toolCallId`; arguments default to `{}`.

(b) **`drone-agent/test/tool-message-integrity.test.ts`** (new) — unit tests for `coerceOrphanToolMessages`:
   - valid pair (assistant tool-call `id:'c1'` + tool `toolCallId:'c1'`) is unchanged;
   - orphan tool with no id → becomes `role:'user'`, content preserved;
   - orphan tool with an id matching no preceding assistant call → becomes `role:'user'`;
   - a tool message whose matching assistant call appears AFTER it → coerced (preceding-match, not global);
   - empty list and no-tool lists pass through; input array not mutated.

(c) **`drone-agent/test/conversation-service.test.ts`** (or the existing image-describer harness file) — one end-to-end seam test in the D11 style (drive a real `h.send()` and inspect the captured `provider.chat()` request, as in `conversation-service-image-describer.test.ts:407-462`): seed the session with an orphan `role:'tool'` message, send a prompt, assert the outbound request contains **no** `role:'tool'` message lacking `tool_call_id` (the orphan arrived as `role:'user'`).

(d) **`drone-agent/test/skills-plugin.test.ts`** — end-to-end regression for the root-cause fix: run `/skills recall <id>` through the engine with a captured session manager, then assert the appended session contains a **paired** assistant `toolCall` (`skills__recall`, non-empty id) immediately followed by the tool result with the **matching** `toolCallId`. Optionally feed the resulting message list through `coerceOrphanToolMessages` and assert nothing is coerced (proving the fix is valid). Mirror the macro path from `macros/index.ts:71-74` (dispatch `/skills recall` from a macro `ctx`) if cheap; otherwise note it is covered by the direct path.

Run the new tests **before** Step 3/5 where possible to show them fail pre-fix.

### Step 7 — coder: ADR 243 + index row

New file `docs/adr/243-orphan-tool-message-pairing.md`, frontmatter copied from `docs/adr/210-beacon-proxy-error-forwarding.md` (tags + related). Structure: title ("Orphan tool messages: pair synthetic tool results and coerce stragglers at the wire"), Summary, Context (the `/skills recall` orphan + OpenRouter 400 with file:line refs; why only OpenRouter; the session-import precedent), Decision (A1 paired exchange via `appendSyntheticToolExchange`; B1 presentation-only `coerceOrphanToolMessages` inside `prepareRequestMessages`; narrow preceding-match detection), Rationale (C over A-only/B-only; A1 over append-as-user / id-only; narrow over broad), Implementation (files: `shared/synthetic-tool-exchange.ts` new, `shared/tool-message-integrity.ts` new, `skills/index.ts`, `swarm/session-import.ts`, `conversation-service.ts`), Tests, Key Points, Related (ADR 242 openrouter error body; ADR 146 swarm session import precedent). Then append the 243 row to `docs/adr/index.md` (keep the table sorted; verify the trailing newline so the append lands as a final table row).

### Step 8 — coder: validation gate (must pass before commit)

Run, in order, from the repo root:

1. Targeted: `pnpm --filter drone-agent exec vitest run test/synthetic-tool-exchange.test.ts test/tool-message-integrity.test.ts test/skills-plugin.test.ts test/session-import.test.ts` (all green).
2. `pnpm run test` (fast suite, all packages).
3. `pnpm typecheck`.
4. `pnpm -r run build`.
5. `pnpm run lint` (ESLint + Prettier). AGENTS.md: after lint reformats files, re-read any file before editing it again.
6. LSP: typescript diagnostics clean (`lsp__get_diagnostics`) — no errors, no warnings.

### Step 9 — coder: update memories + commit

1. Store a followup/plan-status update; mark this plan executed (body Status + `status: completed` frontmatter convention).
2. Stage and commit on `feat/swarm-config-startup-underlay`: the two new shared files, the three edited source files, the new/edited tests, `docs/adr/243-…md`, `docs/adr/index.md`, and the `.drone-agent/memory/` plan file. Message: `fix(tools): pair synthetic tool results + coerce orphan tool messages (ADR 243)`. Verify the working tree is clean after (`git__status`; HOST.md: clean-tree commit errors are a known false alarm).

### Step 10 — final acceptance check

- [ ] New regression tests fail on pre-fix code (orphan present / coercion changes a message) and pass post-fix.
- [ ] All six Step-8 gates pass with zero errors; LSP clean.
- [ ] Behavior audit: `session-import` tests unchanged in behavior (same id format/args); `/skills recall` now appends a valid pair; no `role:'tool'` message without a matching preceding assistant tool-call can reach a provider.
- [ ] `coerceOrphanToolMessages` is pure (no input mutation) and `prepareRequestMessages` remains presentation-only (stored session untouched).
- [ ] Diff touches only the files listed in Step 9.
- [ ] Working tree clean; single commit contains code + tests + ADR + index + memory.

## Out of scope

- Broad dangling-assistant-`tool_calls` handling (no such case arises).
- Changing the anthropic/echo/ollama adapters (they already tolerate orphans by design).
- Any change to session storage, compaction, scrollback, or the log plugin.

## Validation criteria

1. **LSP**: `lsp__get_diagnostics` clean (no errors, no warnings) for every changed/created file.
2. **Lint**: `pnpm run lint` passes with zero errors.
3. **Build**: `pnpm -r run build` passes.
4. **Types**: `pnpm typecheck` passes.
5. **Tests**: `pnpm run test` (fast suite) passes, including the new unit + end-to-end regression tests; the pre-existing `session-import` and `skills-plugin` tests stay green.
6. **Behavioral**: after `/skills recall <id>` the session contains a paired `skills__recall` exchange; a request assembled from a session containing an orphan `tool` message contains no orphan on the wire; OpenRouter's `tool_call_id` 400 can no longer be produced by this path.
