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
        'sha512-EYt7yRtG6R6I3C3Wfa6O4tOPnbnN7e3ZG4BF9ZiyY6xs1hJGq2ymINyuWC+da0hPNebuMGkY7vvCnD+R7wwbdg==',
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
      version: '2026-07-27',
      tarballUrl:
        'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-27/rust-analyzer-x86_64-unknown-linux-gnu.gz',
      integrity:
        'sha512-ZYGRwpqop78m3jrSDStDCil2yehUrVMZV/vd14IYi9hc3ty9AFnvQffQ4UaSyOBGDThQ5rrFMFKdcw3HDFD90Q==',
      entryPoint: 'rust-analyzer',
      platforms: {
        'linux-x64': {
          tarballUrl:
            'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-27/rust-analyzer-x86_64-unknown-linux-gnu.gz',
          integrity:
            'sha512-ZYGRwpqop78m3jrSDStDCil2yehUrVMZV/vd14IYi9hc3ty9AFnvQffQ4UaSyOBGDThQ5rrFMFKdcw3HDFD90Q==',
        },
        'linux-arm64': {
          tarballUrl:
            'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-27/rust-analyzer-aarch64-unknown-linux-gnu.gz',
          integrity:
            'sha512-uaS7HVmkzNTQ/8ZOYtB/kILw9HNbN7YhIX9yKVc2lbza4pWv8mzUgYd2cFnfFoDMEqidRLJdNStbGMcRJ9+Ryw==',
        },
        'darwin-x64': {
          tarballUrl:
            'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-27/rust-analyzer-x86_64-apple-darwin.gz',
          integrity:
            'sha512-Db+tF1jeaitfLIBzNM2JFOMfHVIdRM7rCQK/JunXGvd9qiNg5efIvUmaji1cYMLU5gnciu/bumogJK9ynFqzxw==',
        },
        'darwin-arm64': {
          tarballUrl:
            'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-27/rust-analyzer-aarch64-apple-darwin.gz',
          integrity:
            'sha512-R64KDpY6xhfYxogu6cv0xZiCN2Y0MvZE07jMo2sU20IGp80SCnekHPrXwPWlGje8I31X9+oLj8PTfNhtFaLmlQ==',
        },
      },
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
        'https://proxy.golang.org/golang.org/x/tools/gopls/@v/v0.16.2.zip',
      integrity:
        'sha512-t7g6lUhjOjVcVzWFwkdy63fXdSkmvx6EeWXsj1hS4u11361uruiiUxMfiS13sR+An7lnXN2dP6PrpU2+965V9g==',
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
        'sha512-LMgX+3WYuSBdGxAxXG1r+8grQz7rY2Gr3zJAXB29hxH9y/vgILk/rF2hPmLGAiPch7PKX8yevdeerV1WYow+7Q==',
      entryPoint: 'lua-language-server',
      platforms: {
        'linux-x64': {
          tarballUrl:
            'https://github.com/LuaLS/lua-language-server/releases/download/3.10.6/lua-language-server-3.10.6-linux-x64.tar.gz',
          integrity:
            'sha512-LMgX+3WYuSBdGxAxXG1r+8grQz7rY2Gr3zJAXB29hxH9y/vgILk/rF2hPmLGAiPch7PKX8yevdeerV1WYow+7Q==',
        },
        'linux-arm64': {
          tarballUrl:
            'https://github.com/LuaLS/lua-language-server/releases/download/3.10.6/lua-language-server-3.10.6-linux-arm64.tar.gz',
          integrity:
            'sha512-mvvjfBOQ3OnkYNlGSsqQF8eHAjaD/I0b1BUVGjOoA+Gbcl22MinGq9BL56CjGI0WMYObgHsVVsTJRkNMmuoK3Q==',
        },
        'darwin-x64': {
          tarballUrl:
            'https://github.com/LuaLS/lua-language-server/releases/download/3.10.6/lua-language-server-3.10.6-darwin-x64.tar.gz',
          integrity:
            'sha512-ZHVpC7grJZ3yadTWVeWbmJIf3DtLJ6lk6I2ncr8Fn+N8dBoTLUwnNmx5P6HDf+kIx+oeM2eMIAzpNhXbEPpdVQ==',
        },
        'darwin-arm64': {
          tarballUrl:
            'https://github.com/LuaLS/lua-language-server/releases/download/3.10.6/lua-language-server-3.10.6-darwin-arm64.tar.gz',
          integrity:
            'sha512-3K7kgqj09n2bSDFP9iby0hJYF52Lw4i4FU7hRXRco6V9tnY0UK9NRb82r6wxdKSRunkRozXLLbBPUsEyekG9Pg==',
        },
      },
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
      version: '5.6.0',
      tarballUrl:
        'https://registry.npmjs.org/bash-language-server/-/bash-language-server-5.6.0.tgz',
      integrity:
        'sha512-DCuV+/BZAAozsp5blvi6jDnU/ZDaTpJpWM0zqwGjnirfqv7iBsMK32xOze/jipxU0PUZ6CBUKgRUMKI7Kk70Lg==',
      entryPoint: 'out/cli.js',
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
        'sha512-N47AqBDCMQmh6mBLmI6oqxryHRzi33aPFPsJhYy3VTUGCdLHYjGh4FZzpUjRlphaADBBkDmnkM/++KNIOHi5Rw==',
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
      package: 'vscode-langservers-extracted',
      version: '4.10.0',
      tarballUrl:
        'https://registry.npmjs.org/vscode-langservers-extracted/-/vscode-langservers-extracted-4.10.0.tgz',
      integrity:
        'sha512-EFf9uQI4dAKbzMQFjDvVm1xJq1DXAQvBEuEfPGrK/xzfsL5xWTfIuRr90NgfmqwO+IEt6vLZm9EOj6R66xIifg==',
      entryPoint: 'bin/vscode-json-language-server',
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
        'sha512-r8GwQGVBHuRj83nFYoA7ulGfp6tgUH8gxlPRap0ewuroEb/XgP4KtLsIUIN9CvkTZge/IkX7cbFTVO0lq9gZ3A==',
      entryPoint: 'bin/docker-langserver',
    },
  },
  // ── TOML (taplo — GitHub release) ──────────────────────────────────
  {
    id: 'taplo',
    language: 'toml',
    command: 'taplo',
    args: ['lsp', 'stdio'],
    fileExtensions: ['.toml'],
    rootPatterns: [],
    install: {
      type: 'github-release',
      package: 'tamasfe/taplo',
      version: '0.10.0',
      tarballUrl:
        'https://github.com/tamasfe/taplo/releases/download/0.10.0/taplo-linux-x86_64.gz',
      integrity:
        'sha512-/os53J3GCLEsw9oh2va8MFHqMC0kAy3aeFHJKu1osccMFpbFmDN0i3WQdKtCBFwrkUglg8E7x8+ma9QjssistA==',
      entryPoint: 'taplo',
      platforms: {
        'linux-x64': {
          tarballUrl:
            'https://github.com/tamasfe/taplo/releases/download/0.10.0/taplo-linux-x86_64.gz',
          integrity:
            'sha512-/os53J3GCLEsw9oh2va8MFHqMC0kAy3aeFHJKu1osccMFpbFmDN0i3WQdKtCBFwrkUglg8E7x8+ma9QjssistA==',
        },
      },
    },
  },
  // ── CSS / SCSS / Less (vscode-css-languageserver-bin — npm) ────────
  {
    id: 'css-language-server',
    language: 'css',
    command: 'css-languageserver',
    args: ['--stdio'],
    fileExtensions: ['.css', '.scss', '.less'],
    rootPatterns: [],
    install: {
      type: 'npm',
      package: 'vscode-langservers-extracted',
      version: '4.10.0',
      tarballUrl:
        'https://registry.npmjs.org/vscode-langservers-extracted/-/vscode-langservers-extracted-4.10.0.tgz',
      integrity:
        'sha512-EFf9uQI4dAKbzMQFjDvVm1xJq1DXAQvBEuEfPGrK/xzfsL5xWTfIuRr90NgfmqwO+IEt6vLZm9EOj6R66xIifg==',
      entryPoint: 'bin/vscode-css-language-server',
    },
  },
  // ── HTML (vscode-html-languageserver-bin — npm) ─────────────────────
  {
    id: 'html-language-server',
    language: 'html',
    command: 'html-languageserver',
    args: ['--stdio'],
    fileExtensions: ['.html', '.htm'],
    rootPatterns: [],
    install: {
      type: 'npm',
      package: 'vscode-langservers-extracted',
      version: '4.10.0',
      tarballUrl:
        'https://registry.npmjs.org/vscode-langservers-extracted/-/vscode-langservers-extracted-4.10.0.tgz',
      integrity:
        'sha512-EFf9uQI4dAKbzMQFjDvVm1xJq1DXAQvBEuEfPGrK/xzfsL5xWTfIuRr90NgfmqwO+IEt6vLZm9EOj6R66xIifg==',
      entryPoint: 'bin/vscode-html-language-server',
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
      version: '0.18.3',
      tarballUrl:
        'https://registry.npmjs.org/svelte-language-server/-/svelte-language-server-0.18.3.tgz',
      integrity:
        'sha512-60hbZVquRLjP/VIU3BS82IXQDT4JsDIJ15NvcnlMimy6tQfAkAv+og3SXGP3IT7TlaPdCrqmFe/kjOQOKtWTfw==',
      entryPoint: 'bin/server.js',
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
        'sha512-Bgh8yBn3WYUDymJTtg+2I/eblksJncHKKgom9iPX0jdDoo9mnEooYubRESbMLQ/fG/96PHmY/s2BZhzNNsPYtg==',
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
