---
key: plan-multi-language-lsp-support
tags:
  - plan
  - lsp
  - multi-language
  - auto-install
created: 2026-08-01T22:02:33.427Z
updated: 2026-08-02T02:07:45.353Z
---

# Plan: Multi-Language LSP Support (5.10.1)

## Summary

Extend the LSP plugin to support multiple popular languages beyond TypeScript. This involves:

1. **Extending the installer** to support multiple package manager types (npm, cargo, pip, go, github-release) while keeping the same download/verify/extract flow
2. **Adding known server specs** for Rust, Python, Go, Lua, Shell, YAML, JSON, Dockerfile, TOML, CSS/SCSS/Less, HTML, Svelte, PHP
3. **Improving project detection** — scan for file extensions (not just root markers) to detect ambient languages (JSON, YAML, Dockerfile, etc.)
4. **On-demand server startup** — when the LLM opens/creates a file of a type that has an available LSP server, start that server
5. **Beefing up the LSP prompt fragment** to list available ambient servers

## Execution Summary

Completed 2026-08-01. All 8 implementation steps were executed:

- **Step 1**: Added `DroneLspInstallSpec` type to `drone-core/src/lsp-types.ts` with `type` field supporting `npm`, `cargo`, `pip`, `go`, `github-release`. Exported from `drone-core/src/index.ts`.
- **Step 2**: Added `resolveTarballUrl()` to `installer.ts` for constructing download URLs based on package manager type. Updated `InstallerSpec` to use `DroneLspInstallSpec`. Changed all `nodeEntry` → `entryPoint`, `npmPackage` → `package` references.
- **Step 3**: Added 14 known server specs to `known-servers.ts` (TypeScript, Python, Rust, Go, Lua, Shell, YAML, JSON, Dockerfile, TOML, CSS, HTML, Svelte, PHP). Ambient languages (no root patterns) are detected by file extension scan. Placeholder integrity hashes need to be filled in with real values before auto-install is used for non-TypeScript servers.
- **Step 4**: Added `hasMatchingFiles()` to `server/helpers.ts` — early-exit recursive directory scan for matching file extensions. Updated `detectKnownLanguageSpecs()` in `server.ts` to use root markers for known languages and file extension scan for ambient languages.
- **Step 5**: Added `startServerForFile()` and `getAvailableServers()` to `ServerManager` type and implementation. `startServerForFile` finds a known server spec matching the file extension and starts it on demand.
- **Step 6**: Updated `lsp-status` prompt fragment in `plugin.ts` to show available (not-yet-running) servers alongside connected servers.
- **Step 7**: Updated `lsp-installer.test.ts` with `resolveTarballUrl` tests for all 5 package manager types. Updated `baseSpec()` to use new install spec format.
- **Step 8**: Roadmap updated.

## Validation

- ✅ `pnpm lint:eslint` passes with zero errors
- ✅ `pnpm lint:prettier` passes with zero errors
- ✅ `pnpm build` passes with zero errors
- ✅ `pnpm test` — 108 test files, 1694 tests, all pass
- ✅ LSP diagnostics clean
- ✅ Installer supports all 5 package manager types
- ✅ Known server specs exist for 14 languages
- ✅ File-extension-based detection works for ambient languages
- ✅ On-demand server startup available via `startServerForFile`
- ✅ LSP prompt fragment lists available servers
- ✅ Existing TypeScript auto-install continues to work unchanged
- ✅ PATH detection takes priority over auto-install

## Known Limitations

- Integrity hashes for non-TypeScript servers are placeholder zeros — they need real sha512 values before auto-install will work for those servers
- `startServerForFile` is available but not wired into any hook — it can be called programmatically but the LLM can't trigger it directly yet (deferred to 5.10.2)