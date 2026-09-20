---
key: plan-fix-reference-expansion-host-wiring
tags:
  - plan
  - drone-agent
  - reference-expansion
  - bugfix
  - host-wiring
created: 2026-09-20T23:44:29.734Z
updated: 2026-09-20T23:44:29.734Z
---

# Plan: Fix `@`-Reference Expansion Host Wiring

**Status**: READY FOR EXECUTION
**Branch**: `feat/inline-object-refs` (current checkout)
**Created**: 2026-09-20
**Origin session**: manual TUI test of the reference-expansion feature
**Related memory**: `plan-reference-expansion-tab-completion` (S1–S15, deleted after completion), coordinator wiki `reference-expansion-and-tab-completion`, coordinator wiki `drone-agent-reference-expansion-mention-embedding-test`

## Summary

`@`-reference expansion does not fire in the real app. Tab completion works, the
tokenizer works, the file resolver works, and the conversation-service append
sites are correct — but every host runs the **identity** expander because the
`reference` capability is handed to the **engine** and never reaches the
**conversation service**.

Concretely (`drone-agent/src/index.tsx`):

```ts
const reference = createReferenceCapability();      // line 196
const engine = createDronePluginEngine({
  ...
  referenceCapability: reference,                   // line 203  -> engine only
  ...
});
const conversation = createConversationService({    // line 233
  engine, config, logger, debugFlags, sessionManager, budgetService,
  ...callbacks...
  // NO expandUserMessage  <-- the gap
});
```

`createConversationService` defaults the option to identity (line 208), so
`@tokens` stay literal in every host (TUI, readline, JSON-listen, swarm WS,
workflows). Confirmed NOT a stale build: `drone-agent/dist/index.js` was rebuilt
2026-09-20 19:34 (newer than `src/index.tsx`, 2026-09-19 19:30) and the compiled
output still contains `referenceCapability: reference` and no `expandUserMessage`.

Why tests are green: `drone-agent/test/reference-expansion-integration.test.ts`
**injects a mock** `expandUserMessage` into the service, so it validates the
append-site contract but never exercises the host -> capability seam. That seam
is untested, which is exactly why the feature is dead in the app.

The branch log also jumps S12 → S14 — **there is no S13 commit**, which was
almost certainly the host-wiring step. This plan is, in effect, the missing S13.

## Goal (why fix it this way)

Rather than adding one `expandUserMessage:` line to `index.tsx` (which leaves
every current and future host free to forget again), make the engine's
`reference` capability the **default source of truth** for the expander. Then
"every host behaves identically" — as the feature docs already claim — becomes
true by construction.

Bonus: this needs **no change to `ephemeral-conversation.ts`**. That host already
passes `engine: thisEngine()` into `createConversationService`, so a
capability-resolving default covers workflow `ctx.agent` steps automatically.

## Key ordering fact (why lazy resolution is required)

`createConversationService` is called **before** `await engine.initialize()`
(`index.tsx` line 233 vs ~line 370). The engine seeds the capability into its
`capabilities` map **during** `initialize()` (`plugin-engine.ts` line ~966). The
engine's `getCapability` (`plugin-engine.ts` line 1055) reads
`capabilities.get(pluginId)` **at call time**, and nothing clears that map (no
`capabilities.clear()` anywhere; `config.rebuild()` does not touch engine
capabilities). Therefore the default expander MUST resolve the capability
**lazily, per call**, never at construction time. First user message always
happens after `initialize()`, so this is safe.

## Implementation steps

Each step is atomic and independently verifiable. Execute in order.

### Step 1 — Make the engine capability the default expander (coder)

**File**: `drone-agent/src/runtime/conversation-service.ts`

**1a. Extend the `drone-core` import.** The file already imports a large type
block from `'drone-core'` (top of file, lines ~1–19). Add two names to it:

```ts
import {
  DRONE_REFERENCE_CAPABILITY_ID,
  ...
  type DroneReferenceCapability,
  ...
} from 'drone-core';
```

(`DRONE_REFERENCE_CAPABILITY_ID` is a runtime value exported from
`drone-core/src/index.ts` line 257; `DroneReferenceCapability` is a type exported
at line 254. Both already present in the built `drone-core/dist`.)

**1b. Remove the identity default from the destructuring.** Currently
(line ~208):

```ts
  expandUserMessage = async text => ({ text, images: [], notices: [] }),
```

Change to a plain pass-through of the optional option (no default here):

```ts
  expandUserMessage,
```

**1c. Add the lazy default resolver** inside `createConversationService`, next
to `getLlmCapability` (which starts at line ~310, so this is a natural home and
keeps the "capability read" pattern in one place):

```ts
  /**
   * Default `@`-reference expander: resolves the engine's `reference`
   * capability lazily (it is seeded during `initialize()`, after this service
   * is constructed) and falls back to identity when no capability is
   * registered. This makes the capability the single source of truth for every
   * host, so a host never has to remember to wire an expander.
   */
  async function defaultExpandUserMessage(
    text: string
  ): Promise<DroneReferenceExpansion> {
    const capability = engine.getCapability<DroneReferenceCapability>(
      DRONE_REFERENCE_CAPABILITY_ID
    );
    if (!capability) {
      return { text, images: [], notices: [] };
    }
    return capability.expandUserMessage(text);
  }

  const resolveExpandUserMessage =
    expandUserMessage ?? defaultExpandUserMessage;
```

Place `resolveExpandUserMessage` where `expandAndAppend` can close over it
(anywhere in the function body works; a const next to the resolver is fine).

**1d. Use the resolver at the append site.** In `expandAndAppend` (line ~408),
change:

```ts
    const result = await expandUserMessage(content);
```

to:

```ts
    const result = await resolveExpandUserMessage(content);
```

That is the ONLY call site (`grep -n expandUserMessage conversation-service.ts`
shows line 409 as the sole use). Do not touch the three append sites' structure —
they already call `expandAndAppend`, which is correct.

**1e. Do NOT change `index.tsx`.** Leaving `expandUserMessage` unwired there is
the point: it proves the default works and removes the duplicate-wiring risk. The
engine already receives `referenceCapability: reference`.

**Step 1 done when**: `pnpm -r run typecheck` passes for `drone-agent`, and no
other file needed editing. (Verify `grep -rn expandUserMessage drone-agent/src`
now returns only `conversation-service.ts` and `capability.ts` — no host.)

### Step 2 — Host-level regression test, using the REAL capability (tester/coder)

**File**: `drone-agent/test/reference-expansion-integration.test.ts`

This test must go through the **real** host seam the mock currently bypasses:
build a real `createReferenceCapability()`, expose it from the mock engine's
`getCapability` under the id `'reference'`, construct the conversation service
**without** `expandUserMessage`, and assert a real on-disk file is inlined.

Add `import { createReferenceCapability } from '../src/runtime/reference-expansion/index.js';`
to the imports. Add a new `describe` block at the end of the file:

```ts
describe('host wiring: the engine capability is the default expander', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  function makeHostConversation(
    provider: DroneLlmProvider,
    capability: DroneReferenceCapability | undefined
  ) {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => 'ok',
    });
    const config = createDefaultAgentConfig();
    const budgetService = createContextBudgetService({
      config,
      renderPromptFragments: async () => [],
      getProvider: () => provider,
      getModel: () => 'fake',
    });
    const sessionManager = createSessionManager();
    // No `expandUserMessage` — the host must resolve it from the capability.
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => {
      if (id === 'llm') return makeLlmCapability(provider);
      if (id === 'reference') return capability;
      return undefined;
    };
    return { conversation, engine };
  }

  it('inlines a real @file reference with no expandUserMessage option', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ref-host-'));
    await writeFile(path.join(dir, 'notes.md'), 'hello from disk\n', 'utf-8');
    const provider = makeProvider([{ message: 'done' }]);
    const capability = createReferenceCapability({ cwd: dir, homedir: dir });
    const { conversation } = makeHostConversation(provider, capability);

    await conversation.sendUserMessage('see @notes.md');

    const turn = conversation
      .getMessages()
      .find(m => m.role === 'user');
    expect(turn?.content).toContain('--- Referenced content ---');
    expect(turn?.content).toContain('hello from disk');
  });

  it('falls back to identity when no reference capability is registered', async () => {
    const provider = makeProvider([{ message: 'done' }]);
    const { conversation } = makeHostConversation(provider, undefined);

    await conversation.sendUserMessage('see @notes.md');

    const turn = conversation
      .getMessages()
      .find(m => m.role === 'user');
    expect(turn?.content).toBe('see @notes.md');
  });
});
```

Add `type DroneReferenceCapability` to the existing `drone-core` import block in
this test file. `mkdtemp`, `mkdir`, `writeFile`, `rm`, `tmpdir`, `path`,
`afterEach`, `createContextBudgetService`, `createSessionManager`,
`createMockEngine`, `silentLogger`, `makeLlmCapability`, `createProvider`-style
helpers already exist in the file — reuse them.

**Note on the pre-fix red state**: this test MUST fail before Step 1 and pass
after. Confirm that by running it against a stash of Step 1, or simply observe it
fail first if Step 1 is applied after.

### Step 3 — Confirm workflow-host (`ctx.agent`) expansion is covered (tester)

Because `ephemeral-conversation.ts` passes `engine: thisEngine()`, Step 1 covers
it with no code change. Add ONE focused test proving it, so the coverage is
explicit rather than incidental.

**File**: `drone-agent/test/workflow-agent-expansion.test.ts` (new)

Sketch: drive a workflow whose `run` calls `ctx.agent('see @notes.md')` against a
temp project dir containing `notes.md`, with a real `createReferenceCapability`
attached to the engine's `getCapability` under `'reference'`. Assert that the
ephemeral conversation's final reply round saw the expanded text (easiest: have
the mocked provider `chat` capture the last user message and assert it contains
`--- Referenced content ---`).

If a full workflow-harness test proves disproportionately heavy, a lighter
equivalent is acceptable: construct `createEphemeralConversation({ engine, config, logger })`
directly with a mock engine exposing the real capability, call `send(prompt)`,
and assert the provider's captured user message is expanded. Prefer this lighter
form — it tests the same seam with far less scaffolding. Whichever form is used,
it must construct the service WITHOUT `expandUserMessage`.

### Step 4 — Fix the stale documentation (coder)

**File**: `docs/agents/reference-expansion.md`

In the "Where expansion happens" section, state the new contract explicitly: the
engine's `reference` capability is the **default** expander, resolved lazily by
the conversation service at the append sites, so a host only supplies
`expandUserMessage` to override (tests do this). Add one sentence: expansion is
on by default in every host because the capability is seeded before plugin
registration; a host never has to wire it.

**File**: `AGENTS.md`

The reference-expansion bullet's parenthetical already points at the doc; no
structural change needed. Re-read the sentence and correct it only if it now
contradicts the code (code is the source of truth). Do not add fluff.

### Step 5 — Correct the as-built swarm wiki claim (coder)

**Wiki page**: `reference-expansion-and-tab-completion` (coordinator scope).

Its "Decision" bullet claims "every host behaves identically." That was untrue
before this fix and true after. Read the page, then update that bullet to state
the mechanism (engine `reference` capability resolved lazily by the conversation
service as the default expander; hosts override only for tests), and add a short
"Fix history" note that the original S1–S15 landing omitted host wiring (no S13
commit) and was repaired by this change. Use `swarm__wiki_write`. Keep the pitch
field accurate.

### Step 6 — Log the insight (any)

Record a `self-improvement__insight` against `targetType: "project"` capturing the
general lesson: *a plugin-extensible capability that is seeded into the engine but
consumed by the conversation service needs a default-resolution path from the
service to the engine; otherwise each host must remember to wire it and the seam
is untested when tests inject a mock.* Include the concrete instance (reference
expansion, missing S13).

## Dependencies / ordering

- Step 1 blocks Steps 2 and 3 (they assert its behavior).
- Step 2 should be written and observed RED before Step 1 lands, if practical.
- Step 4/5/6 depend on Step 1 (docs must describe real behavior).
- No step touches `drone-core` source, so no cross-package rebuild is needed
  beyond the normal `pnpm -r run build`.

## Files touched (expected)

- `drone-agent/src/runtime/conversation-service.ts` (Step 1)
- `drone-agent/test/reference-expansion-integration.test.ts` (Step 2)
- `drone-agent/test/workflow-agent-expansion.test.ts` (Step 3, new)
- `docs/agents/reference-expansion.md` (Step 4)
- `AGENTS.md` (Step 4, only if contradicted)
- swarm wiki page `reference-expansion-and-tab-completion` (Step 5)

Explicitly NOT touched: `drone-agent/src/index.tsx`,
`drone-agent/src/runtime/ephemeral-conversation.ts`,
`drone-agent/src/runtime/reference-expansion/*` (all correct already).

Do NOT commit the untracked `TEST.md` scratch file at the repo root.

## Validation criteria

All must pass before the work is considered done.

1. **LSP clean** — `lsp__get_diagnostics` reports no errors or warnings for every
   changed/added file (and by extension the workspace).
2. **Typecheck** — `pnpm -r run typecheck` exits 0.
3. **Build** — `pnpm -r run build` exits 0.
4. **Lint** — `pnpm -r run lint` exits 0 (prettier reflows files; re-read any
   file before editing it again afterward).
5. **Fast tests** — `pnpm -r run test` passes, including:
   - the two new host-wiring tests in `reference-expansion-integration.test.ts`,
   - the ephemeral/workflow expansion test from Step 3,
   - the pre-existing `reference-expansion`, `reference-expansion-integration`,
     `tui-completion`, `tui-completion-menu`, `tui-multiline-caret`,
     `skills-render-body` suites (all still green).
6. **Regression proof** — the Step 2 test fails when Step 1 is reverted, and
   passes with Step 1 applied. Capture both observations.
7. **No stale consumers** — `grep -rn "expandUserMessage" drone-agent/src`
   returns only `conversation-service.ts` (option type, resolver, default) and
   `reference-expansion/capability.ts` (implementation). No host passes it.
8. **Manual TUI check** (final acceptance) — run the TUI, send
   `describe @README.md`, and confirm the turn carries a
   `--- Referenced content ---` trailer and a `[expanded @README.md …]` notice.
   Repeat once with `@~/some-real-file` to confirm `~/` expansion end to end.
9. **Final step** — re-read this plan and verify every step's "done when" was met.
