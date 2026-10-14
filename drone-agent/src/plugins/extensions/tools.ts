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
import type { ExtensionsContext } from './context.js';

/** Canonical tool name for a catalog capability. */
export function injectedToolCanonicalName(
  extensionId: string,
  toolName: string
): string {
  return `extensions__${extensionId}__${toolName}`;
}

/** The name the engine scopes under the `extensions` plugin id. */
function registeredToolName(extensionId: string, toolName: string): string {
  return `${extensionId}__${toolName}`;
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
  toolName: string,
  params: unknown
): Promise<string> {
  const beaconUrl = ctx.swarmCap?.getBeaconUrl();
  if (!beaconUrl) {
    return `extension did not respond: swarm beacon not connected`;
  }
  try {
    const res = await fetch(
      `${beaconUrl}/coordinator/extensions/${encodeURIComponent(extensionId)}/tools/${encodeURIComponent(toolName)}`,
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

/** Build the tool definition for one catalog selection. */
function buildToolDefinition(
  ctx: ExtensionsContext,
  extensionId: string,
  selection: {
    capability: string;
    description?: string;
    paramSchema?: Record<string, unknown>;
  }
): DroneToolDefinition {
  return {
    name: registeredToolName(extensionId, selection.capability),
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
      selection: {
        capability: string;
        description?: string;
        paramSchema?: Record<string, unknown>;
      };
    }
  >();
  for (const inj of ctx.store.list()) {
    if (inj.kind !== 'tools') continue;
    for (const selection of inj.tools) {
      const canonical = injectedToolCanonicalName(
        inj.extensionId,
        selection.capability
      );
      desired.set(canonical, { extensionId: inj.extensionId, selection });
    }
  }

  for (const canonical of ctx.injectedTools.keys()) {
    if (!desired.has(canonical)) {
      ctx.registration.unregisterTool(canonical);
      ctx.injectedTools.delete(canonical);
    }
  }

  for (const [canonical, { extensionId, selection }] of desired) {
    if (ctx.injectedTools.has(canonical)) continue;
    try {
      ctx.registration.registerTool(
        buildToolDefinition(ctx, extensionId, selection)
      );
      ctx.injectedTools.set(canonical, {
        extensionId,
        toolName: selection.capability,
      });
    } catch (err) {
      ctx.registration.logger.warn(
        `Failed to register injected tool ${canonical}: ${err}`
      );
    }
  }
}
