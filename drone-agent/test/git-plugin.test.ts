import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createDefaultAgentConfig,
  toToolResultContent,
  type DronePluginRegistration,
} from 'drone-core';
import { gitPlugin } from '../src/plugins/git/index.js';
import { silentLogger } from './helpers.js';

const execFileP = promisify(execFile);

let repoDir: string;
let defaultBranch: string;
const SEED = 'README.md'; // committed in beforeAll, used for modification tests

async function gitInRepo(args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  return stdout.trim();
}

/** Register the git plugin and return a name -> execute map. */
function captureGitTools(): Map<
  string,
  (i: Record<string, unknown>) => Promise<string>
> {
  const tools = new Map<
    string,
    (i: Record<string, unknown>) => Promise<string>
  >();
  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    registerTool: tool => {
      tools.set(tool.name, async (i: Record<string, unknown>) =>
        toToolResultContent(await tool.execute(i))
      );
    },
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerSlashCommand: () => {},
    registerWorkflow: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: <T>() => undefined as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };
  gitPlugin.register(registration);
  return tools;
}

beforeAll(async () => {
  repoDir = await mkdtemp(path.join(tmpdir(), 'drone-git-test-'));
  await gitInRepo(['init', '-q']);
  await gitInRepo(['config', 'user.email', 'test@example.com']);
  await gitInRepo(['config', 'user.name', 'Test']);
  // Seed an initial commit so branches/commits exist.
  await writeFile(path.join(repoDir, SEED), '# test\n');
  await gitInRepo(['add', SEED]);
  await gitInRepo(['commit', '-q', '-m', 'initial']);
  defaultBranch = await gitInRepo(['rev-parse', '--abbrev-ref', 'HEAD']);
});

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
});

describe('git plugin integration', () => {
  it('reports an unstaged modification under unstaged, NOT staged (regression)', async () => {
    const tools = captureGitTools();
    // Modify a tracked file so porcelain shows " M" (unstaged)
    await writeFile(path.join(repoDir, SEED), '# test\nmodified\n');

    const statusOut = JSON.parse(await tools.get('status')!({ cwd: repoDir }));
    expect(statusOut.unstaged).toContain('M README.md');
    expect(statusOut.staged).not.toContain('M README.md');
    expect(statusOut.staged).toEqual([]);

    await gitInRepo(['checkout', '--', SEED]);
  });

  it('add + commit stages only the selected file (no forced git add -A)', async () => {
    const tools = captureGitTools();
    const a = path.join(repoDir, 'a.txt');
    const b = path.join(repoDir, 'b.txt');
    await writeFile(a, 'a\n');
    await writeFile(b, 'b\n');

    // Add only a.txt -> staged as Added (A), b.txt stays untracked (??).
    await tools.get('add')!({ paths: ['a.txt'], cwd: repoDir });
    let status = JSON.parse(await tools.get('status')!({ cwd: repoDir }));
    expect(status.staged).toContain('A a.txt');
    expect(status.untracked).toContain('b.txt');

    // Commit (should commit only a.txt, leaving b.txt untracked)
    const commitOut = JSON.parse(
      await tools.get('commit')!({ message: 'add a', cwd: repoDir })
    );
    expect(commitOut.success).toBe(true);
    expect(commitOut.hash).toMatch(/^[a-f0-9]+$/);

    status = JSON.parse(await tools.get('status')!({ cwd: repoDir }));
    expect(status.staged).toEqual([]);
    expect(status.untracked).toContain('b.txt');

    await rm(b, { force: true });
  });

  it('commit with all:true stages tracked modifications', async () => {
    const tools = captureGitTools();
    // all:true maps to `git add -u`, which stages tracked modifications only
    await writeFile(path.join(repoDir, SEED), '# test\nall flag\n');
    const out = JSON.parse(
      await tools.get('commit')!({
        message: 'all flag commit',
        all: true,
        cwd: repoDir,
      })
    );
    expect(out.success).toBe(true);
    await gitInRepo(['checkout', '--', SEED]);
  });

  it('branch create + switch + delete', async () => {
    const tools = captureGitTools();
    const create = JSON.parse(
      await tools.get('branch')!({
        action: 'create',
        name: 'feature-x',
        cwd: repoDir,
      })
    );
    expect(create.action).toBe('create');

    const list = JSON.parse(
      await tools.get('branch')!({ action: 'list', cwd: repoDir })
    );
    expect(list.branches).toContain('feature-x');

    await tools.get('branch')!({
      action: 'switch',
      name: defaultBranch,
      cwd: repoDir,
    });
    const del = JSON.parse(
      await tools.get('branch')!({
        action: 'delete',
        name: 'feature-x',
        cwd: repoDir,
      })
    );
    expect(del.action).toBe('delete');
  });

  it('stash push + list + drop round-trip on a tracked modification', async () => {
    const tools = captureGitTools();
    // Modify a tracked file so there is something to stash.
    await writeFile(path.join(repoDir, SEED), '# test\nstash me\n');

    const push = JSON.parse(
      await tools.get('stash')!({
        action: 'push',
        message: 'wip',
        cwd: repoDir,
      })
    );
    expect(push.action).toBe('push');

    const list = JSON.parse(
      await tools.get('stash')!({ action: 'list', cwd: repoDir })
    );
    expect(list.files.length).toBeGreaterThan(0);

    const drop = JSON.parse(
      await tools.get('stash')!({ action: 'drop', index: 0, cwd: repoDir })
    );
    expect(drop.action).toBe('drop');
  });

  it('restore --staged unstages a newly added file', async () => {
    const tools = captureGitTools();
    const r = path.join(repoDir, 'restore-me.txt');
    await writeFile(r, 'stage then unstage\n');
    await tools.get('add')!({ paths: ['restore-me.txt'], cwd: repoDir });

    let status = JSON.parse(await tools.get('status')!({ cwd: repoDir }));
    expect(status.staged).toContain('A restore-me.txt');

    await tools.get('restore')!({
      staged: true,
      paths: ['restore-me.txt'],
      cwd: repoDir,
    });
    status = JSON.parse(await tools.get('status')!({ cwd: repoDir }));
    expect(status.staged).not.toContain('A restore-me.txt');
    expect(status.untracked).toContain('restore-me.txt');

    await rm(r, { force: true });
  });

  it('add returns non-empty file paths (tab-parsing bug regression)', async () => {
    const tools = captureGitTools();
    const a = path.join(repoDir, 'add-paths-a.txt');
    const b = path.join(repoDir, 'add-paths-b.txt');
    await writeFile(a, 'a\n');
    await writeFile(b, 'b\n');
    const addOut = JSON.parse(
      await tools.get('add')!({
        paths: ['add-paths-a.txt', 'add-paths-b.txt'],
        cwd: repoDir,
      })
    );
    const paths = addOut.files.map((f: { path: string }) => f.path).sort();
    expect(paths).toEqual(['add-paths-a.txt', 'add-paths-b.txt']);
    expect(addOut.files.every((f: { path: string }) => f.path.length > 0)).toBe(
      true
    );

    // Unstage so the working-tree removal below doesn't leave phantom
    // deletions in the index for subsequent tests.
    await gitInRepo([
      'restore',
      '--staged',
      'add-paths-a.txt',
      'add-paths-b.txt',
    ]);
    await rm(a, { force: true });
    await rm(b, { force: true });
  });

  it('add with no paths and no all:true throws (no silent staging)', async () => {
    const tools = captureGitTools();
    await expect(tools.get('add')!({ cwd: repoDir })).rejects.toThrow(
      /paths|all/
    );
    await expect(
      tools.get('add')!({ cwd: repoDir, all: false })
    ).rejects.toThrow(/paths|all/);
  });

  it('restore --staged reports via name-status and does NOT mislabel untracked', async () => {
    const tools = captureGitTools();
    const untracked = path.join(repoDir, 'untracked-restore.txt');
    // A tracked, staged modification (so unstaging leaves an unstaged diff).
    await writeFile(path.join(repoDir, SEED), '# test\nrestore-name-status\n');
    await gitInRepo(['add', SEED]);
    // An untracked file: porcelain would show "?? untracked-restore.txt".
    await writeFile(untracked, 'new\n');

    const out = JSON.parse(
      await tools.get('restore')!({
        staged: true,
        paths: [SEED],
        cwd: repoDir,
      })
    );
    // The staged SEED is unstaged, so `git diff --name-status` shows it as modified.
    expect(out.files).toContainEqual({ kind: 'modified', path: SEED });
    // The untracked file must NOT leak in as a (mislabeled) "modified" entry
    expect(
      out.files.some(
        (f: { path: string }) => f.path === 'untracked-restore.txt'
      )
    ).toBe(false);
    expect(out.files.every((f: { path: string }) => f.path.length > 0)).toBe(
      true
    );

    await gitInRepo(['checkout', '--', SEED]);
    await rm(untracked, { force: true });
  });

  it('restore with staged:true + discard:true throws (contradictory combo)', async () => {
    const tools = captureGitTools();
    await expect(
      tools.get('restore')!({
        staged: true,
        discard: true,
        paths: [SEED],
        cwd: repoDir,
      })
    ).rejects.toThrow(/contradictory/);
  });

  it('restore with discard:true but no paths throws', async () => {
    const tools = captureGitTools();
    await expect(
      tools.get('restore')!({ discard: true, cwd: repoDir })
    ).rejects.toThrow(/paths/);
  });

  it('log returns commit entries', async () => {
    const tools = captureGitTools();
    const log = JSON.parse(await tools.get('log')!({ cwd: repoDir }));
    expect(Array.isArray(log.entries)).toBe(true);
    expect(log.entries.length).toBeGreaterThan(0);
    expect(log.entries[0]).toHaveProperty('hash');
    expect(log.entries[0]).toHaveProperty('message');
  });
});
