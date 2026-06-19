import type { DronePlugin } from 'drone-core';

type TodoStatus = 'pending' | 'in_progress' | 'completed';

type TodoItem = {
  id: string;
  title: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
};

type TodoManageAction =
  | 'add_item'
  | 'mark_in_progress'
  | 'mark_completed'
  | 'remove_item'
  | 'list_items'
  | 'clear_completed'
  | 'replace_list';

type TodoManageInput = {
  action: TodoManageAction;
  id?: string;
  title?: string;
  items?: Array<{
    title: string;
    status?: TodoStatus;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return (
    value === 'pending' || value === 'in_progress' || value === 'completed'
  );
}

function parseManageInput(input: Record<string, unknown>): TodoManageInput {
  if (!isRecord(input)) {
    throw new Error('todo.manage_list expected an object input.');
  }

  const { action } = input;
  if (
    action !== 'add_item' &&
    action !== 'mark_in_progress' &&
    action !== 'mark_completed' &&
    action !== 'remove_item' &&
    action !== 'list_items' &&
    action !== 'clear_completed' &&
    action !== 'replace_list'
  ) {
    throw new Error(
      'todo.manage_list action must be one of: add_item, mark_in_progress, mark_completed, remove_item, list_items, clear_completed, replace_list.'
    );
  }

  if (input.id !== undefined && typeof input.id !== 'string') {
    throw new Error('todo.manage_list id must be a string when provided.');
  }

  if (input.title !== undefined && typeof input.title !== 'string') {
    throw new Error('todo.manage_list title must be a string when provided.');
  }

  if (action === 'add_item') {
    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      throw new Error('todo.manage_list add_item requires a non-empty title.');
    }
  }

  if (
    action === 'mark_in_progress' ||
    action === 'mark_completed' ||
    action === 'remove_item'
  ) {
    if (typeof input.id !== 'string' || input.id.trim().length === 0) {
      throw new Error(`todo.manage_list ${action} requires a non-empty id.`);
    }
  }

  if (action === 'replace_list') {
    if (!Array.isArray(input.items)) {
      throw new Error('todo.manage_list replace_list requires an items array.');
    }

    for (const item of input.items) {
      if (
        !isRecord(item) ||
        typeof item.title !== 'string' ||
        item.title.trim().length === 0
      ) {
        throw new Error(
          'todo.manage_list replace_list items require a non-empty title.'
        );
      }
      if (item.status !== undefined && !isTodoStatus(item.status)) {
        throw new Error(
          'todo.manage_list replace_list item status must be pending, in_progress, or completed.'
        );
      }
    }
  }

  return {
    action,
    id: input.id as string | undefined,
    title: input.title as string | undefined,
    items: input.items as TodoManageInput['items'],
  };
}

function statusLabel(status: TodoStatus): string {
  if (status === 'pending') {
    return 'pending';
  }
  if (status === 'in_progress') {
    return 'in progress';
  }
  return 'completed';
}

function formatTodoList(items: TodoItem[]): string {
  if (items.length === 0) {
    return 'No todo items yet.';
  }

  const lines = items.map(
    item => `- (${item.id}) [${statusLabel(item.status)}] ${item.title}`
  );
  return lines.join('\n');
}

export const todoPlugin: DronePlugin = {
  metadata: {
    id: 'todo',
    name: 'Todo',
    version: '0.1.0',
    description:
      'Maintains a lightweight in-session todo list for planning and execution.',
    defaultEnabled: false,
  },
  register: async registration => {
    const items: TodoItem[] = [];
    let nextId = 1;

    registration.registerPromptFragment({
      key: 'todo-current-list',
      phase: 'header',
      render: async () => `Current todo list:\n${formatTodoList(items)}`,
    });

    registration.registerTool({
      name: 'manage_list',
      description:
        'Manage the in-session todo list. action: add_item | mark_in_progress | mark_completed | remove_item | list_items | clear_completed | replace_list.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'add_item | mark_in_progress | mark_completed | remove_item | list_items | clear_completed | replace_list.' },
          id: { type: 'string', description: 'Item id (for mark_*/remove_item).' },
          title: { type: 'string', description: 'Item title (for add_item).' },
          items: {
            type: 'array',
            description: 'Replacement list (for replace_list).',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                status: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async input => {
        const parsed = parseManageInput(input);
        const now = new Date().toISOString();

        if (parsed.action === 'list_items') {
          return JSON.stringify(
            {
              action: parsed.action,
              items,
              summary: formatTodoList(items),
            },
            null,
            2
          );
        }

        if (parsed.action === 'add_item') {
          const item: TodoItem = {
            id: String(nextId),
            title: parsed.title!.trim(),
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          };
          nextId += 1;
          items.push(item);
        }

        if (
          parsed.action === 'mark_in_progress' ||
          parsed.action === 'mark_completed'
        ) {
          const target = items.find(item => item.id === parsed.id);
          if (!target) {
            throw new Error(
              `todo.manage_list could not find item with id ${parsed.id}.`
            );
          }
          target.status =
            parsed.action === 'mark_in_progress' ? 'in_progress' : 'completed';
          target.updatedAt = now;
        }

        if (parsed.action === 'remove_item') {
          const index = items.findIndex(item => item.id === parsed.id);
          if (index === -1) {
            throw new Error(
              `todo.manage_list could not find item with id ${parsed.id}.`
            );
          }
          items.splice(index, 1);
        }

        if (parsed.action === 'clear_completed') {
          for (let i = items.length - 1; i >= 0; i -= 1) {
            if (items[i].status === 'completed') {
              items.splice(i, 1);
            }
          }
        }

        if (parsed.action === 'replace_list') {
          items.length = 0;
          for (const inputItem of parsed.items ?? []) {
            items.push({
              id: String(nextId),
              title: inputItem.title.trim(),
              status: inputItem.status ?? 'pending',
              createdAt: now,
              updatedAt: now,
            });
            nextId += 1;
          }
        }

        return JSON.stringify(
          {
            action: parsed.action,
            items,
            summary: formatTodoList(items),
          },
          null,
          2
        );
      },
    });

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('todo tool ready');
    });

    // Offer sidebar widget so the TUI can render the active todo list.
    registration.offer({
      id: 'todo',
      label: 'TODO',
      getContent: () => {
        if (items.length === 0) return [];
        const activeCount = items.filter(
          i => i.status !== 'completed'
        ).length;
        const lines: string[] = [];
        lines.push(` ${items.length} items (${activeCount} active)`);
        for (const item of items) {
          let icon: string;
          if (item.status === 'in_progress') {
            icon = ' ▶';
          } else if (item.status === 'completed') {
            icon = ' ✓';
          } else {
            icon = ' ○';
          }
          const title =
            item.title.length > 18
              ? item.title.slice(0, 17) + '…'
              : item.title;
          lines.push(` ${icon} ${title}`);
        }
        return lines;
      },
    });
  },
};
