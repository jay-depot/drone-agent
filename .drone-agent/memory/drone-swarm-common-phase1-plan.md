---
key: drone-swarm-common-phase1-plan
tags:
  - plan
  - refactoring
  - architecture
  - drone-swarm-common
  - phase-1
created: 2026-07-01T01:13:12.830Z
updated: 2026-07-01T01:13:12.830Z
---

# 🚀 Phase 1 Plan: Extract `drone-swarm-common` Package (Wiki-Storage + TLS)

## Summary

Extract the duplicated `wiki-storage.ts` (~98% identical, 377 lines each) and `tls.ts` (~95% identical, 124/128 lines) from `drone-beacon` and `drone-coordinator` into a new shared `drone-swarm-common` package. This eliminates ~500 lines of duplicated code and provides a single point of maintenance.

## Validation Criteria

- [ ] `pnpm build` succeeds for all packages
- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm test` passes (all existing tests + new shared tests)
- [ ] `pnpm lint` passes
- [ ] All wiki-storage tests from both beacon and coordinator pass against the shared code
- [ ] All TLS tests from both beacon and coordinator pass against the shared code
- [ ] No remaining imports of `../wiki-storage.js` or `../tls.js` in beacon or coordinator source
- [ ] The unused `randomUUID` import is gone from the shared wiki-storage

---

## Step 1: Create `drone-swarm-common` Package Skeleton

**Agent**: coder

Create the package directory and configuration files.

### 1a. Create directory structure

```
drone-swarm-common/
├── src/
│   ├── wiki-storage.ts
│   ├── tls.ts
│   └── index.ts
├── test/
│   ├── wiki-storage.test.ts
│   └── tls.test.ts
├── package.json
└── tsconfig.json
```

### 1b. `drone-swarm-common/package.json`

```json
{
  "name": "drone-swarm-common",
  "version": "1.0.0",
  "description": "Shared utilities for drone swarm packages (beacon, coordinator)",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./wiki-storage": {
      "types": "./dist/wiki-storage.d.ts",
      "import": "./dist/wiki-storage.js"
    },
    "./tls": {
      "types": "./dist/tls.d.ts",
      "import": "./dist/tls.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false",
    "clean": "rm -rf dist tsconfig.tsbuildinfo",
    "test": "vitest run"
  },
  "dependencies": {
    "drone-core": "workspace:*",
    "pino": "^9.6.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.10"
  }
}
```

### 1c. `drone-swarm-common/tsconfig.json`

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

### 1d. `drone-swarm-common/src/index.ts`

```typescript
export * from './wiki-storage.js';
export * from './tls.js';
```

---

## Step 2: Register Package in Workspace

**Agent**: coder

### 2a. Update `pnpm-workspace.yaml`

Add `- drone-swarm-common` to the packages list:

```yaml
packages:
  - drone-agent
  - drone-core
  - drone-beacon
  - drone-coordinator
  - drone-coordinator-ui
  - drone-swarm-common
```

### 2b. Run `pnpm install`

To link the new workspace package.

---

## Step 3: Extract `wiki-storage.ts` into Shared Package

**Agent**: coder

Copy the beacon version of `wiki-storage.ts` (which does NOT have the unused `randomUUID` import) into `drone-swarm-common/src/wiki-storage.ts`.

**Changes from the original:**
- Remove the `import { logger } from './logger.js'` line entirely (it was unused in both copies)
- No other changes — the code is 100% identical between beacon and coordinator

The file exports: `setKnowledgeBaseDir`, `writePage`, `readPage`, `deletePage`, `listPages`, `searchPages`, `lintPages`.

---

## Step 4: Extract `tls.ts` into Shared Package

**Agent**: coder

Copy the TLS code into `drone-swarm-common/src/tls.ts` with the following parameterization:

### 4a. Add a logger setter

```typescript
import pino from 'pino';

let logger: pino.Logger = pino({ name: 'drone-swarm-common', level: 'silent' });

export function setTlsLogger(l: pino.Logger): void {
  logger = l;
}
```

### 4b. Parameterize `loadOrCreateTlsIdentity` with `serviceName`

The only meaningful difference between the two copies is the cert/key filenames:
- Beacon: `beacon-cert.pem`, `beacon-key.pem`
- Coordinator: `coordinator-cert.pem`, `coordinator-key.pem`

Add a `serviceName` parameter to derive these:

```typescript
export function loadOrCreateTlsIdentity(
  configDir: string,
  serviceName: string = 'beacon',
  commonName: string = 'localhost'
): TlsIdentity {
  const certPath = path.join(configDir, `${serviceName}-cert.pem`);
  const keyPath = path.join(configDir, `${serviceName}-key.pem`);
  // ... rest is identical
}
```

### 4c. Remove the extra comment lines from the coordinator version

The coordinator version has extra comments like `// Generate certificate using openssl (use -subj with just CN...)` and `// Clean up temp files`. Use the beacon version's cleaner comments.

### 4d. Export

The file exports: `TlsIdentity` (interface), `setTlsLogger`, `loadOrCreateTlsIdentity`, `getTlsOptions`.

---

## Step 5: Update `drone-beacon` to Use Shared Package

**Agent**: coder

### 5a. Add dependency in `drone-beacon/package.json`

```json
"dependencies": {
  "drone-core": "workspace:*",
  "drone-swarm-common": "workspace:*",
  ...
}
```

### 5b. Delete `drone-beacon/src/wiki-storage.ts`

Remove the file entirely.

### 5c. Delete `drone-beacon/src/tls.ts`

Remove the file entirely.

### 5d. Update `drone-beacon/src/routes/wiki.ts`

Change all 6 dynamic imports from `'../wiki-storage.js'` to `'drone-swarm-common/wiki-storage'`:

```typescript
// Before:
const { listPages } = await import('../wiki-storage.js');
// After:
const { listPages } = await import('drone-swarm-common/wiki-storage');
```

### 5e. Update `drone-beacon/src/index.ts`

Change the TLS import:

```typescript
// Before:
import { loadOrCreateTlsIdentity, getTlsOptions } from './tls.js';
// After:
import { loadOrCreateTlsIdentity, getTlsOptions, setTlsLogger } from 'drone-swarm-common/tls';
```

Add a call to set the logger after the logger is created (around line 100, after `logger.info(...)`):

```typescript
import { logger } from './logger.js';
// ... after logger is created ...
setTlsLogger(logger);
```

### 5f. Update `drone-beacon/src/coordinator-client.ts`

Change the `TlsIdentity` import:

```typescript
// Before:
import type { TlsIdentity } from './tls.js';
// After:
import type { TlsIdentity } from 'drone-swarm-common/tls';
```

---

## Step 6: Update `drone-coordinator` to Use Shared Package

**Agent**: coder

### 6a. Add dependency in `drone-coordinator/package.json`

```json
"dependencies": {
  "drone-core": "workspace:*",
  "drone-swarm-common": "workspace:*",
  ...
}
```

### 6b. Delete `drone-coordinator/src/wiki-storage.ts`

Remove the file entirely.

### 6c. Delete `drone-coordinator/src/tls.ts`

Remove the file entirely.

### 6d. Update `drone-coordinator/src/routes/wiki.ts`

Change all 6 dynamic imports from `'../wiki-storage.js'` to `'drone-swarm-common/wiki-storage'`.

### 6e. Update `drone-coordinator/src/index.ts`

Change the TLS import and add logger setter:

```typescript
// Before:
import { loadOrCreateTlsIdentity, getTlsOptions } from './tls.js';
// After:
import { loadOrCreateTlsIdentity, getTlsOptions, setTlsLogger } from 'drone-swarm-common/tls';
```

Add `setTlsLogger(logger)` after logger creation.

### 6f. Update the `loadOrCreateTlsIdentity` call in coordinator's `index.ts`

The coordinator currently calls `loadOrCreateTlsIdentity(config.configDir)` without a service name. Since the default is `'beacon'`, we need to pass `'coordinator'`:

```typescript
// Before:
const tlsIdentity = loadOrCreateTlsIdentity(config.configDir);
// After:
const tlsIdentity = loadOrCreateTlsIdentity(config.configDir, 'coordinator');
```

---

## Step 7: Create Shared Tests

**Agent**: coder

### 7a. `drone-swarm-common/test/wiki-storage.test.ts`

Consolidate the beacon (195 lines) and coordinator (149 lines) wiki-storage tests into a single comprehensive test suite. Import from `'../src/wiki-storage.js'` (or `'drone-swarm-common/wiki-storage'` via vitest alias).

Key tests to include:
- Write and read a page (test both 'beacon' and 'coordinator' scopes)
- Return null for non-existent page
- Delete a page
- Delete non-existent page (returns true with force)
- List all pages
- List pages sorted by updatedAt descending
- Search by title
- Search by content
- Search by tag
- Empty search results
- Lint finds orphans
- Lint finds broken links
- Enforce no downward links (coordinator → beacon)
- Allow upward links (beacon → coordinator)
- Prevent path traversal
- Preserve createdAt on update

### 7b. `drone-swarm-common/test/tls.test.ts`

Consolidate the beacon (73 lines) and coordinator (83 lines) TLS tests. Import from `'../src/tls.js'`.

Key tests:
- Generate new TLS identity when files don't exist
- Load existing TLS identity from disk
- Calculate certificate fingerprint correctly
- Return TLS options with cert and key as Buffers
- Verify files exist on disk after generation (from coordinator test)
- Test with `serviceName = 'coordinator'` to verify parameterization

### 7c. Update `drone-beacon/test/wiki-storage.test.ts`

Replace the content with a thin re-export test that imports from `drone-swarm-common` and runs the same assertions, OR simply delete the beacon/coordinator test files and rely on the shared test suite.

**Recommendation**: Delete the beacon and coordinator wiki-storage and TLS test files, since the code no longer lives there. The shared test suite covers all functionality.

---

## Step 8: Update Root `vitest.config.ts`

**Agent**: coder

Add the new package's test directory to the include array:

```typescript
test: {
  include: [
    'drone-core/test/**/*.test.ts',
    'drone-agent/test/**/*.test.ts',
    'drone-agent/test/**/*.test.tsx',
    'drone-beacon/test/**/*.test.ts',
    'drone-coordinator/test/**/*.test.ts',
    'drone-swarm-common/test/**/*.test.ts',  // ← ADD THIS
  ],
  // ...
}
```

Also add a resolve alias for the new package (so tests can import by package name):

```typescript
resolve: {
  alias: {
    'drone-core': path.join(rootDir, 'drone-core/src/index.ts'),
    'drone-swarm-common': path.join(rootDir, 'drone-swarm-common/src/index.ts'),
  },
},
```

---

## Step 9: Build and Verify

**Agent**: coder

Run the following commands in order:

```bash
pnpm install          # Link new workspace package
pnpm build            # Compile all packages
pnpm typecheck        # Type-check all packages
pnpm test             # Run all tests
pnpm lint             # Lint all packages
```

---

## Step 10: Final Verification

**Agent**: reviewer

Check the work against the validation criteria:

1. ✅ `pnpm build` succeeds
2. ✅ `pnpm typecheck` passes with zero errors
3. ✅ `pnpm test` passes
4. ✅ `pnpm lint` passes
5. ✅ No remaining imports of `../wiki-storage.js` or `../tls.js` in beacon/coordinator source
6. ✅ The unused `randomUUID` import is gone from the shared wiki-storage
7. ✅ All wiki-storage tests pass against shared code
8. ✅ All TLS tests pass against shared code
9. ✅ Beacon and coordinator use `serviceName` parameter correctly
10. ✅ Logger is set via setter in both beacon and coordinator entry points
