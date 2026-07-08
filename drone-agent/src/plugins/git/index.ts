import type { DronePlugin } from 'drone-core';
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
    version: '0.2.0',
    description:
      'Git operations: status, diff, log, show, add, restore, commit, branch, stash, fetch, pull.',
    defaultEnabled: false,
  },
  register: async registration => {
    // Read-only
    registration.registerTool(createStatusTool());
    registration.registerTool(createDiffTool());
    registration.registerTool(createLogTool());
    registration.registerTool(createShowTool());
    // Local write
    registration.registerTool(createAddTool());
    registration.registerTool(createRestoreTool());
    registration.registerTool(createCommitTool());
    registration.registerTool(createBranchTool());
    registration.registerTool(createStashTool());
    // Remote (no push)
    registration.registerTool(createFetchTool());
    registration.registerTool(createPullTool());
  },
};

export default gitPlugin;
