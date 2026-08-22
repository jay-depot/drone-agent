---
key: fix-drone-swarm-bin-symlink
tags:
  - plan
  - bugfix
  - drone-swarm
  - completed
created: 2026-08-22T21:04:42.504Z
updated: 2026-08-22T21:16:02.858Z
---

# Plan: Fix drone-swarm silent no-op when linked into $PATH (+ dead entry-gate cleanup)

## Summary & Why
drone-swarm silently exits 0 when invoked through the symlink created by npm/pnpm link: its `invokedDirectly` gate compares `argv[1]`'s basename (`drone-swarm`) against `import.meta.url`'s suffix (`index.js`), which mismatch through symlinks. Fix by adopting the repo-standard unconditional thin-bin-shim pattern (used by drone-beacon, drone-coordinator, drone-gateway). Additionally delete the three now-dead/self-detection entry gates (drone-swarm, drone-gateway, drone-coordinator) — they are unreachable dead code once shims own execution, and project standards require dead code removal.

Branch: `feature/drone-swarm-pipeline-infra` (clean tree at time of planning).

Key constraint discovered: `drone-swarm/test/cli.test.ts:18` does `import { main } from '../src/index.js'` — so `main()` must NEVER be called unconditionally inside `src/index.ts` itself, or every test import executes main against localhost:3456 and process.exits the vitest fork. Moving invocation into the bin shim satisfies this structurally.

## Steps

### Step 1 — Create `drone-swarm/bin/drone-swarm`
Plain-JS ESM shim (package has `"type": "module"`), preserving drone-swarm's exit-code propagation (its `main()` returns `Promise<number>`, unlike server packages):

```js
#!/usr/bin/env node
import { main } from '../dist/index.js';

main().then(code => {
  process.exit(code);
});
```

Make executable: `chmod +x drone-swarm/bin/drone-swarm` (git must record mode 100755).

### Step 2 — Update `drone-swarm/package.json`
- `"bin": { "drone-swarm": "./bin/drone-swarm" }` (was `./dist/index.js`)
- `"files": ["dist", "bin"]` — REQUIRED, else npm pack-based flows drop the shim
- Add `"start": "node ./bin/drone-swarm"` for parity with beacon/gateway

### Step 3 — Delete the gate from `drone-swarm/src/index.ts`
Remove trailing lines (~221–231): the `invokedDirectly` const + `if (invokedDirectly) { main().then(...) }` block. File ends after `export async function main(...)`. Also remove the `#!/usr/bin/env node` shebang at line 1 (direct-execution of dist/index.js is no longer a supported path; matches siblings).

### Step 4 — Delete the dead gate from `drone-gateway/src/index.ts`
Remove lines ~145–152 (`// Entry guard` comment + `invokedDirectly` + if-block). No associated imports to clean.

### Step 5 — Delete the dead gate from `drone-coordinator/src/index.ts`
Remove lines ~790–795 (`// Entry guard:` comment + strict `pathToFileURL` comparison gate + if-block), AND remove the now-unused `import { pathToFileURL } from 'url';` at line 14 (only other use was the gate; noUnusedLocals/eslint will flag it otherwise).

### Step 6 — Regression test `drone-swarm/test/bin-shim.test.ts`
Simulates the link layout: temp dir + symlink named `drone-swarm` → real `<repo>/drone-swarm/bin/drone-swarm`, then spawn `process.execPath <symlink> --help`.
- Assert exit code 0 and stdout contains help banner ("Usage:" / "drone-swarm").
- Guard: `it.skipIf(!existsSync(<repo>/drone-swarm/dist/index.js))(...)` — root vitest runs from TS source without requiring builds; this test is only meaningful post-build (same provisioning-guard philosophy as integration tests).
- Use `mkdtemp(tmpdir())` + `symlink` from `node:fs/promises`; clean up with `rm(..., { recursive: true })` in afterAll.

### Step 7 — Validation (final step; check ALL before done)
1. `pnpm -r build` — all packages pass (required for the regression test to actually run rather than skip).
2. LSP diagnostics clean for all touched files/packages (no exceptions for tests).
3. `pnpm -r lint` passes (prettier will reformat; re-read files after linting before further edits).
4. Root `pnpm test` passes; confirm bin-shim test RAN (not skipped) post-build.
5. Manual smoke: create symlink in a temp PATH dir → `drone-swarm --help` prints help, exit 0 (reproduces the original repro path end-to-end).

## Validation Criteria
- All five checks in Step 7 green.
- No behavioral change for non-linked invocations (`pnpm --filter drone-swarm start`, direct shim exec).
- Dead gates gone from all three packages; no unused imports remain.
- New test covers the symlinked-invocation regression.

## Follow-up notes (out of scope)
- Report's Option B (realpath comparison) rejected in favor of structural fix; documented rationale above.
- Gateway/coordinator gates were effectively dead already (their shims call main() unconditionally); deletion is pure cleanup with zero behavior change.

---

# ✅ COMPLETION SUMMARY (executed 2026-08-22)

All steps executed and validated on `feature/drone-swarm-pipeline-infra`. Plan kept for reference; status: COMPLETE.

- **Steps 1–2**: Shim created at `drone-swarm/bin/drone-swarm` (mode 100755, exit-code propagating). package.json: bin → `./bin/drone-swarm`, files `["dist","bin"]`, `scripts.start` added. Deviation note: an initial textual diff misplaced `"start"` at package.json top level; corrected by rewriting via `JSON.parse`/`stringify` — structural JSON edits are safer done programmatically than as line diffs.
- **Step 3**: Gate + shebang removed from `drone-swarm/src/index.ts`; module now side-effect-free on import (safe for `cli.test.ts`).
- **Step 4**: Dead gate removed from `drone-gateway/src/index.ts` (no imports affected).
- **Step 5**: Dead gate removed from `drone-coordinator/src/index.ts`; also dropped now-unused `pathToFileURL` import (kept `fileURLToPath`, still used for `__dirname`).
- **Step 6**: `drone-swarm/test/bin-shim.test.ts` — two tests: (a) symlinked-invocation spawn via `execFile(process.execPath, [<tmpdir symlink> , '--help'])` guarded by `it.skipIf(!existsSync(dist/index.js))`; (b) shebang + executable-bit assertion (runs pre-build too).
- **Step 7 validation results**:
  1. `pnpm -r build`: all 7 packages green.
  2. LSP: zero errors/warnings on all four touched files.
  3. Lint: **plan correction — lint only exists at repo ROOT (`pnpm lint`); `pnpm -r lint` fails with ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT because no workspace package defines a lint script.** Root `pnpm lint` green; prettier reformatted only bin-shim.test.ts (cosmetic).
  4. Root `pnpm test`: **2049 passed / 0 failed**, `bin-shim.test.ts` RAN (2 tests, 28ms — not skipped, post-build).
  5. Manual smoke via temp PATH symlink: `--help` prints banner exit 0 (original repro path FIXED), unknown command exit 1, direct shim exec exit 0, `pnpm --filter drone-swarm start -- --help` exit 0.
- Net effect: drone-swarm works through npm/pnpm link symlinks; entry-gate dead code eliminated repo-wide; no behavior change for non-linked invocations.