import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { ToolRenderState } from 'drone-core';
import type { DroneColorScheme } from '../../tui/theme.js';
import { tryParseJson } from '../../tui/shared/format.js';

type TodoStatus = 'pending' | 'in_progress' | 'completed';

type TodoItem = {
  id: string;
  title: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
};

type TodoResult = {
  action: string;
  items: TodoItem[];
  summary: string;
};

function statusIcon(status: TodoStatus): string {
  switch (status) {
    case 'pending':
      return '○';
    case 'in_progress':
      return '◌';
    case 'completed':
      return '✓';
  }
}

function statusColor(status: TodoStatus, scheme: DroneColorScheme): string {
  switch (status) {
    case 'pending':
      return scheme.info;
    case 'in_progress':
      return scheme.warning;
    case 'completed':
      return scheme.success;
  }
}

function actionLabel(action: string): string {
  switch (action) {
    case 'add_item':
      return 'ADD';
    case 'mark_in_progress':
      return 'START';
    case 'mark_completed':
      return 'DONE';
    case 'remove_item':
      return 'REMOVE';
    case 'clear_completed':
      return 'CLEAR';
    case 'replace_list':
      return 'REPLACE';
    case 'list_items':
      return 'LIST';
    default:
      return action.toUpperCase();
  }
}

export function TodoBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;
  const result = state.result ?? '';

  if (state.status === 'running') {
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {'…'} todo...
      </Text>
    );
  }
  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ todo: ${result}`}
      </Text>
    );
  }

  const parsed = tryParseJson(result) as TodoResult | undefined;
  if (!parsed || typeof parsed !== 'object') {
    return <Text wrap="wrap">{result}</Text>;
  }

  const out: ReactNode[] = [];

  // Action header
  out.push(
    <Text key="header" bold color={scheme.primary} wrap="wrap">
      {`## TODO ${actionLabel(parsed.action)}`}
    </Text>
  );

  // If the action was add_item, show the new item title
  if (parsed.action === 'add_item' && parsed.items.length > 0) {
    const last = parsed.items[parsed.items.length - 1];
    out.push(
      <Text key="new-item" color={scheme.success} wrap="wrap">
        {`+ ${last.title}`}
      </Text>
    );
  }

  // Blank line before list
  out.push(
    <Text key="blank" wrap="wrap">
      {''}
    </Text>
  );

  // List section
  if (parsed.items.length > 0) {
    out.push(
      <Text key="list-header" bold color={scheme.primary} wrap="wrap">
        {'### LIST'}
      </Text>
    );

    for (const item of parsed.items) {
      const icon = statusIcon(item.status);
      const color = statusColor(item.status, scheme);
      const strike = item.status === 'completed';
      out.push(
        <Text
          key={item.id}
          color={color}
          strikethrough={strike}
          wrap="wrap"
        >
          {`${item.id}. ${icon} ${item.title}`}
        </Text>
      );
    }
  } else {
    out.push(
      <Text key="empty" color={scheme.info} wrap="wrap">
        {'No todo items yet.'}
      </Text>
    );
  }

  return <>{out}</>;
}
