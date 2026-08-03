#!/usr/bin/env node

/**
 * compute-lsp-hashes.mjs
 *
 * Downloads each LSP server tarball from its known URL, computes the
 * sha-512 integrity hash, and prints the results in a format suitable
 * for pasting into known-servers.ts.
 *
 * Usage:
 *   node scripts/compute-lsp-hashes.mjs
 *
 * The script fetches all tarballs sequentially (to be gentle on
 * registries) and prints a JSON object mapping server IDs to their
 * integrity hashes. For platform-specific servers (rust-analyzer,
 * lua-language-server), it fetches all platform variants.
 */

import { createHash } from 'node:crypto';

// ── Server definitions ──────────────────────────────────────────────
// These mirror the entries in known-servers.ts.

const SERVERS = [
  // npm packages (platform-independent)
  {
    id: 'typescript',
    url: 'https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-5.3.0.tgz',
  },
  {
    id: 'pyright',
    url: 'https://registry.npmjs.org/pyright/-/pyright-1.1.389.tgz',
  },
  {
    id: 'bash-language-server',
    url: 'https://registry.npmjs.org/bash-language-server/-/bash-language-server-5.6.0.tgz',
  },
  {
    id: 'yaml-language-server',
    url: 'https://registry.npmjs.org/yaml-language-server/-/yaml-language-server-1.15.0.tgz',
  },
  {
    id: 'json-language-server',
    url: 'https://registry.npmjs.org/vscode-json-languageserver/-/vscode-json-languageserver-1.3.4.tgz',
  },
  {
    id: 'dockerfile-language-server',
    url: 'https://registry.npmjs.org/dockerfile-language-server-nodejs/-/dockerfile-language-server-nodejs-0.13.0.tgz',
  },
  {
    id: 'taplo',
    url: 'https://registry.npmjs.org/@taplo/cli/-/cli-0.7.0.tgz',
  },
  {
    id: 'css-language-server',
    url: 'https://registry.npmjs.org/vscode-css-languageserver-bin/-/vscode-css-languageserver-bin-1.4.0.tgz',
  },
  {
    id: 'html-language-server',
    url: 'https://registry.npmjs.org/vscode-html-languageserver-bin/-/vscode-html-languageserver-bin-1.4.0.tgz',
  },
  {
    id: 'svelte-language-server',
    url: 'https://registry.npmjs.org/svelte-language-server/-/svelte-language-server-0.18.3.tgz',
  },
  {
    id: 'intelephense',
    url: 'https://registry.npmjs.org/intelephense/-/intelephense-1.12.0.tgz',
  },
  // gopls — Go module proxy (platform-independent source archive)
  {
    id: 'gopls',
    url: 'https://proxy.golang.org/golang.org/x/tools/gopls/@v/v0.16.2.zip',
  },
  // rust-analyzer — platform-specific GitHub releases
  {
    id: 'rust-analyzer',
    platform: 'linux-x64',
    url: 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-27/rust-analyzer-x86_64-unknown-linux-gnu.gz',
  },
  {
    id: 'rust-analyzer',
    platform: 'linux-arm64',
    url: 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-27/rust-analyzer-aarch64-unknown-linux-gnu.gz',
  },
  {
    id: 'rust-analyzer',
    platform: 'darwin-x64',
    url: 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-27/rust-analyzer-x86_64-apple-darwin.gz',
  },
  {
    id: 'rust-analyzer',
    platform: 'darwin-arm64',
    url: 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-27/rust-analyzer-aarch64-apple-darwin.gz',
  },
  // lua-language-server — platform-specific GitHub releases
  {
    id: 'lua-language-server',
    platform: 'linux-x64',
    url: 'https://github.com/LuaLS/lua-language-server/releases/download/3.10.6/lua-language-server-3.10.6-linux-x64.tar.gz',
  },
  {
    id: 'lua-language-server',
    platform: 'linux-arm64',
    url: 'https://github.com/LuaLS/lua-language-server/releases/download/3.10.6/lua-language-server-3.10.6-linux-arm64.tar.gz',
  },
  {
    id: 'lua-language-server',
    platform: 'darwin-x64',
    url: 'https://github.com/LuaLS/lua-language-server/releases/download/3.10.6/lua-language-server-3.10.6-darwin-x64.tar.gz',
  },
  {
    id: 'lua-language-server',
    platform: 'darwin-arm64',
    url: 'https://github.com/LuaLS/lua-language-server/releases/download/3.10.6/lua-language-server-3.10.6-darwin-arm64.tar.gz',
  },
];

async function computeHash(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText} (${url})`
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha512').update(buffer).digest('base64');
  return `sha512-${hash}`;
}

async function main() {
  const results = {};
  const errors = [];

  for (const entry of SERVERS) {
    const label = entry.platform ? `${entry.id} (${entry.platform})` : entry.id;
    process.stdout.write(`  ${label} … `);

    try {
      const integrity = await computeHash(entry.url);
      process.stdout.write(`OK\n`);

      if (entry.platform) {
        if (!results[entry.id]) {
          results[entry.id] = { platforms: {} };
        }
        results[entry.id].platforms[entry.platform] = {
          tarballUrl: entry.url,
          integrity,
        };
      } else {
        results[entry.id] = { integrity, tarballUrl: entry.url };
      }
    } catch (err) {
      process.stdout.write(`FAILED: ${err.message}\n`);
      errors.push({
        id: entry.id,
        platform: entry.platform,
        error: err.message,
      });
    }
  }

  // Print results as a JSON block for easy parsing.
  console.log('\n── Results ──────────────────────────────────────────────\n');
  console.log(JSON.stringify(results, null, 2));

  if (errors.length > 0) {
    console.log(
      '\n── Errors ────────────────────────────────────────────────\n'
    );
    for (const e of errors) {
      const label = e.platform ? `${e.id} (${e.platform})` : e.id;
      console.log(`  ${label}: ${e.error}`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
