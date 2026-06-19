import type { DronePlugin } from 'drone-core';
import { bootstrapProjectPlugin } from './bootstrap-project.js';
import {
  createCompactionPlugin,
  type CompactionPluginDeps,
} from './compaction/index.js';
import { execPlugin } from './exec.js';
import { fetchPlugin } from './fetch.js';
import { filePlugin } from './file.js';
import { gitPlugin } from './git.js';
import { lspPlugin } from './lsp.js';
import { mcpPlugin } from './mcp/index.js';
import { memoryPlugin } from './memory/index.js';
import { ollamaPlugin } from './ollama.js';
import { personaPlugin } from './persona/index.js';
import { searchPlugin } from './search.js';
import { skillsPlugin } from './skills/index.js';
import { startupPlugin } from './startup.js';
import { todoPlugin } from './todo.js';
import { utilsPlugin } from './utils.js';

// Static built-ins — everything except the compaction plugin, which needs
// access to the live engine and session manager. The CLI calls
// createBuiltInPlugins() to assemble the full list with the compaction plugin
// wired in.
const staticBuiltInPlugins: DronePlugin[] = [
  startupPlugin,
  execPlugin,
  todoPlugin,
  fetchPlugin,
  utilsPlugin,
  lspPlugin,
  mcpPlugin,
  ollamaPlugin,
  filePlugin,
  searchPlugin,
  gitPlugin,
  bootstrapProjectPlugin,
  personaPlugin,
  skillsPlugin,
  memoryPlugin,
];

export function createBuiltInPlugins(
  compactionDeps: CompactionPluginDeps
): DronePlugin[] {
  return [...staticBuiltInPlugins, createCompactionPlugin(compactionDeps)];
}

// Convenience for external consumers (and lib.ts) that want the list without
// wiring compaction — for example, an embedding harness that only registers
// tools and never starts a chat session. Pass createBuiltInPlugins(...) to
// get the full list with the compaction plugin wired.
export const builtInPlugins: DronePlugin[] = staticBuiltInPlugins;

export type { CompactionPluginDeps } from './compaction/index.js';
export type { CompactionCapability } from './compaction/index.js';
export { createCompactionPlugin } from './compaction/index.js';
