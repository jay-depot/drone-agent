---
tags: [decision]
related:
  [
    154-bin-shims-replace-entry-gates.md,
    234-gateway-external-process-injection.md,
    modules/drone-gateway.md,
  ]
---

# 253 — Gateway-inject entry invocation: the bin shim owns `main()`

**Status**: Accepted (2026-10-12)

## Context

Every `drone-gateway-inject` invocation posted **twice**.

`drone-gateway/src/inject/cli.ts` invoked `main()` at module load:

```ts
export async function main(): Promise<void> {
  await runInjectCli(process.argv.slice(2));
}

main().catch(err => { … process.exitCode = 1; });
```

The bin shim (`bin/drone-gateway-inject`) imports `main` from `dist/` — which
runs the module body, and therefore `main()`, once as a side effect — and then
called `main()` again. So the CLI ran exactly twice per process.

This is the ADR 154 family: the entry module was **not** side-effect-free on
import. ADR 154 removed `invokedDirectly` self-detection gates from the swarm
entrypoints and moved execution into unconditional bin shims, but it did not
sweep the gateway's inject entry, which had grown its own module-load
invocation instead.

## Decision

The **bin shim owns the invocation**; the entry module only exports `main`.

- `src/inject/cli.ts` drops the module-load `main().catch(…)` and keeps only
  `export async function main()`.
- `bin/drone-gateway-inject` calls `main()` exactly once and owns the top-level
  `.catch` that writes the error and sets `process.exitCode = 1`.

The top-level `.catch` belongs in the shim because the shim is the only place
that both (a) runs after the module is fully loaded and (b) is the process's
actual entry point — a module that invokes itself cannot distinguish "imported
for testing" from "run as a program", which is precisely what produced the
double invocation.

## Consequences

- `drone-gateway-inject` runs once per invocation (no duplicate posts).
- `cli.ts` is side-effect-free on import, so it can be imported by tests
  without executing the CLI.
- Consistent with the ADR 154 rule: entry modules export; bin shims execute.
