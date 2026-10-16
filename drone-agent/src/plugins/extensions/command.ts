/**
 * `/extensions` — read-only listing of the swarm extensions currently
 * injecting into this session: their fragment injections and selected tools.
 */

import type { DroneSlashCommand } from 'drone-core';
import type { ExtensionsContext } from './context.js';

export function createExtensionsCommand(
  ctx: ExtensionsContext
): DroneSlashCommand {
  return {
    command: '/extensions',
    description: 'List swarm extensions injecting into this session.',
    busyBehavior: true,
    handler: async slashCtx => {
      const injections = ctx.store.list();
      const extensions = ctx.store.listExtensions();
      if (extensions.length === 0) {
        slashCtx.logger.info('No extensions have injected into this session.');
        return true;
      }

      const lines: string[] = ['Swarm extensions:'];
      for (const extensionId of extensions.sort()) {
        lines.push('');
        lines.push(`  ${extensionId}`);
        const own = injections.filter(i => i.extensionId === extensionId);
        const fragments = own.filter(i => i.kind === 'fragment');
        const tools = own.filter(i => i.kind === 'tools');
        const reminders = own.filter(i => i.kind === 'reminder');
        if (fragments.length > 0) {
          lines.push(
            `    fragments: ${fragments
              .map(f => `${f.injectionId} (${f.phase})`)
              .join(', ')}`
          );
        }
        if (tools.length > 0) {
          const names = tools.flatMap(t => t.tools.map(x => x.capability));
          lines.push(`    tools: ${names.join(', ') || '(none)'}`);
        }
        if (reminders.length > 0) {
          lines.push(`    reminders queued: ${reminders.length}`);
        }
      }
      lines.push('');
      lines.push(
        'Use `runtime__list_tools` to see injected tools (`extensions__*`).'
      );
      slashCtx.logger.info(lines.join('\n'));
      return true;
    },
  };
}
