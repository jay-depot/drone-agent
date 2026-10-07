---
tags: [decision, lsp, hashes, platform-support, auto-install]
related: [decisions/102-multi-language-lsp-support.md, modules/drone-core.md, modules/drone-agent-plugins.md]
---

# Decision 103: LSP Server Integrity Hashes & Platform Support (5.10.2)

**Summary**: Replaced all placeholder integrity hashes in `known-servers.ts` with real sha512 values, added platform-specific entries for rust-analyzer and lua-language-server, fixed gopls (zip extraction + go build step), and added `resolvePlatformSpec()` for platform-aware URL/hash resolution.

## Context

The multi-language LSP support ([102-multi-language-lsp-support](102-multi-language-lsp-support.md)) added 13 new server specs beyond TypeScript, but all had placeholder integrity hashes (`sha512-000...`). This meant auto-install failed integrity checks for every non-TypeScript server. Additionally:

- **rust-analyzer** and **lua-language-server** have platform-specific binary tarballs — the single `tarballUrl`/`integrity` fields couldn't express different binaries for different platforms (e.g., linux-x64 vs linux-arm64 for Raspberry Pi)
- **gopls** used a `.tar.gz` URL but the Go module proxy only serves `.zip` files, and the extracted source needs a `go build` step
- Several npm package names/versions in the original specs were incorrect (unpublished packages, wrong versions)

## Decision

### 1. Platform-Aware Fields on `DroneLspInstallSpec`

Added to `drone-core/src/lsp-types.ts`:

```typescript
export type DroneLspPlatformKey =
  | 'linux-x64' | 'linux-arm64'
  | 'darwin-x64' | 'darwin-arm64'
  | 'win32-x64' | 'win32-arm64';

export type DroneLspPlatformSpec = {
  tarballUrl: string;
  integrity: string;
};
```

The `DroneLspInstallSpec` type gained an optional `platforms` field:

```typescript
platforms?: Partial<Record<DroneLspPlatformKey, DroneLspPlatformSpec>>;
```

The top-level `tarballUrl`/`integrity` serve as the default fallback when no platform override exists.

### 2. `resolvePlatformSpec()` Function

Added to `drone-agent/src/plugins/lsp/installer.ts`:

```typescript
export function resolvePlatformSpec(
  spec: DroneLspInstallSpec
): { tarballUrl: string; integrity: string } {
  const platformKey = `${process.platform}-${process.arch}` as DroneLspPlatformKey;
  const platformOverride = spec.platforms?.[platformKey];
  if (platformOverride) return platformOverride;
  return { tarballUrl: spec.tarballUrl, integrity: spec.integrity };
}
```

Called in `ensureServerInstalled()` to resolve the correct URL and hash before download and integrity verification.

### 3. gopls Fix — Zip Extraction + Build Step

**URL fix**: Changed `resolveTarballUrl()` for `go` type from `.tar.gz` to `.zip`:
- Before: `https://proxy.golang.org/{module}/@v/{version}.tar.gz`
- After: `https://proxy.golang.org/{module}/@v/{version}.zip`

**Zip extraction**: Added `extractZip()` — a minimal ZIP parser using only Node.js built-in `zlib` and `Buffer`. Handles deflate-compressed entries, strips the top-level directory (Go module proxy layout: `<package>@<version>/<files...>`), and writes files to the destination. No external dependencies needed.

**Build step**: After extraction for `go` type installs, runs `go build -o <entryPoint>` in the cache directory. If Go is not on PATH, throws a clear error:

```
Failed to build gopls from source. Go must be installed and on PATH.
  Error: <underlying error>
If you don't have Go installed, install gopls manually or set it up via your system package manager.
```

### 4. Hash Computation Script

Created `scripts/compute-lsp-hashes.mjs` — a standalone Node.js script that:
1. Downloads each tarball from its URL
2. Computes sha512 of the raw bytes
3. Outputs the integrity string in `sha512-<base64>` format
4. Handles all 13 servers, including platform-specific variants for rust-analyzer and lua-language-server

The script is kept in the repo for reproducibility and future updates.

### 5. Corrected Package Names/Versions

During hash computation, several package names/versions were found to be incorrect:

| Server | Old | New | Reason |
|--------|-----|-----|--------|
| bash-language-server | 5.1.8 | 5.6.0 | Version 5.1.8 doesn't exist on npm |
| vscode-json-languageserver | 1.15.0 | 1.3.4 | Package was unpublished after 1.3.4 |
| taplo | 0.9.3 | @taplo/cli 0.7.0 | `taplo` package doesn't exist; `@taplo/cli` is correct |
| vscode-css-languageserver | 1.15.0 | vscode-css-languageserver-bin 1.4.0 | Original package was unpublished |
| vscode-html-languageserver | 1.15.0 | vscode-html-languageserver-bin 1.4.0 | Original package doesn't exist |
| svelte-language-server | 1.0.0 | 0.18.3 | Version 1.0.0 doesn't exist on npm |
| rust-analyzer | 2024-11-18 | 2026-07-27 | Old release assets were 404 |
| gopls | .tar.gz | .zip | Go module proxy only serves .zip |

### 6. Platform Entries

Added platform entries for:

**rust-analyzer** (4 platforms):
- `linux-x64`: `rust-analyzer-x86_64-unknown-linux-gnu.gz`
- `linux-arm64`: `rust-analyzer-aarch64-unknown-linux-gnu.gz`
- `darwin-x64`: `rust-analyzer-x86_64-apple-darwin.gz`
- `darwin-arm64`: `rust-analyzer-aarch64-apple-darwin.gz`

**lua-language-server** (4 platforms):
- `linux-x64`: `lua-language-server-3.10.6-linux-x64.tar.gz`
- `linux-arm64`: `lua-language-server-3.10.6-linux-arm64.tar.gz`
- `darwin-x64`: `lua-language-server-3.10.6-darwin-x64.tar.gz`
- `darwin-arm64`: `lua-language-server-3.10.6-darwin-arm64.tar.gz`

Note: rust-analyzer uses `.gz` files (gzip-compressed single binary, not tar.gz) — the `extractTarball` function handles these via the `tar` library which transparently decompresses gzip.

## Consequences

### Positive

- **All 13 LSP servers now have real integrity hashes** — auto-install works for every known server
- **Platform support** — rust-analyzer and lua-language-server auto-install correctly on linux-x64, linux-arm64, darwin-x64, and darwin-arm64
- **gopls works** — downloads from the correct `.zip` URL, extracts, and builds the binary
- **Clear error messages** — gopls build failure tells the user to install Go
- **Reproducible** — `scripts/compute-lsp-hashes.mjs` can be re-run to update hashes when versions change

### Negative

- **No Windows platform entries yet** — rust-analyzer and lua-language-server don't have `win32-x64`/`win32-arm64` entries (the plan deferred these)
- **rust-analyzer uses `.gz` not `.tar.gz`** — the binary is a gzip-compressed single file, not a tar archive. The `tar` library handles this transparently, but the URL extension is misleading
- **gopls requires Go** — users without Go installed must install gopls manually or via their system package manager

## Implementation

- **Branch**: `feat/lsp-file-list-mount-conversion`
- **Commit**: `b5fec53`
- **Files changed** (8 files, +672/-125):
  - `drone-core/src/lsp-types.ts` — Added `DroneLspPlatformKey`, `DroneLspPlatformSpec`, `platforms` field
  - `drone-core/src/index.ts` — Exported new types
  - `drone-agent/src/plugins/lsp/installer.ts` — Added `resolvePlatformSpec()`, `extractZip()`, go build step, `.zip` URL
  - `drone-agent/src/plugins/lsp/known-servers.ts` — Real hashes, platform entries, corrected package names/versions
  - `drone-agent/test/lsp-installer.test.ts` — Tests for `resolvePlatformSpec`, go build failure, `.zip` URL; fixed nested `describe()` bug
  - `scripts/compute-lsp-hashes.mjs` — New hash computation script
- **Validation**: 108 test files, 1694 tests pass. Typecheck, lint, build all clean.
