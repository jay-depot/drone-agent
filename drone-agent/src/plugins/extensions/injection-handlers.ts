/**
 * Inbound `injection` / `injectionRemove` frame handlers for the extensions
 * plugin. The coordinator forwards these to the host beacon, which relays
 * `{type:'injection'|'injectionRemove', payload}` to the agent over its
 * WebSocket; the swarm plugin's WS seam routes them here.
 */

import type { DroneInjectedToolSelection } from 'drone-core';
import type { ExtensionsContext } from './context.js';
import { emitNotice } from './context.js';
import { reconcileInjectedTools } from './tools.js';

export interface InjectionPayload {
  /** Extension node id that pushed the injection. */
  extensionId: string;
  /** Caller-chosen injection id. */
  id?: string;
  injectionId?: string;
  kind: 'fragment' | 'reminder' | 'tools';
  content?: string;
  phase?: 'header' | 'footer';
  ttlMs?: number;
  tools?: DroneInjectedToolSelection[];
}

/** Apply an `injection` frame: fragment/reminder/tools. */
export function handleInjection(
  ctx: ExtensionsContext,
  payload: InjectionPayload
): void {
  const extensionId = payload.extensionId;
  const injectionId = payload.id ?? payload.injectionId;
  if (!extensionId || !injectionId) return;

  switch (payload.kind) {
    case 'fragment': {
      const result = ctx.store.applyFragment({
        extensionId,
        injectionId,
        content: payload.content ?? '',
        phase: payload.phase ?? 'header',
      });
      if (result === 'rejected') {
        emitNotice(
          ctx,
          `[extensions: ${extensionId} fragment "${injectionId}" rejected (budget)]`
        );
      } else if (result !== 'unchanged') {
        emitNotice(
          ctx,
          `[extensions: ${extensionId} injected fragment "${injectionId}"]`
        );
      }
      return;
    }
    case 'reminder': {
      ctx.runtime?.queueSystemReminder?.(
        `[extension:${extensionId}] ${payload.content ?? ''}`
      );
      emitNotice(ctx, `[extensions: ${extensionId} queued a reminder]`);
      return;
    }
    case 'tools': {
      const result = ctx.store.applyToolSelection({
        extensionId,
        injectionId,
        tools: payload.tools ?? [],
      });
      reconcileInjectedTools(ctx);
      if (result !== 'unchanged') {
        emitNotice(
          ctx,
          `[extensions: ${extensionId} selected ${(payload.tools ?? []).length} tool(s)]`
        );
      }
      return;
    }
  }
}

/** Apply an `injectionRemove` frame. */
export function handleInjectionRemove(
  ctx: ExtensionsContext,
  payload: InjectionPayload
): void {
  const extensionId = payload.extensionId;
  if (!extensionId) return;

  if (payload.kind === 'tools' && payload.tools) {
    ctx.store.removeTools(
      extensionId,
      payload.tools.map(t => t.capability)
    );
  } else if (payload.injectionId) {
    ctx.store.remove(extensionId, payload.injectionId);
  } else {
    // No id: drop every injection of this kind from the extension.
    for (const inj of ctx.store.list()) {
      if (inj.extensionId === extensionId && inj.kind === payload.kind) {
        ctx.store.remove(extensionId, inj.injectionId);
      }
    }
  }

  reconcileInjectedTools(ctx);
  emitNotice(ctx, `[extensions: ${extensionId} removed an injection]`);
}
