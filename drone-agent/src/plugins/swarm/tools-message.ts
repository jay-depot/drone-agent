/**
 * swarm_message tool definition.
 *
 * Sends messages to other agents in the swarm or manages channel
 * subscriptions.
 */

import type { DroneToolDefinition } from 'drone-core';
import type { SwarmContext } from './context.js';
import {
  sendMessage,
  subscribeToChannel,
  unsubscribeFromChannel,
  getPendingMessages,
} from './websocket.js';

/**
 * Create the swarm_message tool.
 */
export function createSwarmMessageTool(
  ctx: SwarmContext
): DroneToolDefinition {
  return {
    name: 'swarm_message',
    description:
      'Send a message to another agent in the swarm or subscribe to a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['send', 'subscribe', 'unsubscribe', 'get_messages'],
          description: 'The action to perform',
        },
        toAgentId: {
          type: 'string',
          description: 'Target agent ID (for send action)',
        },
        toChannel: {
          type: 'string',
          description:
            'Channel name (for subscribe/unsubscribe/send actions)',
        },
        body: {
          type: 'string',
          description: 'Message body (JSON string, for send action)',
        },
      },
      required: ['action'],
    },
    execute: async params => {
      const action = (params.action as string) || '';

      switch (action) {
        case 'send': {
          const toAgentId = params.toAgentId as string | undefined;
          const toChannel = params.toChannel as string | undefined;
          const body = params.body as string;
          if (!toAgentId && !toChannel) {
            return JSON.stringify({
              success: false,
              error: 'Must specify toAgentId or toChannel',
            });
          }
          sendMessage(ctx, toAgentId, toChannel, body);
          return JSON.stringify({ success: true, message: 'Message sent' });
        }
        case 'subscribe': {
          const channel = params.toChannel as string;
          if (!channel) {
            return JSON.stringify({
              success: false,
              error: 'Channel name required',
            });
          }
          subscribeToChannel(ctx, channel);
          return JSON.stringify({
            success: true,
            message: `Subscribed to ${channel}`,
          });
        }
        case 'unsubscribe': {
          const channel = params.toChannel as string;
          if (!channel) {
            return JSON.stringify({
              success: false,
              error: 'Channel name required',
            });
          }
          unsubscribeFromChannel(ctx, channel);
          return JSON.stringify({
            success: true,
            message: `Unsubscribed from ${channel}`,
          });
        }
        case 'get_messages': {
          const messages = getPendingMessages(ctx);
          return JSON.stringify({ success: true, messages });
        }
        default:
          return JSON.stringify({
            success: false,
            error: `Unknown action: ${action}`,
          });
      }
    },
  };
}
