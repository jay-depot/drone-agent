/**
 * WS message handlers for swarm prompt fragments.
 *
 * Handles the two beacon→agent fragment messages:
 *   - `fragmentSync`: full merged current set for this agent (delivered on
 *     every WS connect and after coordinator mirror changes)
 *   - `fragment`: a single set/remove delta
 *
 * Every mutation emits a single `notice` conversation event (throttled to
 * one per op; sync emits at most one summary notice) via the engine's
 * `_runtime.emitEvent`.
 */

import type { DroneConversationEvent, DroneSwarmFragment } from 'drone-core';
import type { SwarmContext } from './context.js';

interface FragmentWsMessage {
  type: 'fragment' | 'fragmentSync';
  payload: {
    op?: 'set' | 'remove';
    fragment?: DroneSwarmFragment;
    fragments?: DroneSwarmFragment[];
  };
}

function emitNotice(ctx: SwarmContext, content: string): void {
  const runtime = ctx.registration.request<{ emitEvent?: (event: DroneConversationEvent) => void }>(
    '_runtime'
  );
  runtime?.emitEvent?.({ kind: 'notice', content });
}

export function handleFragmentMessage(
  ctx: SwarmContext,
  payload: FragmentWsMessage['payload']
): void {
  const { fragmentStore } = ctx;
  if (payload.op === 'remove' && payload.fragment) {
    const { id, target } = payload.fragment;
    if (fragmentStore.applyRemove(id, target)) {
      emitNotice(ctx, `Swarm fragment removed: ${id}`);
    }
    return;
  }
  if (payload.fragment) {
    const result = fragmentStore.applySet(payload.fragment);
    if (result !== 'unchanged') {
      emitNotice(ctx, `Swarm fragment ${result}: ${payload.fragment.id}`);
    }
  }
}

export function handleFragmentSyncMessage(
  ctx: SwarmContext,
  payload: FragmentWsMessage['payload']
): void {
  if (!Array.isArray(payload.fragments)) {
    return;
  }
  const count = payload.fragments.length;
  const suppressNotice = !ctx.fragmentsResynced;
  const result = ctx.fragmentStore.replaceAll(payload.fragments);
  ctx.fragmentsResynced = true;
  if (result === 'changed' && !suppressNotice) {
    emitNotice(ctx, `Swarm fragments resynced (${count} active)`);
  }
}