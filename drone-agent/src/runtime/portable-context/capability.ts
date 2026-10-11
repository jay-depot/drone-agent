// ── Portable-context capability ─────────────────────────────────────
//
// The engine-seeded `portable-context` capability: export a session's context
// to a versioned JSON document, and restore one as a brand-new session
// (recycle → restore turns → restore plugin data → remount tools → disclosure).
//
// See ADR 246.

import type {
  DroneConversationEvent,
  DroneLogger,
  DronePortableContextCapability,
  DronePortableContextContributor,
  DronePortableContextExport,
  DronePortableContextImportResult,
  DronePortableContextSessionTurn,
  DronePortableContextTool,
  DroneSessionMessage,
  DroneSessionTurn,
  DroneToolDescriptor,
} from 'drone-core';
import {
  CURRENT_CONTEXT_SCHEMA_VERSION,
  MAX_CONTEXT_SCHEMA_VERSION,
  MIN_CONTEXT_SCHEMA_VERSION,
} from 'drone-core';

export type PortableContextDeps = {
  sessionManager: {
    getTurns: () => DroneSessionTurn[];
    appendTurns: (turns: DronePortableContextSessionTurn[]) => void;
    appendUserMessage: (content: string) => void;
  };
  listAllTools: () => DroneToolDescriptor[];
  listMountedTools: () => DroneToolDescriptor[];
  /** Mount a tool by canonical name. Returns the definition if newly mounted. */
  mountTool: (canonicalName: string) => unknown;
  /** Whether a tool is currently registered (mounted or not). */
  isToolRegistered: (canonicalName: string) => boolean;
  /** The clear boundary + session-id mint. */
  clearSession: () => Promise<void>;
  getSessionId: () => string;
  emitEvent: (event: DroneConversationEvent) => void;
  logger: DroneLogger;
};

function toolSnapshot(
  tool: DroneToolDescriptor,
  mountedNames: Set<string>
): DronePortableContextTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    defaultHidden: tool.defaultHidden,
    mounted: mountedNames.has(tool.name),
  };
}

function buildContinuationDisclosure(
  sourceSessionId: string,
  createdAt: string,
  unavailableTools: string[]
): string {
  const lines: string[] = [
    '<system-reminder>',
    `The preceding was restored from a prior checkpoint taken from session ${sourceSessionId} at ${createdAt}.`,
  ];
  if (unavailableTools.length > 0) {
    lines.push('');
    lines.push(
      `The following tools were mounted in the prior session but are not currently available: ${unavailableTools.join(
        ', '
      )}.`
    );
  }
  lines.push('</system-reminder>');
  return lines.join('\n');
}

function restoredTurnContext(
  turns: DronePortableContextSessionTurn[]
): DroneSessionTurn[] {
  return turns.map(turn => ({
    id: '',
    messages: turn.messages,
    kind: turn.kind,
  }));
}

export function createPortableContextCapability(
  deps: PortableContextDeps
): DronePortableContextCapability {
  const contributors = new Map<string, DronePortableContextContributor>();

  async function exportContext(): Promise<DronePortableContextExport> {
    const turns = deps.sessionManager.getTurns();
    const mountedNames = new Set(deps.listMountedTools().map(tool => tool.name));
    const tools = deps
      .listAllTools()
      .map(tool => toolSnapshot(tool, mountedNames));

    const pluginData: Record<string, unknown> = {};
    for (const contributor of contributors.values()) {
      try {
        const value = await contributor.export({ turns });
        if (value !== undefined) {
          pluginData[contributor.id] = value;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.warn(
          `portable-context export failed for ${contributor.id}: ${message}`
        );
      }
    }

    return {
      version: CURRENT_CONTEXT_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      session: {
        sourceSessionId: deps.getSessionId(),
        turns: turns.map(turn => ({
          kind: turn.kind,
          messages: turn.messages as DroneSessionMessage[],
        })),
      },
      tools,
      pluginData,
    };
  }

  async function importContext(
    data: DronePortableContextExport
  ): Promise<DronePortableContextImportResult> {
    if (
      typeof data.version !== 'number' ||
      data.version < MIN_CONTEXT_SCHEMA_VERSION ||
      data.version > MAX_CONTEXT_SCHEMA_VERSION
    ) {
      throw new Error(
        `Unsupported portable-context version ${String(
          data.version
        )}; this build supports versions ${MIN_CONTEXT_SCHEMA_VERSION}–${MAX_CONTEXT_SCHEMA_VERSION}.`
      );
    }

    // The clear boundary self-gates on an empty outgoing session, so importing
    // into an empty session fires no recycle hooks and mints no new id.
    await deps.clearSession();

    const restoredTurns = data.session.turns.map(turn => ({
      kind: turn.kind,
      messages: turn.messages,
    }));
    deps.sessionManager.appendTurns(restoredTurns);
    const readContext = { turns: restoredTurnContext(restoredTurns) };

    const warnings: string[] = [];
    for (const contributor of contributors.values()) {
      if (!(contributor.id in data.pluginData) || !contributor.import) {
        continue;
      }
      try {
        await contributor.import(data.pluginData[contributor.id], readContext);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`${contributor.id}: ${message}`);
      }
    }

    const knownKeys = new Set(contributors.keys());
    for (const key of Object.keys(data.pluginData)) {
      if (!knownKeys.has(key)) {
        warnings.push(`unknown pluginData key ignored: ${key}`);
      }
    }

    const unavailableTools: string[] = [];
    for (const tool of data.tools) {
      if (!tool.mounted) {
        continue;
      }
      if (!deps.isToolRegistered(tool.name)) {
        unavailableTools.push(tool.name);
        continue;
      }
      deps.mountTool(tool.name);
    }

    const sourceSessionId = data.session.sourceSessionId ?? 'unknown';
    deps.sessionManager.appendUserMessage(
      buildContinuationDisclosure(sourceSessionId, data.createdAt, unavailableTools)
    );
    deps.emitEvent({
      kind: 'notice',
      content: `Context restored from checkpoint (session ${sourceSessionId}, ${data.createdAt}).`,
    });

    return { warnings, unavailableTools };
  }

  return {
    registerContributor(contributor) {
      contributors.set(contributor.id, contributor);
    },
    unregisterContributor(id) {
      contributors.delete(id);
    },
    getContributors() {
      return [...contributors.values()];
    },
    exportContext,
    importContext,
  };
}
