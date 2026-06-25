import { readdir, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type ProjectAnalysis = {
  cwd: string;
  isHomeDirectory: boolean;
  language: string | null;
  framework: string | null;
  buildSystem: string | null;
  hasGit: boolean;
  hasLspConfig: boolean;
  hasDroneConfig: boolean;
  hasAgentsMd: boolean;
  suggestedPlugins: string[];
  detectedFiles: string[];
};

export async function detectProject(cwd: string): Promise<ProjectAnalysis> {
  const homeDir = os.homedir();
  const resolvedCwd = path.resolve(cwd);
  const isHomeDirectory = resolvedCwd === path.resolve(homeDir);

  const detectedFiles: string[] = [];
  let language: string | null = null;
  let framework: string | null = null;
  let buildSystem: string | null = null;
  let hasGit = false;
  let hasLspConfig = false;
  let hasDroneConfig = false;
  let hasAgentsMd = false;

  // Read top-level entries
  let entries: string[] = [];
  try {
    entries = await readdir(resolvedCwd);
  } catch {
    // Directory may not be readable
  }

  const entrySet = new Set(entries);

  // Language / framework detection
  if (entrySet.has('package.json')) {
    detectedFiles.push('package.json');
    language = 'JavaScript/TypeScript';
    // Peek at package.json for framework hints
    try {
      const pkgRaw = await importFsRead(resolvedCwd, 'package.json');
      if (pkgRaw) {
        const pkg = JSON.parse(pkgRaw);
        if (pkg.dependencies?.next || pkg.devDependencies?.next) {
          framework = 'Next.js';
        } else if (pkg.dependencies?.react || pkg.devDependencies?.react) {
          framework = 'React';
        } else if (pkg.dependencies?.vue || pkg.devDependencies?.vue) {
          framework = 'Vue';
        } else if (pkg.dependencies?.express || pkg.devDependencies?.express) {
          framework = 'Express';
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  if (entrySet.has('Cargo.toml')) {
    detectedFiles.push('Cargo.toml');
    language = 'Rust';
  }

  if (
    entrySet.has('pyproject.toml') ||
    entrySet.has('setup.py') ||
    entrySet.has('setup.cfg')
  ) {
    if (entrySet.has('pyproject.toml')) detectedFiles.push('pyproject.toml');
    if (entrySet.has('setup.py')) detectedFiles.push('setup.py');
    if (entrySet.has('setup.cfg')) detectedFiles.push('setup.cfg');
    language = 'Python';
  }

  if (entrySet.has('go.mod')) {
    detectedFiles.push('go.mod');
    language = 'Go';
  }

  if (entrySet.has('Gemfile')) {
    detectedFiles.push('Gemfile');
    language = 'Ruby';
  }

  if (entrySet.has('CMakeLists.txt')) {
    detectedFiles.push('CMakeLists.txt');
    language = 'C/C++';
  }

  if (entrySet.has('composer.json')) {
    detectedFiles.push('composer.json');
    language = 'PHP';
  }

  if (entrySet.has('project.clj')) {
    detectedFiles.push('project.clj');
    language = 'Clojure';
  }

  if (entrySet.has('mix.exs')) {
    detectedFiles.push('mix.exs');
    language = 'Elixir';
  }

  // .NET / C# — look for .sln files
  const slnFiles = entries.filter(e => e.endsWith('.sln'));
  if (slnFiles.length > 0) {
    detectedFiles.push(...slnFiles);
    if (!language) language = 'C#/.NET';
  }

  // Build system detection
  if (entrySet.has('tsconfig.json')) {
    detectedFiles.push('tsconfig.json');
    buildSystem = 'TypeScript';
  }
  if (entries.some(e => /^vite\.config\./.test(e))) {
    const viteFile = entries.find(e => /^vite\.config\./.test(e))!;
    detectedFiles.push(viteFile);
    buildSystem = 'Vite';
  }
  if (entries.some(e => /^webpack\.config\./.test(e))) {
    const wpFile = entries.find(e => /^webpack\.config\./.test(e))!;
    detectedFiles.push(wpFile);
    buildSystem = 'Webpack';
  }
  if (entrySet.has('Makefile')) {
    detectedFiles.push('Makefile');
    if (!buildSystem) buildSystem = 'Make';
  }

  // VCS
  if (entrySet.has('.git') || entrySet.has('.gitignore')) {
    hasGit = true;
  }

  // LSP config
  if (
    entrySet.has('tsconfig.json') ||
    entrySet.has('pyrightconfig.json') ||
    entrySet.has('.clangd') ||
    entrySet.has('.vimspector.json')
  ) {
    hasLspConfig = true;
  }

  // Drone config
  try {
    await access(
      path.join(resolvedCwd, '.drone-agent', 'config.json'),
      fsConstants.F_OK
    );
    hasDroneConfig = true;
    detectedFiles.push('.drone-agent/config.json');
  } catch {
    // Not configured yet
  }

  // AGENTS.md
  for (const candidate of ['AGENTS.md', '.opencode/AGENTS.md']) {
    try {
      await access(path.join(resolvedCwd, candidate), fsConstants.F_OK);
      hasAgentsMd = true;
      detectedFiles.push(candidate);
      break;
    } catch {
      // Not found
    }
  }

  // Build suggested plugins
  const suggestedPlugins: string[] = [];
  if (hasGit) suggestedPlugins.push('git');
  if (hasLspConfig) suggestedPlugins.push('lsp');
  suggestedPlugins.push('file');
  suggestedPlugins.push('search');
  if (language === 'JavaScript/TypeScript') {
    suggestedPlugins.push('exec');
  }

  return {
    cwd: resolvedCwd,
    isHomeDirectory,
    language,
    framework,
    buildSystem,
    hasGit,
    hasLspConfig,
    hasDroneConfig,
    hasAgentsMd,
    suggestedPlugins: [...new Set(suggestedPlugins)],
    detectedFiles,
  };
}

async function importFsRead(
  dir: string,
  fileName: string
): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path.join(dir, fileName), 'utf-8');
  } catch {
    return null;
  }
}
