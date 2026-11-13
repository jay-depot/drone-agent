/**
 * Injected-tool registry for the extensions plugin.
 *
 * Extensions select capabilities from their catalog per session; each
 * selection materializes as an agent tool named
 * `extensions__<extId>__<tool>` (the engine scopes `extensions__` onto the
 * registered name), registered UNMOUNTED in the ToolRegistry so the existing
 * list/mount meta-tools + persona filters apply unchanged.
 *
 * Reconciliation is idempotent per the MCP pattern: selections present are
 * registered, selections gone are unregistered, unchanged selections are
 * left alone.
 */

import type { DroneToolDefinition, DroneToolJsonSchema } from 'drone-core';
import { sanitizeToolSegment } from '../../shared/tool-name.js';
import type { ExtensionsContext } from './context.js';

/** One tool selection from an extension's catalog. */
type ToolSelection = {
  capability: string;
  description?: string;
  paramSchema?: Record<string, unknown>;
};

/**
 * Canonical tool name for an injected extension tool.
 *
 * `segment` is an already-sanitized tool-name segment (`card_move`), NOT the
 * raw capability name (`card.move`): a dot inside an LLM-facing tool name is
 * unsafe, so the raw capability never becomes the tool name (see the module
 * header).
 */
export function injectedToolCanonicalName(
  extensionId: string,
  segment: string
): string {
  return `extensions__${extensionId}__${segment}`;
}

/** The name the engine scopes under the `extensions` plugin id. */
function registeredToolName(extensionId: string, segment: string): string {
  return `${extensionId}__${segment}`;
}

/**
 * Proxy a tool call to the extension: agent → beacon
 * `/coordinator/extensions/<extId>/tools/<tool>` → coordinator → extension.
 * Never throws into the loop; a non-2xx or network failure returns a
 * tool-error string.
 */
async function invokeExtensionTool(
  ctx: ExtensionsContext,
  extensionId: string,
  capability: string,
  params: unknown
): Promise<string> {
  const beaconUrl = ctx.swarmCap?.getBeaconUrl();
  if (!beaconUrl) {
    return `extension did not respond: swarm beacon not connected`;
  }
  try {
    const res = await fetch(
      `${beaconUrl}/coordinator/extensions/${encodeURIComponent(extensionId)}/tools/${encodeURIComponent(capability)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          params,
          sessionId: ctx.runtime?.getSessionId?.() ?? null,
        }),
      }
    );
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      status?: number;
      body?: unknown;
    } | null;
    if (!res.ok || !data?.ok) {
      const detail =
        data?.body && typeof data.body === 'object' && 'error' in data.body
          ? (data.body as { error: string }).error
          : `HTTP ${res.status}`;
      return `extension error: ${detail}`;
    }
    return typeof data.body === 'string'
      ? data.body
      : JSON.stringify(data.body ?? null);
  } catch (err) {
    return `extension did not respond: ${
      err instanceof Error ? err.message : 'unknown error'
    }`;
  }
}

/**
 * Build the tool definition for one catalog selection. `segment` is the
 * sanitized tool name; the raw `selection.capability` still travels on the
 * proxy call, because the extension's catalog is keyed by the raw name.
 */
function buildToolDefinition(
  ctx: ExtensionsContext,
  extensionId: string,
  segment: string,
  selection: ToolSelection
): DroneToolDefinition {
  return {
    name: registeredToolName(extensionId, segment),
    description:
      selection.description ??
      `Extension capability ${selection.capability} from ${extensionId}.`,
    inputSchema: selection.paramSchema as DroneToolJsonSchema | undefined,
    execute: async (input: Record<string, unknown>) =>
      invokeExtensionTool(ctx, extensionId, selection.capability, input),
  };
}

/**
 * Reconcile the registry against the store's current tool selections. Safe to
 * call on every injection/removal: only diffs are applied.
 */
export function reconcileInjectedTools(ctx: ExtensionsContext): void {
  const desired = new Map<
    string,
    {
      extensionId: string;
      segment: string;
      selection: ToolSelection;
    }
  >();
  const usedNamesByExtension = new Map<string, Set<string>>();
  for (const inj of ctx.store.list()) {
    if (inj.kind !== 'tools') continue;
    let usedNames = usedNamesByExtension.get(inj.extensionId);
    if (!usedNames) {
      usedNames = new Set<string>();
      usedNamesByExtension.set(inj.extensionId, usedNames);
    }
    for (const selection of inj.tools) {
      const segment = sanitizeToolSegment(selection.capability, usedNames);
      const canonical = injectedToolCanonicalName(inj.extensionId, segment);
      desired.set(canonical, {
        extensionId: inj.extensionId,
        segment,
        selection,
      });
    }
  }

  for (const canonical of ctx.injectedTools.keys()) {
    if (!desired.has(canonical)) {
      ctx.registration.unregisterTool(canonical);
      ctx.injectedTools.delete(canonical);
    }
  }

  for (const [canonical, { extensionId, segment, selection }] of desired) {
    if (ctx.injectedTools.has(canonical)) continue;
    try {
      ctx.registration.registerTool(
        buildToolDefinition(ctx, extensionId, segment, selection)
      );
      ctx.injectedTools.set(canonical, {
        extensionId,
        capability: selection.capability,
      });
    } catch (err) {
      ctx.registration.logger.warn(
        `Failed to register injected tool ${canonical}: ${err}`
      );
    }
  }
}
