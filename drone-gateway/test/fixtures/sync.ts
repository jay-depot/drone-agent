import type { ISyncResponse } from 'matrix-js-sdk/lib/sync-accumulator.js';

/**
 * Build a /sync response that brings `!room:test` into the join category, the
 * way the first (initial) sync of a DM does.
 */
export function roomSync(nextBatch: string): ISyncResponse {
  return {
    next_batch: nextBatch,
    rooms: {
      join: {
        '!room:test': {
          summary: {},
          state: { events: [] },
          timeline: { events: [], prev_batch: null },
          ephemeral: { events: [] },
          account_data: { events: [] },
          unread_notifications: {},
        },
      },
      invite: {},
      leave: {},
      knock: {},
    },
    account_data: { events: [] },
  } as unknown as ISyncResponse;
}

/**
 * Build an incremental /sync response: a new token and whatever changed, with
 * no room data. This is the response shape that exposed DRONE-GW-BUG-002.
 */
export function incrementalSync(nextBatch: string): ISyncResponse {
  return {
    next_batch: nextBatch,
    rooms: { join: {}, invite: {}, leave: {}, knock: {} },
    account_data: { events: [] },
  } as unknown as ISyncResponse;
}
