import type { DronePlugin } from 'drone-core';
import { execPlugin } from './exec.js';
import { fetchPlugin } from './fetch.js';
import { filePlugin } from './file.js';
import { gitPlugin } from './git.js';
import { lspPlugin } from './lsp.js';
import { mcpPlugin } from './mcp.js';
import { ollamaPlugin } from './ollama.js';
import { searchPlugin } from './search.js';
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
];
