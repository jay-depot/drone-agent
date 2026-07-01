import { isRecord } from '../shared/type-guards.js';
import type { DronePlugin, DroneSlashCommandContext } from 'drone-core';

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

function isTodoStatus(value: unknown): value is TodoStatus {
  return (
    value === 'pending' || value === 'in_progress' || value === 'completed'
  );
}

function parseManageInput(input: Record<string, unknown>): TodoManageInput {
  if (!isRecord(input)) {
    throw new Error('todo__manage_list expected an object input.');
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
      'todo__manage_list action must be one of: add_item, mark_in_progress, mark_completed, remove_item, list_items, clear_completed, replace_list.'
    );
  }

  if (input.id !== undefined && typeof input.id !== 'string') {
    throw new Error('todo__manage_list id must be a string when provided.');
  }

  if (input.title !== undefined && typeof input.title !== 'string') {
    throw new Error('todo__manage_list title must be a string when provided.');
  }

  if (action === 'add_item') {
    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      throw new Error('todo__manage_list add_item requires a non-empty title.');
    }
  }

  if (
    action === 'mark_in_progress' ||
    action === 'mark_completed' ||
    action === 'remove_item'
  ) {
    if (typeof input.id !== 'string' || input.id.trim().length === 0) {
      throw new Error(`todo__manage_list ${action} requires a non-empty id.`);
    }
  }

  if (action === 'replace_list') {
    if (!Array.isArray(input.items)) {
      throw new Error(
        'todo__manage_list replace_list requires an items array.'
      );
    }

    for (const item of input.items) {
      if (
        !isRecord(item) ||
        typeof item.title !== 'string' ||
        item.title.trim().length === 0
      ) {
        throw new Error(
          'todo__manage_list replace_list items require a non-empty title.'
        );
      }
      if (item.status !== undefined && !isTodoStatus(item.status)) {
        throw new Error(
          'todo__manage_list replace_list item status must be pending, in_progress, or completed.'
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
      render: async () => `# Todo List\n\n${formatTodoList(items)}`,
    });

    registration.registerTool({
      name: 'manage_list',
      description:
        'Manage the in-session todo list. action: add_item | mark_in_progress | mark_completed | remove_item | list_items | clear_completed | replace_list.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description:
              'add_item | mark_in_progress | mark_completed | remove_item | list_items | clear_completed | replace_list.',
          },
          id: {
            type: 'string',
            description: 'Item id (for mark_*/remove_item).',
          },
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
              `todo__manage_list could not find item with id ${parsed.id}.`
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
              `todo__manage_list could not find item with id ${parsed.id}.`
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

    // Helper function to format todo list with optional status filter
    function formatTodoListFiltered(filterStatus?: TodoStatus): string {
      const filteredItems = filterStatus
        ? items.filter(item => item.status === filterStatus)
        : items;
      return formatTodoList(filteredItems);
    }

    // Slash command: /todo
    registration.registerSlashCommand({
      command: '/todo',
      description: 'Todo management: show, add, clear',
      handler: async (ctx: DroneSlashCommandContext) => {
        const subcommand = ctx.args[0] ?? '';

        // /todo show
        if (subcommand === 'show') {
          const statusIndex = ctx.args.indexOf('--status');
          const filterStatus: TodoStatus | undefined =
            statusIndex !== -1
              ? (ctx.args[statusIndex + 1] as TodoStatus)
              : undefined;

          if (filterStatus && !isTodoStatus(filterStatus)) {
            ctx.logger.warn(
              'Invalid status. Use: pending, in_progress, or completed'
            );
            return true;
          }

          const list = formatTodoListFiltered(filterStatus);
          if (items.length === 0) {
            ctx.logger.info(
              'No todo items yet. Use /todo add <description> to add one.'
            );
          } else if (filterStatus) {
            ctx.logger.info(`Todo items [${filterStatus}]:\n${list}`);
          } else {
            ctx.logger.info(`Todo list:\n${list}`);
          }
          return true;
        }

        // /todo add
        if (subcommand === 'add') {
          const title = ctx.args.slice(1).join(' ').trim();

          if (!title) {
            ctx.logger.info(
              'Usage: /todo add <description>\nExample: /todo add Fix bug in login'
            );
            return true;
          }

          await ctx.engine.executeTool('todo__manage_list', {
            action: 'add_item',
            title,
          });
          ctx.logger.info(`Added: ${title}`);
          return true;
        }

        // /todo clear
        if (subcommand === 'clear') {
          const target = ctx.args[1];

          if (!target) {
            // Clear completed items (default)
            const completedCount = items.filter(
              i => i.status === 'completed'
            ).length;
            if (completedCount === 0) {
              ctx.logger.info('No completed items to clear.');
              return true;
            }
            await ctx.engine.executeTool('todo__manage_list', {
              action: 'clear_completed',
            });
            ctx.logger.info(`Cleared ${completedCount} completed item(s).`);
            return true;
          }

          if (target === 'all') {
            if (items.length === 0) {
              ctx.logger.info('No items to clear.');
              return true;
            }
            // Clear all items
            items.length = 0;
            nextId = 1;
            ctx.logger.info('Cleared all todo items.');
            return true;
          }

          // Try to clear specific item by ID
          const targetItem = items.find(i => i.id === target);
          if (!targetItem) {
            ctx.logger.warn(
              `Item "${target}" not found. Use /todo show to see all items.`
            );
            return true;
          }
          await ctx.engine.executeTool('todo__manage_list', {
            action: 'remove_item',
            id: target,
          });
          ctx.logger.info(`Cleared item: ${targetItem.title}`);
          return true;
        }

        // Unknown subcommand - show help
        ctx.logger.info(
          `Usage: /todo <subcommand> [args]
  Subcommands:
    show           Show all todo items
    show --status <status>  Filter by status (pending, in_progress, completed)
    add <desc>    Add a new todo item
    clear          Clear completed items
    clear <id>     Clear specific item by ID
    clear all      Clear all items`
        );
        return true;
      },
    });

    // Help text
    registration.registerHelp('/todo show           Show all todo items');
    registration.registerHelp('/todo show --status <status>  Filter by status');
    registration.registerHelp('/todo add <desc>     Add a new todo item');
    registration.registerHelp('/todo clear [id|all] Clear items');

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('todo tool ready');
    });

    // Offer mid-panel widget so the TUI can render a todo summary.
    registration.offer({
      id: 'todo',
      label: 'TODO',
      getContent: () => {
        if (items.length === 0) return [];
        const completedCount = items.filter(
          i => i.status === 'completed'
        ).length;
        const inProgressCount = items.filter(
          i => i.status === 'in_progress'
        ).length;
        const summary = `${completedCount} / ${items.length}`;
        if (inProgressCount > 0) {
          return [`${summary} : ${inProgressCount} WORKING`];
        }
        return [summary];
      },
    });
  },
};
