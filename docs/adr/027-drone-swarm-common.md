---
tags: [decision, refactoring, architecture, swarm]
related: [modules/drone-swarm-common.md, modules/drone-beacon.md, modules/drone-coordinator.md]
---

# 027: Extract `drone-swarm-common` Package

**Summary**: Extract duplicated `wiki-storage.ts` (~98% identical, 377 lines each) and `tls.ts` (~95% identical, 124/128 lines) from `drone-beacon` and `drone-coordinator` into a new shared `drone-swarm-common` package. This eliminates ~500 lines of duplicated code and provides a single point of maintenance.

## Context

The `drone-beacon` and `drone-coordinator` packages both needed wiki storage and TLS certificate management. These were initially developed independently, resulting in near-identical copies of the same code. Any bug fix or feature addition had to be applied to both copies, creating a maintenance burden.

The two files in question:

| File | Beacon Lines | Coordinator Lines | Overlap |
|------|-------------|-------------------|---------|
| `wiki-storage.ts` | 377 | 377 | ~98% |
| `tls.ts` | 124 | 128 | ~95% |

The only meaningful difference in `tls.ts` was the cert/key filenames (`beacon-cert.pem` vs `coordinator-cert.pem`). The `wiki-storage.ts` files were functionally identical.

## Decision

Create a new `drone-swarm-common` workspace package and move both files there with the following parameterization:

### TLS Parameterization

Add a `serviceName` parameter to `loadOrCreateTlsIdentity` (default: `'beacon'`) to derive cert/key filenames:

```typescript
export function loadOrCreateTlsIdentity(
  configDir: string,
  serviceName: string = 'beacon',
  commonName: string = 'localhost'
): TlsIdentity {
  const certPath = path.join(configDir, `${serviceName}-cert.pem`);
  const keyPath = path.join(configDir, `${serviceName}-key.pem`);
  // ...
}
```

### Logger Setter

Add a `setTlsLogger()` function so each consumer can inject its own pino logger:

```typescript
let logger: pino.Logger = pino({ name: 'drone-swarm-common', level: 'silent' });
export function setTlsLogger(l: pino.Logger): void { logger = l; }
```

### Wiki Storage Cleanup

Remove the unused `import { logger } from './logger.js'` line that was present in both copies but never used.

## Consequences

### Positive

- **Single point of maintenance** — bug fixes and features only need to be applied once
- **~500 lines of code removed** from the duplicated locations
- **Consistent behavior** — both beacon and coordinator now use exactly the same wiki storage and TLS logic
- **Clear dependency graph** — `drone-beacon` and `drone-coordinator` both depend on `drone-swarm-common`, which depends on `drone-core`

### Negative

- **One more workspace package** — adds to the monorepo package count (now 7)
- **Vitest alias limitation** — sub-path imports like `drone-swarm-common/tls` don't resolve reliably in vitest for tests in consuming packages. Tests in `drone-beacon/test/coordinator-client.test.ts` had to use a relative import path (`../../drone-swarm-common/src/tls.js`) instead of the package name.

### Neutral

- **Logger setter pattern** — slightly more boilerplate at startup (one extra `setTlsLogger(logger)` call), but avoids circular dependencies

## Validation

All validation criteria were met:

- ✅ `pnpm build` succeeds for all packages
- ✅ `pnpm typecheck` passes (pre-existing errors in unrelated test only)
- ✅ `pnpm test` — 47 test files, 806 tests, all passing
- ✅ No remaining imports of `../wiki-storage.js` or `../tls.js` in beacon/coordinator source
- ✅ The unused `randomUUID` import is gone from the shared wiki-storage

## Related

- [[modules/drone-swarm-common]] — Module overview
- [[modules/drone-beacon]] — Consumer
- [[modules/drone-coordinator]] — Consumer
