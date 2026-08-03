import type { DronePlugin, DroneToolDefinition } from 'drone-core';
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

export const gitPlugin: DronePlugin = {
  metadata: {
    id: 'git',
    name: 'Git',
    version: '0.3.0',
    description:
      'Git operations: status, diff, log, show, add, restore, commit, branch, stash, fetch, pull.',
    defaultEnabled: false,
  },
  register: async registration => {
    // Build all tool definitions and register them directly
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
      registration.registerTool(tool);
    }
  },
};

export default gitPlugin;
