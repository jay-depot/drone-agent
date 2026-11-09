import type { DroneExtensionCapability } from 'drone-core';

const str = (description: string) => ({ type: 'string', description });
const optStr = (description: string) => ({ type: 'string', description });

const projectIdParam = optStr('Project id. Omitted for a card-bound session.');
const cardIdParam = optStr('Card id. Omitted for a card-bound session.');

/**
 * The capability catalog: the single source of truth for both the declared
 * manifest and the handlers.
 *
 * `mcp`-tier capabilities (agent-callable, `exposed` omitted) cover board and
 * card management. `ui`-tier capabilities cover columns, automations, limits,
 * and queue administration, and are never agent-callable.
 */
export const CAPABILITIES: DroneExtensionCapability[] = [
  {
    name: 'project.list',
    description: 'List projects on the board.',
    paramSchema: { type: 'object', properties: {} },
  },
  {
    name: 'board.get',
    description: 'Get a project with its columns and cards.',
    paramSchema: {
      type: 'object',
      properties: { projectId: projectIdParam },
      required: ['projectId'],
    },
  },
  {
    name: 'card.get',
    description: 'Get one card.',
    paramSchema: {
      type: 'object',
      properties: { projectId: projectIdParam, cardId: cardIdParam },
    },
  },
  {
    name: 'card.create',
    description: 'Create a card in a project.',
    paramSchema: {
      type: 'object',
      properties: {
        projectId: projectIdParam,
        title: str('Card title.'),
        description: str('Card description.'),
        columnId: optStr('Target column id. Defaults to the first column.'),
      },
      required: ['title'],
    },
  },
  {
    name: 'card.update',
    description: 'Update a card title or description.',
    paramSchema: {
      type: 'object',
      properties: {
        projectId: projectIdParam,
        cardId: cardIdParam,
        title: optStr('New title.'),
        description: optStr('New description.'),
      },
    },
  },
  {
    name: 'card.move',
    description: 'Move a card to another column.',
    paramSchema: {
      type: 'object',
      properties: {
        projectId: projectIdParam,
        cardId: cardIdParam,
        toColumnId: str('Destination column id.'),
        position: { type: 'number', description: 'Target position in the column.' },
      },
      required: ['toColumnId'],
    },
  },

  {
    name: 'project.create',
    description: 'Create a project.',
    paramSchema: {
      type: 'object',
      properties: {
        name: str('Project name.'),
        defaultBeaconId: optStr('Default beacon id for automations.'),
        defaultWorkingDir: optStr('Default working directory for automations.'),
      },
      required: ['name'],
    },
    exposed: 'ui',
  },
  {
    name: 'project.update',
    description: 'Update a project name or defaults.',
    paramSchema: {
      type: 'object',
      properties: {
        projectId: str('Project id.'),
        name: optStr('New name.'),
        defaultBeaconId: optStr('New default beacon id.'),
        defaultWorkingDir: optStr('New default working directory.'),
      },
      required: ['projectId'],
    },
    exposed: 'ui',
  },
  {
    name: 'project.delete',
    description: 'Delete a project.',
    paramSchema: {
      type: 'object',
      properties: { projectId: str('Project id.') },
      required: ['projectId'],
    },
    exposed: 'ui',
  },
  {
    name: 'column.list',
    description: 'List a project columns.',
    paramSchema: {
      type: 'object',
      properties: { projectId: str('Project id.') },
      required: ['projectId'],
    },
    exposed: 'ui',
  },
  {
    name: 'column.create',
    description: 'Add a column to a project.',
    paramSchema: {
      type: 'object',
      properties: { projectId: str('Project id.'), name: str('Column name.') },
      required: ['projectId', 'name'],
    },
    exposed: 'ui',
  },
  {
    name: 'column.update',
    description: 'Rename or reorder a column.',
    paramSchema: {
      type: 'object',
      properties: {
        projectId: str('Project id.'),
        columnId: str('Column id.'),
        name: optStr('New name.'),
        order: { type: 'number', description: 'New order.' },
      },
      required: ['projectId', 'columnId'],
    },
    exposed: 'ui',
  },
  {
    name: 'column.reorder',
    description: 'Reorder the columns of a project.',
    paramSchema: {
      type: 'object',
      properties: {
        projectId: str('Project id.'),
        columnIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Column ids in the new order.',
        },
      },
      required: ['projectId', 'columnIds'],
    },
    exposed: 'ui',
  },
  {
    name: 'column.delete',
    description: 'Delete an empty column from a project.',
    paramSchema: {
      type: 'object',
      properties: { projectId: str('Project id.'), columnId: str('Column id.') },
      required: ['projectId', 'columnId'],
    },
    exposed: 'ui',
  },
  {
    name: 'automation.list',
    description: 'List a project automations.',
    paramSchema: {
      type: 'object',
      properties: { projectId: str('Project id.') },
      required: ['projectId'],
    },
    exposed: 'ui',
  },
  {
    name: 'automation.create',
    description: 'Create an automation on a project.',
    paramSchema: {
      type: 'object',
      properties: {
        projectId: str('Project id.'),
        name: str('Automation name.'),
        enabled: { type: 'boolean', description: 'Whether the automation is on.' },
        when: {
          type: 'object',
          description: 'Transition pair. `*` is allowed on one side only.',
          properties: {
            from: str('Source column id or `*`.'),
            to: str('Destination column id or `*`.'),
          },
          required: ['from', 'to'],
        },
        then: {
          type: 'object',
          description: 'Action to perform.',
          properties: {
            action: { type: 'string', enum: ['launch-session'] },
            personaId: str('Persona to launch.'),
            model: optStr('Model override.'),
            promptTemplate: str('Prompt template.'),
          },
          required: ['action', 'personaId', 'promptTemplate'],
        },
      },
      required: ['projectId', 'name', 'when', 'then'],
    },
    exposed: 'ui',
  },
  {
    name: 'automation.update',
    description: 'Update an automation.',
    paramSchema: {
      type: 'object',
      properties: {
        projectId: str('Project id.'),
        automationId: str('Automation id.'),
        patch: { type: 'object', description: 'Fields to change.' },
      },
      required: ['projectId', 'automationId', 'patch'],
    },
    exposed: 'ui',
  },
  {
    name: 'automation.delete',
    description: 'Delete an automation.',
    paramSchema: {
      type: 'object',
      properties: {
        projectId: str('Project id.'),
        automationId: str('Automation id.'),
      },
      required: ['projectId', 'automationId'],
    },
    exposed: 'ui',
  },
  {
    name: 'queue.list',
    description: 'List spawn jobs.',
    paramSchema: { type: 'object', properties: {} },
    exposed: 'ui',
  },
  {
    name: 'queue.retry',
    description: 'Requeue a failed job.',
    paramSchema: {
      type: 'object',
      properties: { jobId: str('Job id.') },
      required: ['jobId'],
    },
    exposed: 'ui',
  },
  {
    name: 'queue.cancel',
    description: 'Cancel a queued job.',
    paramSchema: {
      type: 'object',
      properties: { jobId: str('Job id.') },
      required: ['jobId'],
    },
    exposed: 'ui',
  },
  {
    name: 'limits.get',
    description: 'Read the node speed limits.',
    paramSchema: { type: 'object', properties: {} },
    exposed: 'ui',
  },
  {
    name: 'limits.set',
    description: 'Set the node speed limits.',
    paramSchema: {
      type: 'object',
      properties: {
        maxConcurrentSessions: {
          type: 'number',
          description: 'Concurrent session cap.',
        },
        maxDailySessions: { type: 'number', description: 'Rolling-24h cap.' },
      },
    },
    exposed: 'ui',
  },
];

/** The `mcp`-tier capability names injected as agent tools. */
export const CARD_TOOL_CAPABILITIES: string[] = CAPABILITIES.filter(
  capability => capability.exposed !== 'ui'
).map(capability => capability.name);
