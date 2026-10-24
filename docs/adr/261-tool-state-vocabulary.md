# 261. Tool-state vocabulary: registered, mounted, callable

- Status: Accepted
- Date: 2026-10-23

## Context

The engine model has always had two independent tool axes: whether a tool is
**in the registry** (registered by a plugin) and whether it is **mounted**
(visible to the LLM). But the prose the model and operator actually read
collapsed both into the single word **"available"**, which describes either
axis and therefore neither.

The ambiguity had a concrete cost. `runtime__list_tools` sourced its list from
`ToolRegistry.listUnmountedWithSchemas`, which skips mounted entries by
construction, so every tool it returned was unmounted — yet the description
said "List all available tools." A premounted tool (ADR
[109](109-persona-level-tool-premounting.md)) silently vanished from the list:
the model had mounted it, the list did not show it, and the model re-mounted it
or assumed it was gone. Separately, the ADR [252](252-mcp-double-mount-and-tool-availability-disclosure.md)
disclosure used "available" in a third sense ("The following tools were
available earlier in the session but are no longer available"), and the
portable-context import result carried an `unavailableTools` field whose
entries were specifically tools that had **lost their registry entry** — a
narrower fact than "unavailable" implied.

Three axes were being named by one word:

1. **Registered** — the tool exists in the `ToolRegistry`.
2. **Mounted** — the tool's `mounted` flag is set; it is in the LLM's tool list.
3. **Callable** — both: mounted **and** still registered.

## Decision

### D1 — Three-state vocabulary, one word per axis

- **registered** — in the `ToolRegistry` (`ToolRegistry.get(name)` defined).
- **mounted** — the registry's `mounted` flag (`ToolRegistry.isMounted(name)`).
- **callable** — mounted **and** registered; the compound state the model
  actually needs.
- **"available"** is retired from tool prose. It names neither axis precisely
  and reads as both.

### D2 — `runtime__list_tools` lists all registered tools with mount status

The meta-tool sources from `ToolRegistry.listAll()` (mounted + unmounted), not
`listUnmountedWithSchemas`, and flags each entry with `mounted`
(`DroneToolDescriptor.mounted`, stamped via `toolRegistry.isMounted`). The list
is now the complete picture: what exists, and which of it the model holds. The
`toolCount` response field becomes `{ total, mounted, unmounted }`. The
description reads "List all registered tools and their mount status."

`ToolRegistry.listAll()` gains an optional `pluginFilter`, matching the sibling
`listUnmounted` / `listUnmountedWithSchemas` methods.

### D3 — A mounted tool is always listed

Persona `allowedTools` gating and `defaultHidden` filtering apply to the
**unmounted** portion only. A mounted tool is listed unconditionally, because
premounting is the deliberate shortcut by which a persona reaches a
`defaultHidden` tool (ADR [109](109-persona-level-tool-premounting.md)); hiding
it from the list would hide the very thing the premount exists to expose.

### D4 — Disclosure prose uses "callable" and "unregistered"

The engine-owned footer fragment (ADR [252](252-mcp-double-mount-and-tool-availability-disclosure.md) D5):

- Heading `# No-longer callable tools`; body "The following tools were
  callable earlier in the session but are no longer callable."
- Per-entry annotation, derived at render from registry membership:
  still registered → `(Automatically unmounted, mount again if needed)`;
  registry entry gone → `(Unregistered, do not attempt to call or mount again)`.
- The coalesced notice reads `[N tool(s) are no longer callable]`.

This **amends ADR 252 D6 and D8** in wording only (heading
`# Unavailable tools` → `# No-longer callable tools`; annotation
`(Removed from available set, …)` → `(Unregistered, …)`; notice
`became unavailable` → `are no longer callable`). The mechanism — the sticky,
self-healing `everMounted − currentlyMounted` fragment, the coalescing, the
per-entry annotation derived from registry membership — is unchanged.

### D5 — `unavailableTools` → `unregisteredTools`

`DronePortableContextImportResult.unavailableTools` is renamed to
`unregisteredTools`, because the entries are precisely the tools that failed
`isToolRegistered` on import. The rename travels the whole surface: the NDJSON
`contextImport` event (`output-handlers.ts`, `interactive.ts`), the checkpoint
output line (`Unregistered tools: …`, both the `/checkpoint` handler and the
`--checkpoint.restore` startup path), and the continuation disclosure ("were
mounted in the prior session but are no longer registered").

### D6 — Prompt surfaces use "registered" / "callable"

`TOOL_MANAGEMENT_EXPLAINER` (the `Tool Management` fragment, `drone-core`)
reads "check whether it is **registered** by calling `runtime__list_tools` … it
will then be **callable**."

## Rejected alternatives

- **Keep "available."** Every document and fragment would still describe two
  axes with one word; the confusion that motivated this change is the direct
  result.
- **A boolean superset flag (e.g. `available`) on each listed tool.** Redundant
  with `mounted`, and re-imports the ambiguity: "available" cannot distinguish
  "mounted" from "still registered," which is exactly the distinction the
  disclosure needs.
- **Rename the `everMounted` / `computeUnavailableTools` internals too.** These
  are private, name a set-theoretic fact (ever-mounted minus mounted), and are
  not user- or model-facing. Renaming them adds churn without touching the
  ambiguity, which lives in the prose. Deferred.

## Consequences

- The model sees one list containing every registered tool, each explicitly
  flagged mounted or not; a premounted tool no longer disappears.
- Persona/default-hidden gating still governs which unmounted tools are
  visible, unchanged from ADR [108](108-tool-visibility-filtering-fix.md).
- `toolCount` is an object, not a number — a breaking change for any consumer
  of the response shape.
- `DronePortableContextImportResult.unavailableTools` is renamed; the NDJSON
  `contextImport` field follows. Any external consumer of that wire field must
  update. The `DronePortableContextExport` schema version is unchanged — the
  field is on the import **result**, not the serialized export.
- ADR 252's D6/D8 strings no longer match the shipped code; this ADR is the
  superseding record for the wording.
