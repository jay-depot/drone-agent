import { ListToolsBlock } from '../../tui/components/ListToolsBlock.js';
import { MountToolBlock } from '../../tui/components/MountToolBlock.js';
import { UnmountToolBlock } from '../../tui/components/UnmountToolBlock.js';
import type {
  DronePersonaCapability,
  RuntimeFlagRegistry,
  DronePlugin,
  DroneToolDefinition,
} from 'drone-core';
import { ToolMountingCache } from 'drone-core';
import { createStatusTool } from './tools/status.js';
import { createDiffTool } from './tools/diff.js';
import { createLogTool } from './tools/log.js';
import { createShowTool } from './tools/show.js';
import { createAddTool } from './tools/add.js';
import { createRestoreTool } from './tools/restore.js';
import { createCommitTool } from './tools/commit.js';
import { createBranchTool } from './tools/branch.js';
import { createStashTool } from './tools/stash.js';
import { createFetchTool } from './tools/fetch.js';
import { createPullTool } from './tools/pull.js';

const GIT_TOOL_DESCRIPTIONS: Array<{ name: string; description: string }> = [
  {
    name: 'status',
    description: 'Working tree status: staged, unstaged, and untracked files.',
  },
  { name: 'diff', description: 'Show a diff (unstaged or staged).' },
  { name: 'log', description: 'Recent commits: hash, author, date, message.' },
  {
    name: 'show',
    description: 'Show a git object (commit diff or file contents).',
  },
  { name: 'add', description: 'Stage changes (specific paths or all).' },
  {
    name: 'restore',
    description: 'Undo changes (unstage or discard worktree edits).',
  },
  { name: 'commit', description: 'Create a commit (does NOT auto-stage).' },
  {
    name: 'branch',
    description: 'Branch operations: list, create, switch, delete.',
  },
  {
    name: 'stash',
    description: 'Stash operations: list, push, pop, apply, drop, clear.',
  },
  { name: 'fetch', description: 'Download objects and refs from a remote.' },
  {
    name: 'pull',
    description: 'Fetch from a remote and integrate into the current branch.',
  },
];

export const gitPlugin: DronePlugin = {
  metadata: {
    id: 'git',
    name: 'Git',
    version: '0.3.0',
    description:
      'Git operations: status, diff, log, show, add, restore, commit, branch, stash, fetch, pull.',
    defaultEnabled: false,
    dependencies: [{ id: 'persona', optional: true }],
  },
  register: async registration => {
    const personaCap = registration.request<DronePersonaCapability>('persona');
    const runtime = registration.request<{ flags?: RuntimeFlagRegistry }>(
      'runtime'
    );
    runtime?.flags?.append('list-mount', 'git');
    const gitCache = new ToolMountingCache('git');

    // Build all tool definitions and add them to the cache
    const toolFactories: Array<() => DroneToolDefinition> = [
      createStatusTool,
      createDiffTool,
      createLogTool,
      createShowTool,
      createAddTool,
      createRestoreTool,
      createCommitTool,
      createBranchTool,
      createStashTool,
      createFetchTool,
      createPullTool,
    ];

    for (const factory of toolFactories) {
      const tool = factory();
      gitCache.addTool(tool.name, tool);
    }

    // ── Meta-tools ──────────────────────────────────────────────────────

    registration.registerTool({
      name: 'list_tools',
      description:
        'List all available git tools. Tools include: status, diff, log, show, add, restore, commit, branch, stash, fetch, pull. Mount the ones you need with git__mount_tool.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      renderComponent: state => ListToolsBlock({ state }),
      execute: async () => {
        let tools = GIT_TOOL_DESCRIPTIONS;
        if (personaCap) {
          const descriptors = tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: undefined,
            defaultHidden: false,
          }));
          const filtered = personaCap.getFilteredTools(descriptors);
          const filteredNames = new Set(filtered.map(t => t.name));
          tools = tools.filter(t => filteredNames.has(t.name));
        }
        return JSON.stringify({ toolCount: tools.length, tools }, null, 2);
      },
    });

    registration.registerTool({
      name: 'mount_tool',
      description:
        'Mount a specific git tool so it becomes available as a native tool. Use git__list_tools to see available tools. Once mounted, the tool will appear in your tool list with its full schema.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description:
              'The name of the tool to mount (as shown by git__list_tools).',
          },
        },
        required: ['tool'],
        additionalProperties: false,
      },
      renderComponent: state => MountToolBlock({ state }),
      execute: async input => {
        if (typeof input.tool !== 'string' || input.tool.trim().length === 0) {
          throw new Error('git__mount_tool requires a non-empty tool name.');
        }
        const toolName = input.tool.trim();
        const result = gitCache.mountTool(toolName, registration);
        if (!result) {
          return JSON.stringify(
            {
              success: false,
              error: `Unknown or already mounted tool: ${toolName}. Use git__list_tools to see available tools.`,
            },
            null,
            2
          );
        }
        return JSON.stringify(
          {
            success: true,
            tool: toolName,
            description: result.description,
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'unmount_tool',
      description:
        'Unmount a previously mounted git tool. This removes the tool from your active tool list to reduce clutter.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description:
              'The name of the tool to unmount (as shown by git__list_tools).',
          },
        },
        required: ['tool'],
        additionalProperties: false,
      },
      renderComponent: state => UnmountToolBlock({ state }),
      execute: async input => {
        if (typeof input.tool !== 'string' || input.tool.trim().length === 0) {
          throw new Error('git__unmount_tool requires a non-empty tool name.');
        }
        const toolName = input.tool.trim();
        gitCache.unmountTool(toolName, registration);
        return JSON.stringify({ success: true, tool: toolName }, null, 2);
      },
    });
  },
};

export default gitPlugin;
