import type { DronePlugin } from 'drone-core';
import { bootstrapProjectPlugin } from './bootstrap-project.js';
import { execPlugin } from './exec.js';
import { fetchPlugin } from './fetch.js';
import { filePlugin } from './file.js';
import { gitPlugin } from './git.js';
import { lspPlugin } from './lsp.js';
import { mcpPlugin } from './mcp/index.js';
import { ollamaPlugin } from './ollama.js';
import { personaPlugin } from './persona/index.js';
import { searchPlugin } from './search.js';
import { skillsPlugin } from './skills/index.js';
import { startupPlugin } from './startup.js';
import { todoPlugin } from './todo.js';
import { utilsPlugin } from './utils.js';

export const builtInPlugins: DronePlugin[] = [
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
];
