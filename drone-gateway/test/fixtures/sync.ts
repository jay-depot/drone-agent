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

/**
 * Build a /sync response bringing `!room:test` into the join category with a
 * single `m.room.message` in its timeline, the way the initial sync of a DM
 * with one command in it looks. The bot and the message sender are the two
 * joined members, so the adapter treats the room as a DM.
 */
export function syncWithMessage(
  nextBatch: string,
  message: { sender: string; body: string; eventId?: string }
): ISyncResponse {
  return {
    next_batch: nextBatch,
    rooms: {
      join: {
        '!room:test': {
          summary: {},
          state: {
            events: [
              {
                type: 'm.room.member',
                state_key: '@bot:test',
                sender: '@bot:test',
                content: { membership: 'join' },
                event_id: '$m1',
                origin_server_ts: 1,
              },
              {
                type: 'm.room.member',
                state_key: message.sender,
                sender: message.sender,
                content: { membership: 'join' },
                event_id: '$m2',
                origin_server_ts: 2,
              },
            ],
          },
          timeline: {
            events: [
              {
                type: 'm.room.message',
                event_id: message.eventId ?? '$cmd1',
                sender: message.sender,
                origin_server_ts: 10,
                content: { body: message.body, msgtype: 'm.text' },
              },
            ],
            prev_batch: 'pb1',
          },
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
