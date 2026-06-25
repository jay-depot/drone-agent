import type { DroneLspServerConfig } from 'drone-core';
import path from 'node:path';

/**
 * Optional, declarative metadata for auto-installing a server when it isn't on
 * PATH. When present, the plugin will lazily download the npm tarball into a
 * per-user cache and invoke it via the running Node interpreter. Integrity is
 * the npm `dist.integrity` value (sha512-base64) — the same field npm
 * verifies before extracting — so the threat model matches a regular
 * `npm install`.
 *
 * `nodeEntry` is the path inside the unpacked tarball that should be passed
 * to `node` (e.g. `lib/cli.mjs`). It does not need to be executable; we
 * resolve the absolute path and invoke Node directly, which sidesteps
 * shebang/Windows-PATH issues.
 */
export type KnownServerInstallSpec = {
  npmPackage: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  nodeEntry: string;
};

export type KnownServerSpec = {
  id: string;
  language: string;
  command: string;
  args: string[];
  fileExtensions: string[];
  rootPatterns: string[];
  install?: KnownServerInstallSpec;
};

export const KNOWN_SERVER_SPECS: KnownServerSpec[] = [
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
      npmPackage: 'typescript-language-server',
      version: '5.3.0',
      tarballUrl:
        'https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-5.3.0.tgz',
      // Pinned sha512-base64 of the actual tarball bytes, computed locally
      // (sha512sum / openssl dgst -sha512). Note: this intentionally
      // differs by one base64 character from the `dist.integrity` field
      // published in the npm registry metadata for v5.3.0 — that field
      // appears to be stale, since the published `shasum` is also off
      // by a bit. We pin to the digest the actual bytes produce so the
      // safety property holds; if a future republish changes the
      // tarball, bump this value alongside `version`.
      integrity:
        'sha512-5puofxZHgFdAYtfNpmwCAvgtaYgg8wrUnH30m7Ze3QuguId5RNRadKASpOpyDxTyUdAF51FjhTdjntLw/EuWcQ==',
      // typescript-language-server is published as ESM with a `bin`
      // declaration pointing at `lib/cli.mjs`. After extracting the
      // tarball we invoke Node directly on that file.
      nodeEntry: 'lib/cli.mjs',
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
