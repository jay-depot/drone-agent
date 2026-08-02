---
key: plan-lsp-hash-fix
tags:
  - plan
  - lsp
  - hashes
  - platform-support
created: 2026-08-02T16:06:30.570Z
updated: 2026-08-02T16:06:30.570Z
---

## Plan: Fix LSP Server Integrity Hashes & Platform Support

### Why

The LSP auto-download feature was recently extended to support 13 additional servers beyond TypeScript, but all have placeholder integrity hashes (`sha512-000...`). This means auto-install fails integrity checks for every non-TypeScript server. Additionally, several servers have platform-specific binary tarballs (rust-analyzer, lua-language-server) that need ARM support for the user's Raspberry Pi, and gopls has a broken download URL and missing build step. This plan fixes all of these issues so the auto-download feature actually works.

---

### Step 1: Add platform-aware fields to `DroneLspInstallSpec`

**File:** `drone-core/src/lsp-types.ts`

**What:** Add a `platforms` map to `DroneLspInstallSpec` so platform-specific tarball URLs and integrity hashes can be specified.

**Details:**

```typescript
export type DroneLspPlatformKey =
  | 'linux-x64'
  | 'linux-arm64'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'win32-x64'
  | 'win32-arm64';

export type DroneLspPlatformSpec = {
  tarballUrl: string;
  integrity: string;
};

export type DroneLspInstallSpec = {
  type: 'npm' | 'cargo' | 'pip' | 'go' | 'github-release';
  package: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  entryPoint?: string;
  /** Platform-specific overrides. The top-level tarballUrl/integrity
   *  serve as the default fallback. */
  platforms?: Partial<Record<DroneLspPlatformKey, DroneLspPlatformSpec>>;
};
```

**Why:** The current type has a single `tarballUrl` and `integrity` — impossible to specify different binaries for different platforms. The `platforms` map lets us override per-platform while keeping the top-level fields as defaults.

---

### Step 2: Add platform resolution to the installer

**File:** `drone-agent/src/plugins/lsp/installer.ts`

**What:** Add a `resolvePlatformSpec()` function and update `ensureServerInstalled()` to use it.

**Details:**

```typescript
export function resolvePlatformSpec(spec: DroneLspInstallSpec): {
  tarballUrl: string;
  integrity: string;
} {
  const platformKey =
    `${process.platform}-${process.arch}` as DroneLspPlatformKey;
  const platformOverride = spec.platforms?.[platformKey];
  if (platformOverride) {
    return platformOverride;
  }
  return { tarballUrl: spec.tarballUrl, integrity: spec.integrity };
}
```

Then in `ensureServerInstalled()`, replace direct references to `spec.install.tarballUrl` and `spec.install.integrity` with calls to `resolvePlatformSpec(spec.install)`.

**Why:** This is the glue between the type change and the runtime. The installer transparently picks the right URL and hash for the current platform.

---

### Step 3: Fix gopls — zip extraction and build step

**File:** `drone-agent/src/plugins/lsp/installer.ts`

**3a. Fix the `go` type URL** in `resolveTarballUrl()`:

```typescript
case 'go':
  return `https://proxy.golang.org/${spec.package}/@v/${spec.version}.zip`;
```

**3b. Add zip extraction.** Add a new function `extractZip()` that handles `.zip` files. Use a lightweight zip library (e.g., `adm-zip` or `yauzl`) as a dependency, or implement a minimal parser using Node's built-in `zlib` + `Buffer`. The Go module proxy zip has a standard layout: `<package>@<version>/` — strip the top-level directory.

**3c. Add a build step for `go` type.** After extraction, run `go build -o <entryPoint>` in the extracted directory. If Go is not on PATH, throw a clear error:

```
Failed to build gopls from source. Go must be installed and on PATH.
  Error: <underlying error>
  If you don't have Go installed, install gopls manually or set it up via your system package manager.
```

**3d. Update `ensureServerInstalled()`** to dispatch between `extractTarball` and `extractZip` based on the URL extension, and run the build step for `go` type installs.

---

### Step 4: Write hash-computation script

**New file:** `scripts/compute-lsp-hashes.mjs`

**What:** A standalone Node.js script that:

1. Downloads each tarball from its URL
2. Computes sha512 of the raw bytes
3. Outputs the integrity string in `sha512-<base64>` format
4. Handles all 13 servers, including platform-specific variants for rust-analyzer and lua-language-server

The script should be kept in the repo for reproducibility and future updates.

---

### Step 5: Update `known-servers.ts` with real hashes

**File:** `drone-agent/src/plugins/lsp/known-servers.ts`

**What:** Replace all placeholder integrity values with real hashes from the script output. Add platform entries for rust-analyzer and lua-language-server.

- **npm packages** (10 servers): Replace `integrity` field with real hash. No platform entries needed — npm tarballs are platform-independent.
- **rust-analyzer** (github-release): Add platform entries for linux-x64, linux-arm64, darwin-x64, darwin-arm64 with correct URLs and hashes.
- **lua-language-server** (github-release): Add platform entries for linux-x64, linux-arm64, darwin-x64, darwin-arm64 with correct URLs and hashes.
- **gopls** (go): Fix `tarballUrl` to use `.zip`, update integrity, no platform entries needed (source archive is platform-independent).

---

### Step 6: Update tests

**File:** `drone-agent/test/lsp-installer.test.ts`

**6a.** Update the `resolveTarballUrl` test for `go` type — change expected URL from `.tar.gz` to `.zip`.
**6b.** Add tests for `resolvePlatformSpec()` — returns platform override when it exists, falls back to top-level fields when no platform match.
**6c.** Add tests for zip extraction (using a synthetic zip buffer).
**6d.** Add tests for the `go` build step (mock `execFile` to avoid requiring Go in tests).

---

### Step 7: Run validation

```bash
pnpm -r run typecheck
pnpm -r run lint
pnpm -r run test
pnpm -r run build
```

All must pass with zero errors.

---

### Step 8: Archive hash script in project wiki

After the script has been run and the hashes are updated, archive `scripts/compute-lsp-hashes.mjs` in the project wiki (at `/home/unleet/Obsidian/drone-agent-project/`) for future reference.

---

### Validation Criteria

- [ ] All 13 LSP servers have real sha512 integrity hashes in `known-servers.ts`
- [ ] rust-analyzer has platform entries for linux-x64, linux-arm64, darwin-x64, darwin-arm64
- [ ] lua-language-server has platform entries for linux-x64, linux-arm64, darwin-x64, darwin-arm64
- [ ] gopls downloads from a working `.zip` URL, extracts correctly, and builds the binary
- [ ] gopls build failure produces a clear error message mentioning Go must be installed
- [ ] `resolveTarballUrl('go', ...)` returns a `.zip` URL
- [ ] `resolvePlatformSpec()` correctly resolves platform-specific overrides
- [ ] `scripts/compute-lsp-hashes.mjs` exists in the repo
- [ ] `pnpm -r run typecheck` passes
- [ ] `pnpm -r run lint` passes
- [ ] `pnpm -r run test` passes (including new tests for platform resolution, zip extraction, go build)
- [ ] `pnpm -r run build` passes
