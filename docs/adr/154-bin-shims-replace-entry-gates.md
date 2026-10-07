---
id: decisions/154-bin-shims-replace-entry-gates
title: Bin shims replace entry-point self-detection gates
tags: [decision, architecture, cli, packaging]
related: [modules/drone-swarm.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-gateway.md]
date: 2026-08-22
status: accepted
---

# 154 — Bin shims replace entry-point self-detection gates

**Summary**: Every workspace executable now starts through a thin unconditional bin shim that imports `main()` from `dist/`; all `invokedDirectly` self-detection gates are deleted from entry modules, which are side-effect-free on import.

## Context

drone-swarm's entrypoint gated execution on a fragile heuristic:

```ts
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
```

Through an npm/pnpm link symlink, `process.argv[1]` is the typed shim path
(basename `drone-swarm`) while `import.meta.url` is the real resolved module
(`…/dist/index.js`) — the basenames mismatch, the gate skips, and the process
exits silently with code 0. The CLI "does nothing successfully" when linked,
while working when run as `node dist/index.js`. Two sibling packages carried
the same pattern in latent form (gateway: basename comparison; coordinator:
strict `pathToFileURL(argv[1]) === import.meta.url`), saved only because their
thin bin wrappers already called `main()` unconditionally — making their gates
dead code.

## Decision

Adopt the already-established thin-bin-shim pattern repo-wide and remove every
self-detection gate:

- **drone-swarm** gains `bin/drone-swarm`: a three-line ESM script
  (`#!/usr/bin/env node`, `import { main } from '../dist/index.js'`,
  `main().then(code => process.exit(code))`) that preserves drone-swarm's
  exit-code contract (its `main()` returns `Promise<number>`, unlike the
  server packages). `package.json` points `bin` at the shim, ships `bin/` in
  `files` (pack-based flows would otherwise drop it), and gains a `start`
  script.
- The gate and shebang are deleted from `drone-swarm/src/index.ts`.
- The dead gates are deleted from `drone-gateway/src/index.ts` and
  `drone-coordinator/src/index.ts` (plus coordinator's then-unused
  `pathToFileURL` import).
- Node resolves symlinks before loading the entry script, so the shim works
  identically through link symlinks, copies (`npm i -g`), and direct execution.

A rejected alternative kept the gate but compared realpath'd paths
(`realpathSync(argv[1]) === fileURLToPath(import.meta.url)`). It fixes the
symptom while preserving a mechanism with no remaining purpose — every package
already has (or now has) a shim, so detection logic is pure liability.

## Constraint worth remembering

Entry modules that export `main()` are also imported by tests
(`drone-swarm/test/cli.test.ts` imports `main` from `../src/index.js`). Calling
`main()` unconditionally *inside* such a module would execute on every test
import — hitting the network and `process.exit()`-ing the vitest fork under
the single-fork pool. Moving invocation into the shim satisfies this
structurally: entry modules must stay side-effect-free at import time.

## Consequences

- Linked invocation works end-to-end; regression-covered by
  `drone-swarm/test/bin-shim.test.ts`, which spawns the real shim through a
  tmpdir symlink (`skipIf`-guarded on `dist/index.js` existing, since root
  vitest runs from source without builds).
- Direct `node dist/index.js` execution of drone-swarm is no longer a
  supported path (same as beacon/coordinator/gateway).
- One uniform entry convention across all five workspace executables.

## Related

- [drone-swarm](../../drone-swarm/) — the package whose linked invocation was broken
- memory-pipeline — primary consumer workflow for the CLI
