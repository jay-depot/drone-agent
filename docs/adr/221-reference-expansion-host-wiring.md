---
tags: [decision, drone-agent, reference-expansion, conversation-service, hosts]
related: [decisions/218-reference-expansion-and-tab-completion.md, decisions/222-reference-expansion-image-inlining.md, concepts/reference-expansion.md, modules/drone-agent.md]
---

# 221 — `@`-reference expansion host wiring: engine capability as the default expander (+ missing receipts)

**Summary**: Despite [218-reference-expansion-and-tab-completion](218-reference-expansion-and-tab-completion.md) landing S1–S15, `@`-reference expansion **never fired in any real host**. `createConversationService` defaulted its `expandUserMessage` option to identity, and `index.tsx` handed the `reference` capability to the **engine** but never to the **service** — so the TUI, readline, JSON-listen, swarm WS, and workflow `ctx.agent` hosts all stayed literal while tab completion worked (completion calls the resolver helpers directly, bypassing the expander). Fix: make the engine's `reference` capability the **default** expander (lazily resolved), so "every host behaves identically" becomes true by construction. Also delivers the success receipt the plan/docs specified but production never emitted, plus glob aggregate receipts and notice forwarding in the listen hosts.

## Context

The branch log jumped **S12 → S14 — there is no S13 commit** — which was almost certainly the host-wiring step. Tests stayed green because `drone-agent/test/reference-expansion-integration.test.ts` **injects a mock** `expandUserMessage` into the service: it validates the append-site contract but never exercises the host → capability seam, which is exactly why the feature was dead in the app (not a stale build — `dist` was newer than `src` and still contained the gap).

A second, independent gap: the plan (S12 "the receipt arrives separately as a `notice`", S14, the docs, and the integration-test mock) all specified an `[expanded @…]` **success receipt** — but production emitted notices only for problems (unresolved/binary/budget), so a successful `@file` was silent, and the test passed against a mock that fabricated the notice.

## Decision

### 1. Engine capability is the default expander

`createConversationService`'s `expandUserMessage` option loses its identity default and gains a lazy default resolver:

```ts
async function defaultExpandUserMessage(text): Promise<DroneReferenceExpansion> {
  const capability = engine.getCapability<DroneReferenceCapability>(
    DRONE_REFERENCE_CAPABILITY_ID
  );
  if (!capability) return { text, images: [], notices: [] };
  return capability.expandUserMessage(text);
}
const resolveExpandUserMessage = expandUserMessage ?? defaultExpandUserMessage;
```

**Lazy resolution is required, not stylistic**: the service is constructed *before* `await engine.initialize()`, and the engine seeds the capability into its `capabilities` map *during* initialize; `getCapability` reads the map at call time and nothing ever clears it. First user message always happens after `initialize()`, so per-call resolution is safe. A construction-time lookup would read empty.

This needs **no change to `ephemeral-conversation.ts`** — the workflow `ctx.agent` host already passes `engine` into `createConversationService`, so capability-resolving covers it automatically.

### 2. Success receipt

`file-kinds.ts` now emits `[expanded @<path> (<lines> lines, <bytes>)]` on a successful text expansion (new `countLines` — a trailing newline is a terminator — and `formatBytes`).

### 3. Glob aggregate receipt

A glob previously emitted one receipt per matched file via the inherited `buildFileBlock` notice, and `resolveGlob` dropped them all — so `@*.ts` was silent. `buildFileBlock` now returns an internal `BuiltFileBlock` (the resolution plus `bytes`/`lines`; the public `DroneReferenceResolution` type is unchanged, so no cross-package break), and `resolveGlob` accumulates and emits **one** aggregate line: `[expanded @*.ts (30 files, 120.4 KB)]` (singular for one file).

### 4. Notice forwarding in the listen hosts

`interactive.ts` and `output-handlers.ts` forward reference-expansion notices so the JSON-listen / swarm-listen hosts surface them too (the swarm-listen signal registration is intercepted in tests so no real signal reaches the worker).

## Consequences

- The capability is the single source of truth: no current or future host can forget to wire the expander.
- Deferred by the host-wiring plan (design unspecified): dir/skill receipts, and notice forwarding in a broader set of hosts — the receipt work here covers file text + glob.

## Validation

- `drone-agent` full suite green (1843 passed; only the same pre-existing ANSI/width TUI failures), `typecheck`/`build`/`lint` clean.
- New/updated tests: `reference-expansion-integration.test.ts` (host → capability seam), `workflow-agent-expansion.test.ts` (new, `ctx.agent` coverage), `interactive-listen-notices.test.ts` (new), `reference-expansion.test.ts` (receipts), `conversation-service-image-describer.test.ts`.

## Notes

- **Lint entrypoint**: the project gate is root `pnpm lint` — `pnpm -r run lint` does not exist (no workspace package defines a `lint` script). Root lint runs prettier `--write`, which reflowed `pnpm-lock.yaml` (5863 lines, no dependency change); that churn was reverted.
- **Pre-existing failures, not from this work**: the `drone-agent` suite carried 10 pre-existing ANSI/width TUI failures (Markdown 6, pretty-tool-output 2, tui-persona-color 2) — proven via a stash baseline — and `tui-completion-menu` is flaky under concurrency but passes 3/3 standalone. `drone-coordinator-ui` `sessions.test.tsx` is the known `NODE_ENV` run-env artifact (passes 16/16 under `NODE_ENV=test`). None import `conversation-service`. (The suite is fully green at later commits.)
- **Reproducible end-to-end check**: `echo '{"type":"chat","message":"… @README.md"}' | node drone-agent/bin/drone-agent --output-json`, then inspect the newest `~/.drone-agent/logs/default/*.json` turn for the `--- Referenced content ---` trailer.

## Related

- [218-reference-expansion-and-tab-completion](218-reference-expansion-and-tab-completion.md) — the feature whose host-wiring half (S13) this supplies
- [222-reference-expansion-image-inlining](222-reference-expansion-image-inlining.md) — the sibling follow-up (images through the same expansion seam)
- reference-expansion — the concept page
- [drone-agent](../../drone-agent/) — `conversation-service.ts`, `index.tsx`, `interactive.ts`, `output-handlers.ts`, `reference-expansion/file-kinds.ts`
