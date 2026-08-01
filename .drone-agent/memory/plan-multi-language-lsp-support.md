---
key: plan-multi-language-lsp-support
tags:
  - plan
  - lsp
  - multi-language
  - auto-install
created: 2026-08-01T22:02:33.427Z
updated: 2026-08-01T22:02:33.427Z
---

# Plan: Multi-Language LSP Support (5.10.1)

## Summary

Extend the LSP plugin to support multiple popular languages beyond TypeScript. This involves:

1. **Extending the installer** to support multiple package manager types (npm, cargo, pip, go, github-release) while keeping the same download/verify/extract flow
2. **Adding known server specs** for Rust, Python, Go, Lua, Shell, YAML, JSON, Dockerfile, TOML, CSS/SCSS/Less, HTML, Svelte, PHP
3. **Improving project detection** — scan for file extensions (not just root markers) to detect ambient languages (JSON, YAML, Dockerfile, etc.)
4. **On-demand server startup** — when the LLM opens/creates a file of a type that has an available LSP server, start that server
5. **Beefing up the LSP prompt fragment** to list available ambient servers

## Implementation Steps

### Step 1: Extend `DroneLspInstallSpec` type

**File: `drone-core/src/lsp-types.ts`**

Add a `type` field to the install spec:

```typescript
export type DroneLspInstallSpec = {
  type: 'npm' | 'cargo' | 'pip' | 'go' | 'github-release';
  package: string;        // package/crate/module/repo name
  version: string;
  tarballUrl: string;     // resolved download URL
  integrity: string;      // sha512 hash
  entryPoint?: string;    // relative path to the server binary/script
};
```

Update `DroneLspKnownServerSpec` to use the new type.

**File: `drone-core/src/config-types.ts`**

No changes needed — the config schema already supports arbitrary server configs. The install spec is only used for known servers, not user-configured ones.

### Step 2: Extend the installer

**File: `drone-agent/src/plugins/lsp/installer.ts`**

Add a `resolveTarballUrl()` function that resolves the download URL based on the install type:

```typescript
async function resolveTarballUrl(spec: DroneLspInstallSpec): Promise<string> {
  switch (spec.type) {
    case 'npm':
      // Already works: spec.tarballUrl is the npm registry URL
      return spec.tarballUrl;
    case 'cargo':
      // https://crates.io/api/v1/crates/{package}/{version}/download
      return `https://crates.io/api/v1/crates/${spec.package}/${spec.version}/download`;
    case 'pip':
      // https://pypi.org/packages/{source}/{package[0]}/{package}/{package}-{version}.tar.gz
      return `https://pypi.org/packages/source/${spec.package[0]}/${spec.package}/${spec.package}-${spec.version}.tar.gz`;
    case 'go':
      // https://proxy.golang.org/{module}/@v/{version}.zip
      return `https://proxy.golang.org/${spec.package}/@v/${spec.version}.zip`;
    case 'github-release':
      // https://github.com/{owner}/{repo}/releases/download/{tag}/{asset}
      return spec.tarballUrl; // pre-resolved, includes platform/arch
  }
}
```

For `github-release`, the tarball URL may need platform/arch substitution (e.g., `rust-analyzer-x86_64-unknown-linux-gnu.tar.gz`). Add a `platformMappings` field to the spec or resolve at spec-definition time.

Update `ensureServerInstalled()` to use `resolveTarballUrl()`.

**Validation**: Unit tests for each package manager's URL resolution. Integration test for at least one new type (e.g., pip download).

### Step 3: Add known server specs

**File: `drone-agent/src/plugins/lsp/known-servers.ts`**

Add specs for the new languages. Each spec needs:

- `id`, `language`, `command`, `args`, `fileExtensions`, `rootPatterns`
- `install` block with the appropriate type
- For ambient languages (JSON, YAML, TOML, Dockerfile, Shell, CSS, HTML): no `rootPatterns` (or empty array) — they'll be detected by file extension scan instead

```typescript
export const KNOWN_SERVER_SPECS: DroneLspKnownServerSpec[] = [
  // Existing TypeScript spec (update to use new install type)
  {
    id: 'typescript',
    language: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
    rootPatterns: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    install: {
      type: 'npm',
      package: 'typescript-language-server',
      version: '5.3.0',
      tarballUrl: 'https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-5.3.0.tgz',
      integrity: 'sha512-...',
      entryPoint: 'lib/cli.mjs',
    },
  },
  // Python
  {
    id: 'pyright',
    language: 'python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    fileExtensions: ['.py'],
    rootPatterns: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
    install: {
      type: 'npm',  // pyright is published to npm
      package: 'pyright',
      version: '1.1.389',
      tarballUrl: 'https://registry.npmjs.org/pyright/-/pyright-1.1.389.tgz',
      integrity: 'sha512-...',
      entryPoint: 'langserver.index.js',
    },
  },
  // Rust
  {
    id: 'rust-analyzer',
    language: 'rust',
    command: 'rust-analyzer',
    args: [],
    fileExtensions: ['.rs'],
    rootPatterns: ['Cargo.toml'],
    install: {
      type: 'github-release',
      package: 'rust-lang/rust-analyzer',
      version: '2024-11-18',
      tarballUrl: 'https://github.com/rust-lang/rust-analyzer/releases/download/2024-11-18/rust-analyzer-x86_64-unknown-linux-gnu.tar.gz',
      integrity: 'sha512-...',
      entryPoint: 'rust-analyzer',
    },
  },
  // Go
  {
    id: 'gopls',
    language: 'go',
    command: 'gopls',
    args: [],
    fileExtensions: ['.go'],
    rootPatterns: ['go.mod', 'go.sum'],
    install: {
      type: 'go',
      package: 'golang.org/x/tools/gopls',
      version: '0.16.2',
      tarballUrl: 'https://proxy.golang.org/golang.org/x/tools/gopls/@v/v0.16.2.zip',
      integrity: 'sha512-...',
      entryPoint: 'gopls',
    },
  },
  // Lua
  {
    id: 'lua-language-server',
    language: 'lua',
    command: 'lua-language-server',
    args: [],
    fileExtensions: ['.lua'],
    rootPatterns: ['.luarc.json', '.luarc.jsonc', 'rockspec'],
    install: {
      type: 'github-release',
      package: 'LuaLS/lua-language-server',
      version: '3.10.6',
      tarballUrl: 'https://github.com/LuaLS/lua-language-server/releases/download/3.10.6/lua-language-server-3.10.6-linux-x64.tar.gz',
      integrity: 'sha512-...',
      entryPoint: 'bin/lua-language-server',
    },
  },
  // Ambient languages (no root patterns — detected by file extension scan)
  {
    id: 'bash-language-server',
    language: 'shell',
    command: 'bash-language-server',
    args: ['start'],
    fileExtensions: ['.sh', '.bash', '.zsh'],
    rootPatterns: [],
    install: {
      type: 'npm',
      package: 'bash-language-server',
      version: '5.1.8',
      tarballUrl: '...',
      integrity: 'sha512-...',
      entryPoint: 'bin/bashe-language-server',
    },
  },
  {
    id: 'yaml-language-server',
    language: 'yaml',
    command: 'yaml-language-server',
    args: ['--stdio'],
    fileExtensions: ['.yaml', '.yml'],
    rootPatterns: [],
    install: {
      type: 'npm',
      package: 'yaml-language-server',
      version: '1.15.0',
      tarballUrl: '...',
      integrity: 'sha512-...',
      entryPoint: 'bin/yaml-language-server',
    },
  },
  // ... JSON, Dockerfile, TOML, CSS, HTML, Svelte, PHP
];
```

**Validation**: Each spec has correct file extensions, root patterns, and install metadata. Unit tests for spec resolution.

### Step 4: Improve project detection — file extension scanning

**File: `drone-agent/src/plugins/lsp/server.ts`**

In `initializeServers()`, after checking root markers, add a file extension scan for ambient servers:

```typescript
// After root-marker-based detection...
// Scan for ambient languages (servers with no root patterns)
for (const spec of knownSpecs) {
  if (spec.rootPatterns.length > 0) continue; // already handled by root marker detection
  if (detectedLanguages.has(spec.language)) continue; // already detected
  if (hasMatchingFiles(workspaceRoot, spec.fileExtensions)) {
    detectedLanguages.add(spec.language);
    // Add to server config
  }
}
```

Add a `hasMatchingFiles()` helper that uses `fast-glob` or a simple recursive scan to check if any files with the given extensions exist in the workspace (excluding common ignore dirs like `node_modules`, `.git`, `dist`).

**Validation**: Unit tests for `hasMatchingFiles()` with various project structures.

### Step 5: On-demand server startup

**File: `drone-agent/src/plugins/lsp/server.ts`**

Add a `startServerForFile(filePath: string)` method that:

1. Determines the file extension
2. Looks up a known server spec that handles that extension
3. If found and not already running, starts the server
4. Returns the server runtime

**File: `drone-agent/src/plugins/lsp/plugin.ts`**

Wire this into the `onBeforePrompt` hook — before each prompt, check if any new files have been created/opened that need a server. This is already where document sync happens, so it's a natural extension.

**Validation**: Test that starting a server for a new file type works. Test that already-running servers are not duplicated.

### Step 6: Beef up the LSP prompt fragment

**File: `drone-agent/src/plugins/lsp/plugin.ts`**

Update the `lsp-status` prompt fragment to include a list of available ambient servers:

```typescript
registration.registerPromptFragment({
  key: 'lsp-status',
  phase: 'header',
  render: async () => {
    const diagPrompt = server.renderDiagnosticsPrompt();
    const states = server.getServerStates();
    const available = server.getAvailableServers(); // NEW: servers that could be started
    const parts: string[] = [];
    
    if (states.length > 0) {
      const serverLines = states.map(s => `${s.language}: ${s.status}`);
      parts.push(`# LSP Servers\n\n${serverLines.join('\n')}`);
    }
    
    if (available.length > 0) {
      const availableLines = available.map(s => 
        `- ${s.language} (${s.id}): ${s.status === 'not_started' ? 'available — mount and use LSP tools for this language' : s.status}`
      );
      parts.push(`## Available LSP Servers\n\n${availableLines.join('\n')}`);
    }
    
    parts.push(diagPrompt);
    return parts.join('\n\n');
  },
});
```

Add `getAvailableServers()` to the `ServerManager` that returns specs that match the workspace but aren't running yet.

**Validation**: Test that the prompt fragment includes available servers when they're detected but not running.

### Step 7: Update tests

**File: `drone-agent/test/lsp-installer.test.ts`**

- Add tests for `resolveTarballUrl()` for each package manager type
- Add tests for `ensureServerInstalled()` with new types

**File: `drone-agent/test/lsp-plugin.test.ts`**

- Add tests for the updated prompt fragment
- Add tests for file-extension-based detection
- Add tests for on-demand server startup

**File: `drone-agent/test/lsp-ergonomics.test.ts`**

- No changes needed (ergonomics are language-agnostic)

**Validation**: All tests pass with `pnpm -r run test`.

### Step 8: Update the roadmap

**File: `.drone-agent/memory/roadmap.md`**

Mark 5.10.1 as in progress or complete.

## Validation Criteria

- [ ] `pnpm -r run lint` passes with zero errors
- [ ] `pnpm -r run build` passes with zero errors
- [ ] `pnpm -r run test` passes (all packages)
- [ ] LSP diagnostics show no errors or warnings
- [ ] Installer supports all 5 package manager types (npm, cargo, pip, go, github-release)
- [ ] Known server specs exist for all target languages
- [ ] File-extension-based detection works for ambient languages
- [ ] On-demand server startup works when new file types are encountered
- [ ] LSP prompt fragment lists available ambient servers
- [ ] Existing TypeScript auto-install continues to work unchanged
- [ ] PATH detection (system-wide install) takes priority over auto-install