import type { SwarmApi } from './swarm-api.js';

export interface ParsedCommand {
  name: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  json: boolean;
}

export interface ConsoleRunInput {
  positionals: string[];
  flags: Record<string, string | boolean>;
  json: boolean;
  api: SwarmApi;
}

export interface ConsoleCommand {
  name: string;
  description: string;
  usage: string;
  valueFlags?: string[];
  run(input: ConsoleRunInput): Promise<string>;
}
