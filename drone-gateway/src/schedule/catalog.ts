import type { DroneExtensionCapability } from 'drone-core';
import { DEFAULT_GATEWAY_EXTENSION_ID } from '../extension-defaults.js';

/** The three callable capabilities the gateway declares to the swarm. */
export const SCHEDULE_CAPABILITIES: DroneExtensionCapability[] = [
  {
    name: 'schedule_wakeup',
    description:
      'Schedule a one-time wake-up for yourself. At or just after the given ' +
      'time you receive a new turn that carries this note. Use it for user ' +
      'reminders, for example "remind me to check the soup at 10". Give an ' +
      'absolute ISO-8601 time with an offset in dueAt, or a relative delay in ' +
      'delayMs. The result returns the resolved time.',
    paramSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'The thing to surface at wake time.',
        },
        dueAt: {
          type: 'string',
          description: 'Absolute ISO-8601 time with an offset.',
        },
        delayMs: {
          type: 'number',
          description: 'Relative delay from now, in milliseconds.',
        },
      },
      required: ['note'],
    },
    responseSchema: { type: 'object' },
    exposed: 'mcp',
  },
  {
    name: 'schedule_list',
    description:
      'List the pending wake-ups you have scheduled in this conversation.',
    paramSchema: { type: 'object', properties: {} },
    responseSchema: { type: 'array' },
    exposed: 'mcp',
  },
  {
    name: 'schedule_cancel',
    description:
      'Cancel a pending wake-up by its id. Get ids from schedule_list.',
    paramSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The wake-up id to cancel.' },
      },
      required: ['id'],
    },
    responseSchema: { type: 'object' },
    exposed: 'mcp',
  },
];

/** The prompt fragment that teaches the model about the schedule tools. */
export function scheduleGuidanceFragment(): string {
  return [
    '# Scheduled Wake-ups',
    '',
    'You can schedule a one-time wake-up for yourself.',
    `Use the \`extensions__${DEFAULT_GATEWAY_EXTENSION_ID}__schedule_wakeup\` tool.`,
    'At or just after the time you give, the system starts a new turn of this agent.',
    'That turn carries your note. Your reply is sent to the conversation.',
    'Use this for user reminders, for example "remind me to check the soup at 10".',
    'These tools start unmounted. Mount them with `runtime__mount_tool` before use.',
    'The other tools are `..._schedule_list` and `..._schedule_cancel`.',
  ].join('\n');
}
