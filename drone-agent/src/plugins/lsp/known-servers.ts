import type { DroneLspInstallSpec, DroneLspServerConfig } from 'drone-core';
import path from 'node:path';

export type KnownServerSpec = {
  id: string;
  language: string;
  command: string;
  args: string[];
  fileExtensions: string[];
  rootPatterns: string[];
  install?: DroneLspInstallSpec;
};

export const KNOWN_SERVER_SPECS: KnownServerSpec[] = [
  // ── TypeScript ─────────────────────────────────────────────────────
  {
    id: 'typescript',
    language: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    fileExtensions: [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mts',
      '.cts',
      '.mjs',
      '.cjs',
    ],
    rootPatterns: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    install: {
      type: 'npm',
      package: 'typescript-language-server',
      version: '5.3.0',
      tarballUrl:
        'https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-5.3.0.tgz',
      integrity:
        'sha512-5puofxZHgFdAYtfNpmwCAvgtaYgg8wrUnH30m7Ze3QuguId5RNRadKASpOpyDxTyUdAF51FjhTdjntLw/EuWcQ==',
      entryPoint: 'lib/cli.mjs',
    },
  },
  // ── Python (pyright — published to npm) ────────────────────────────
  {
    id: 'pyright',
    language: 'python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    fileExtensions: ['.py'],
    rootPatterns: [
      'pyproject.toml',
      'setup.py',
      'setup.cfg',
      'requirements.txt',
      'Pipfile',
    ],
    install: {
      type: 'npm',
      package: 'pyright',
      version: '1.1.389',
      tarballUrl: 'https://registry.npmjs.org/pyright/-/pyright-1.1.389.tgz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'langserver.index.js',
    },
  },
  // ── Rust (rust-analyzer — GitHub release) ───────────────────────────
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
      tarballUrl:
        'https://github.com/rust-lang/rust-analyzer/releases/download/2024-11-18/rust-analyzer-x86_64-unknown-linux-gnu.tar.gz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'rust-analyzer',
    },
  },
  // ── Go (gopls — Go module proxy) ───────────────────────────────────
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
      tarballUrl:
        'https://proxy.golang.org/golang.org/x/tools/gopls/@v/v0.16.2.tar.gz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'gopls',
    },
  },
  // ── Lua (lua-language-server — GitHub release) ─────────────────────
  {
    id: 'lua-language-server',
    language: 'lua',
    command: 'lua-language-server',
    args: [],
    fileExtensions: ['.lua'],
    rootPatterns: ['.luarc.json', '.luarc.jsonc'],
    install: {
      type: 'github-release',
      package: 'LuaLS/lua-language-server',
      version: '3.10.6',
      tarballUrl:
        'https://github.com/LuaLS/lua-language-server/releases/download/3.10.6/lua-language-server-3.10.6-linux-x64.tar.gz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'bin/lua-language-server',
    },
  },
  // ── Shell (bash-language-server — npm) ────────────────────────────
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
      tarballUrl:
        'https://registry.npmjs.org/bash-language-server/-/bash-language-server-5.1.8.tgz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'bin/bash-language-server',
    },
  },
  // ── YAML (yaml-language-server — npm) ──────────────────────────────
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
      tarballUrl:
        'https://registry.npmjs.org/yaml-language-server/-/yaml-language-server-1.15.0.tgz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'bin/yaml-language-server',
    },
  },
  // ── JSON (vscode-json-languageserver — npm) ────────────────────────
  {
    id: 'json-language-server',
    language: 'json',
    command: 'vscode-json-languageserver',
    args: ['--stdio'],
    fileExtensions: ['.json', '.jsonc'],
    rootPatterns: [],
    install: {
      type: 'npm',
      package: 'vscode-json-languageserver',
      version: '1.15.0',
      tarballUrl:
        'https://registry.npmjs.org/vscode-json-languageserver/-/vscode-json-languageserver-1.15.0.tgz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'bin/vscode-json-languageserver',
    },
  },
  // ── Dockerfile (dockerfile-language-server-nodejs — npm) ──────────
  {
    id: 'dockerfile-language-server',
    language: 'dockerfile',
    command: 'dockerfile-language-server-nodejs',
    args: ['--stdio'],
    fileExtensions: ['.dockerfile', 'Dockerfile'],
    rootPatterns: [],
    install: {
      type: 'npm',
      package: 'dockerfile-language-server-nodejs',
      version: '0.13.0',
      tarballUrl:
        'https://registry.npmjs.org/dockerfile-language-server-nodejs/-/dockerfile-language-server-nodejs-0.13.0.tgz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'bin/dockerfile-language-server-nodejs',
    },
  },
  // ── TOML (taplo — npm) ────────────────────────────────────────────
  {
    id: 'taplo',
    language: 'toml',
    command: 'taplo',
    args: ['lsp', '--stdio'],
    fileExtensions: ['.toml'],
    rootPatterns: [],
    install: {
      type: 'npm',
      package: 'taplo',
      version: '0.9.3',
      tarballUrl: 'https://registry.npmjs.org/taplo/-/taplo-0.9.3.tgz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'bin/taplo',
    },
  },
  // ── CSS / SCSS / Less (vscode-css-languageserver — npm) ────────────
  {
    id: 'css-language-server',
    language: 'css',
    command: 'vscode-css-languageserver',
    args: ['--stdio'],
    fileExtensions: ['.css', '.scss', '.less'],
    rootPatterns: [],
    install: {
      type: 'npm',
      package: 'vscode-css-languageserver',
      version: '1.15.0',
      tarballUrl:
        'https://registry.npmjs.org/vscode-css-languageserver/-/vscode-css-languageserver-1.15.0.tgz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'bin/vscode-css-languageserver',
    },
  },
  // ── HTML (vscode-html-languageserver — npm) ─────────────────────────
  {
    id: 'html-language-server',
    language: 'html',
    command: 'vscode-html-languageserver',
    args: ['--stdio'],
    fileExtensions: ['.html', '.htm'],
    rootPatterns: [],
    install: {
      type: 'npm',
      package: 'vscode-html-languageserver',
      version: '1.15.0',
      tarballUrl:
        'https://registry.npmjs.org/vscode-html-languageserver/-/vscode-html-languageserver-1.15.0.tgz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'bin/vscode-html-languageserver',
    },
  },
  // ── Svelte (svelte-language-server — npm) ──────────────────────────
  {
    id: 'svelte-language-server',
    language: 'svelte',
    command: 'svelte-language-server',
    args: ['--stdio'],
    fileExtensions: ['.svelte'],
    rootPatterns: ['svelte.config.js', 'svelte.config.cjs'],
    install: {
      type: 'npm',
      package: 'svelte-language-server',
      version: '1.0.0',
      tarballUrl:
        'https://registry.npmjs.org/svelte-language-server/-/svelte-language-server-1.0.0.tgz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'bin/svelte-language-server',
    },
  },
  // ── PHP (intelephense — npm) ──────────────────────────────────────
  {
    id: 'intelephense',
    language: 'php',
    command: 'intelephense',
    args: ['--stdio'],
    fileExtensions: ['.php'],
    rootPatterns: ['composer.json', '.php-cs-fixer.dist.php'],
    install: {
      type: 'npm',
      package: 'intelephense',
      version: '1.12.0',
      tarballUrl:
        'https://registry.npmjs.org/intelephense/-/intelephense-1.12.0.tgz',
      integrity:
        'sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000==',
      entryPoint: 'lib/intelephense.js',
    },
  },
];

export function getKnownServerSpec(
  language: string
): KnownServerSpec | undefined {
  return KNOWN_SERVER_SPECS.find(
    spec => spec.language === language || spec.id === language
  );
}

export function resolveLanguageId(
  filePath: string,
  fallbackLanguage: string
): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'javascriptreact';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'typescriptreact';
    default:
      return fallbackLanguage;
  }
}

export function formatServerDetail(config: DroneLspServerConfig): string {
  if (config.transport === 'tcp') {
    return `${config.host}:${config.port}`;
  }

  const args =
    config.args && config.args.length > 0 ? ` ${config.args.join(' ')}` : '';
  return `${config.command}${args}`;
}
