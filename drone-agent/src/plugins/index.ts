import type { DronePlugin } from 'drone-core';
import { bootstrapPlugin } from './bootstrap/index.js';
import { configPlugin } from './config/index.js';
import {
  createCompactionPlugin,
  type CompactionPluginDeps,
} from './compaction/index.js';
import { createLogPlugin } from './log/index.js';
import { execPlugin } from './exec.js';
import { echoPlugin } from './echo/index.js';
import { terminalPlugin } from './terminal/index.js';
import { fetchPlugin } from './fetch.js';
import { filePlugin } from './file.js';
import { gitPlugin } from './git/index.js';
import { llmPlugin } from './llm/index.js';
import { lspPlugin } from './lsp/plugin.js';
import { mcpPlugin } from './mcp/index.js';
import { memoryPlugin } from './memory/index.js';
import { notepadPlugin } from './notepad.js';
import { ollamaPlugin } from './ollama.js';
import { anthropicPlugin } from './anthropic/index.js';
import { openaiPlugin } from './openai/index.js';
import { openrouterPlugin } from './openrouter/index.js';
import { personaPlugin } from './persona/index.js';
import { personaProviderProjectPlugin } from './persona-provider-project/index.js';
import { personaProviderUserPlugin } from './persona-provider-user/index.js';
import { searchPlugin } from './search/index.js';
import { macrosPlugin } from './macros/index.js';
import { selfImprovementPlugin } from './self-improvement/index.js';
import { skillsPlugin } from './skills/index.js';
import { skillProviderProjectPlugin } from './skill-provider-project/index.js';
import { promptFilePlugin } from './prompt-file/index.js';
import { skillProviderUserPlugin } from './skill-provider-user/index.js';
import { lightpandaPlugin } from './lightpanda/index.js';
import { startupPlugin } from './startup.js';
// NEW:
import { subagentPlugin } from './subagent/index.js';
import { swarmPlugin } from './swarm/index.js';
import { todoPlugin } from './todo/index.js';
import { utilsPlugin } from './utils.js';
import { focusPlugin } from './focus.js';

// Static built-ins — everything except the compaction plugin, which needs
// access to the live engine and session manager. The CLI calls
// createBuiltInPlugins() to assemble the full list with the compaction plugin
// wired in.
const staticBuiltInPlugins: DronePlugin[] = [
  notepadPlugin,
  subagentPlugin, // NEW
  startupPlugin,
  terminalPlugin,
  configPlugin,
  execPlugin,
  echoPlugin,
  lightpandaPlugin,
  todoPlugin,
  focusPlugin,
  fetchPlugin,
  utilsPlugin,
  macrosPlugin,
  llmPlugin,
  lspPlugin,
  mcpPlugin,
  ollamaPlugin,
  anthropicPlugin,
  openaiPlugin,
  openrouterPlugin,
  filePlugin,
  searchPlugin,
  gitPlugin,
  bootstrapPlugin,
  personaPlugin,
  personaProviderProjectPlugin,
  personaProviderUserPlugin,
  skillsPlugin,
  skillProviderProjectPlugin,
  skillProviderUserPlugin,
  selfImprovementPlugin,
  memoryPlugin,
  promptFilePlugin,
  swarmPlugin,
];

export function createBuiltInPlugins(
  compactionDeps: CompactionPluginDeps
): DronePlugin[] {
  return [
    ...staticBuiltInPlugins,
    createCompactionPlugin(compactionDeps),
    createLogPlugin(compactionDeps),
  ];
}

// Convenience for external consumers (and lib.ts) that want the list without
// wiring compaction — for example, an embedding harness that only registers
// tools and never starts a chat session. Pass createBuiltInPlugins(...) to
// get the full list with the compaction plugin wired.
export const builtInPlugins: DronePlugin[] = staticBuiltInPlugins;

export type { CompactionPluginDeps } from './compaction/index.js';
export type { CompactionCapability } from './compaction/index.js';
export type { CompactionStatus } from './compaction/index.js';
export { createCompactionPlugin } from './compaction/index.js';
export { createLogPlugin } from './log/index.js';
export { createSwarmPlugin, type SwarmConfig } from './swarm/index.js';
