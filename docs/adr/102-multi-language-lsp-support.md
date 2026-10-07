---
tags: [decision, lsp, multi-language, auto-install]
related: [decisions/098-lsp-file-list-mount-conversion.md, decisions/100-list-mount-improvements.md, decisions/069-lsp-ergonomics.md, decisions/103-lsp-hash-fix.md, modules/drone-agent-plugins.md, modules/drone-core.md]
---

# Decision 102: Multi-Language LSP Support (5.10.1)

**Summary**: Extended the LSP plugin from TypeScript-only to 14 languages. Added a `DroneLspInstallSpec` type supporting 5 package managers, ambient language detection via file extension scanning, on-demand server startup, and an enhanced prompt fragment listing available servers.

## Context

After converting the LSP and File plugins to the list/mount pattern ([[decisions/098-lsp-file-list-mount-conversion]]) and adding ergonomic improvements ([[decisions/069-lsp-ergonomics]]), the LSP plugin only knew about TypeScript. Users could configure other servers manually via `lsp.servers`, but there was no auto-detection, auto-install support, or UI for other popular languages.

## Decision

### 1. `DroneLspInstallSpec` Type

Added to `drone-core/src/lsp-types.ts` and exported from the index:

```typescript
export type DroneLspInstallSpec = {
  type: 'npm' | 'cargo' | 'pip' | 'go' | 'github-release';
  package: string;   // package/crate/module/repo name
  version: string;
  tarballUrl: string; // pre-resolved download URL
  integrity: string;  // sha512-base64 hash
  entryPoint?: string; // relative path to server binary/script in extracted archive
};
```

Replaced the old `KnownServerInstallSpec` type (which was npm-only, with `npmPackage` and `nodeEntry` fields) in `known-servers.ts`.

### 2. Installer Extension

Added `resolveTarballUrl(spec: DroneLspInstallSpec): string` to `installer.ts`:

| Type | URL pattern |
|------|-------------|
| `npm` / `github-release` | `spec.tarballUrl` (pre-resolved) |
| `cargo` | `https://crates.io/api/v1/crates/{pkg}/{version}/download` |
| `pip` | `https://pypi.org/packages/source/{pkg[0]}/{pkg}/{pkg}-{version}.tar.gz` |
| `go` | `https://proxy.golang.org/{module}/@v/{version}.tar.gz` |

For `go`, the Go module proxy supports `.tar.gz` directly — no zip library needed. For `github-release`, the URL is pre-resolved in the spec to include the correct platform/arch.
The download/verify/extract flow is unchanged — all package managers use the same tar extraction pipeline. For non-npm types, `entryPoint` points to the server binary after extraction (no `node` invocation prefix needed).

### 3. Known Server Specs (14 languages)

Added to `drone-agent/src/plugins/lsp/known-servers.ts`:

| ID | Language | Package manager | `rootPatterns` | Ambient? |
|----|----------|-----------------|----------------|---------|
| `typescript` | TypeScript/JS | npm | `tsconfig.json`, `package.json`, … | No |
| `pyright` | Python | npm | `pyproject.toml`, `setup.py`, … | No |
| `rust-analyzer` | Rust | github-release | `Cargo.toml` | No |
| `gopls` | Go | go | `go.mod`, `go.sum` | No |
| `lua-language-server` | Lua | github-release | `.luarc.json` | No |
| `bash-language-server` | Shell | npm | _(none)_ | Yes |
| `yaml-language-server` | YAML | npm | _(none)_ | Yes |
| `json-language-server` | JSON | npm | _(none)_ | Yes |
| `dockerfile-language-server` | Dockerfile | npm | _(none)_ | Yes |
| `taplo` | TOML | npm | _(none)_ | Yes |
| `css-language-server` | CSS/SCSS/Less | npm | _(none)_ | Yes |
| `html-language-server` | HTML | npm | _(none)_ | Yes |
| `svelte-language-server` | Svelte | npm | `svelte.config.js` | No |
| `intelephense` | PHP | npm | `composer.json` | No |

**Integrity hashes**: TypeScript has a real pinned hash. All other servers had placeholder zeros — these were replaced with real sha512 values in [[decisions/103-lsp-hash-fix]].

### 4. Ambient Language Detection

Added `hasMatchingFiles(rootPath, fileExtensions): Promise<boolean>` to `server/helpers.ts`. It does an early-exit recursive directory scan (excludes `node_modules`, `.git`, `dist`, etc.) to check if any files with the given extensions exist.

Updated `detectKnownLanguageSpecs()` in `server.ts`:
- Specs with `rootPatterns.length > 0`: check for well-known files (existing behavior)
- Specs with `rootPatterns.length === 0` (ambient): scan for matching file extensions

This means `yaml-language-server` is now auto-detected for any project that has `.yaml`/`.yml` files, `json-language-server` for projects with `.json`/`.jsonc` files, etc.

### 5. On-Demand Server Startup

Added to `ServerManager`:
- `startServerForFile(filePath: string): Promise<boolean>` — finds a known spec matching the file extension, starts the server if not already running, returns `true` on success
- `getAvailableServers(): Array<{id, language, fileExtensions, status: 'available'}>` — returns specs whose server isn't currently running

`startServerForFile` is available programmatically but not yet wired into any lifecycle hook (deferred to 5.10.2).

### 6. Enhanced LSP Prompt Fragment

Updated the `lsp-status` prompt fragment to include available-but-not-running servers:

```
# LSP Servers

typescript: connected

## Available LSP Servers

- yaml (yaml-language-server): available — mount and use LSP tools for this language
- json (json-language-server): available — mount and use LSP tools for this language
...

# LSP Diagnostics

Clean. No errors or warnings detected.
```

## Consequences

### Positive

- **14 languages supported** with auto-detection and auto-install plumbing
- **No breakage** — existing TypeScript auto-install path unchanged; PATH probe always wins
- **Ambient detection** — JSON, YAML, Dockerfile, TOML, CSS, HTML, Shell are auto-detected by file extension scan on startup
- **LLM visibility** — the prompt fragment now tells the LLM which servers are available for the current project

### Negative

- ~~**Placeholder integrity hashes** — 13 of 14 servers have `sha512-000...` hashes. Auto-install for those will fail until real values are pinned.~~ **Resolved** in [[decisions/103-lsp-hash-fix]] — all 13 servers now have real sha512 hashes.
- ~~**github-release URLs are platform-specific** — `rust-analyzer` and `lua-language-server` have hard-coded `x86_64-unknown-linux-gnu`/`linux-x64` tarball URLs. Multi-platform support requires either `platformMappings` in the spec or per-platform entries.~~ **Resolved** in [[decisions/103-lsp-hash-fix]] — both servers now have `platforms` entries for linux-x64, linux-arm64, darwin-x64, darwin-arm64.
- **`startServerForFile` not hooked** — the on-demand startup method exists but isn't wired into any lifecycle hook yet. The LLM can't trigger it directly.

## Implementation

- **Branch**: `feat/lsp-file-list-mount-conversion`
- **Commit**: `db1d202`
- **Files changed** (10 source + 2 test):
  - **drone-core**: `src/lsp-types.ts` (new type), `src/index.ts` (export)
  - **drone-agent**: `plugins/lsp/installer.ts` (resolveTarballUrl, InstallerSpec update), `plugins/lsp/known-servers.ts` (14 specs), `plugins/lsp/server.ts` (detection + on-demand startup), `plugins/lsp/server/helpers.ts` (hasMatchingFiles), `plugins/lsp/plugin.ts` (enhanced fragment), `runtime/plugin-engine.ts` (minor cleanup)
  - **tests**: `test/lsp-installer.test.ts` (resolveTarballUrl tests, baseSpec update)
- **Validation**: 108 test files, 1694 tests passed. Lint, build, LSP diagnostics all clean.
