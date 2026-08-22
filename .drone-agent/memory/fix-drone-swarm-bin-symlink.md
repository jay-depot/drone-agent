---
key: fix-drone-swarm-bin-symlink
tags:
  - plan
  - bugfix
  - drone-swarm
created: 2026-08-22T21:04:42.504Z
updated: 2026-08-22T21:04:42.504Z
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
- Rough shape:

```ts
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realShim = path.join(pkgDir, 'bin', 'drone-swarm');
const distIndex = path.join(pkgDir, 'dist', 'index.js');

describe('drone-swarm bin shim (symlinked invocation)', () => {
  let linkDir: string;
  beforeAll(async () => { linkDir = await mkdtemp(path.join(tmpdir(), 'ds-bin-')); await symlink(realShim, path.join(linkDir, 'drone-swarm')); });
  afterAll(async () => { await rm(linkDir, { recursive: true, force: true }); });

  it.skipIf(!existsSync(distIndex))('runs main() through the link symlink', async () => {
    const { stdout } = await execFileAsync(process.execPath, [path.join(linkDir, 'drone-swarm'), '--help']);
    expect(stdout).toContain('Usage:');
  });
});
```

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
