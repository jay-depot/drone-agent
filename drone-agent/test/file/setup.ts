import { filePlugin, __testing } from '../../src/plugins/file.js';
import {
  createDefaultAgentConfig,
  toToolResultContent,
  type DronePluginRegistration,
  type DroneToolResult,
} from 'drone-core';
import { silentLogger } from '../helpers.js';
import type {
  ChangeZoneLine,
  PatchHunk,
} from '../../src/shared/patch-applier.js';

export const { enhanceFsError } = __testing;

/**
 * Build a PatchHunk with a default empty changeZone. Most test hunks have no
 * interleaved context, so this keeps the literals concise. Pass `changeZone`
 * explicitly when the test needs interleaved context.
 */
export function makeHunk(
  h: Omit<PatchHunk, 'changeZone'> & { changeZone?: ChangeZoneLine[] }
): PatchHunk {
  return { changeZone: [], ...h };
}

/**
 * Register the file plugin against a minimal in-memory registration and
 * capture its tools (string-wrapped and raw), help text, and prompt
 * fragments for assertions.
 */
export function captureRegistration(): {
  registration: DronePluginRegistration;
  tools: Map<string, (input: Record<string, unknown>) => Promise<string>>;
  rawTools: Map<
    string,
    (input: Record<string, unknown>) => Promise<string | DroneToolResult>
  >;
  helpText: string[];
  promptFragments: Array<{
    key: string;
    render: () => Promise<string | false>;
  }>;
} {
  const tools = new Map<
    string,
    (input: Record<string, unknown>) => Promise<string>
  >();
  const rawTools = new Map<
    string,
    (input: Record<string, unknown>) => Promise<string | DroneToolResult>
  >();
  const helpText: string[] = [];
  const promptFragments: Array<{
    key: string;
    render: () => Promise<string | false>;
  }> = [];

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    registerTool: tool => {
      rawTools.set(tool.name, tool.execute);
      tools.set(tool.name, async (input: Record<string, unknown>) =>
        toToolResultContent(await tool.execute(input))
      );
    },
    registerPromptFragment: fragment => {
      promptFragments.push(fragment);
    },
    registerHelp: help => {
      helpText.push(help);
    },
    registerSlashCommand: () => {},
    registerWorkflow: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
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
    getCliFlags: () => ({}),
    requestElicitation: () => undefined,
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    emitEvent: () => {},
  };

  return { registration, tools, rawTools, helpText, promptFragments };
}

/**
 * Register the file plugin via {@link captureRegistration} and return the
 * captured tool maps, ready to call.
 */
export async function registerFilePlugin(): Promise<{
  tools: Map<string, (input: Record<string, unknown>) => Promise<string>>;
  rawTools: Map<
    string,
    (input: Record<string, unknown>) => Promise<string | DroneToolResult>
  >;
}> {
  const { registration, tools, rawTools } = captureRegistration();
  await filePlugin.register(registration);
  return { tools, rawTools };
}
