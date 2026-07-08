import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../../../tui/theme.js';
import { tryParseJson } from '../../../tui/shared/format.js';
import type { ListItem } from '../types.js';

export type { ListItem } from '../types.js';

export function renderList(
  items: ListItem[],
  scheme: DroneColorScheme
): ReactNode[] {
  return items.map((item, i) => {
    const color =
      item.kind === 'added'
        ? scheme.success
        : item.kind === 'modified'
          ? scheme.info
          : scheme.error;
    const strike = item.kind === 'removed';
    const bullet =
      item.kind === 'added' ? '+' : item.kind === 'modified' ? '~' : '-';
    return (
      <Text key={i} color={color} strikethrough={strike} wrap="wrap">
        {`  ${bullet} ${item.path}`}
      </Text>
    );
  });
}

/** Heading line in the `## git <cmd>` style. */
export function renderHeading(
  text: string,
  scheme: DroneColorScheme
): ReactNode {
  return (
    <Text bold color={scheme.primary} wrap="wrap">
      {text}
    </Text>
  );
}
