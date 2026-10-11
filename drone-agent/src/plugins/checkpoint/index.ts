/**
 * Checkpoint plugin — the first consumer of portable context (ADR 246).
 *
 * Saves/restores named session-context snapshots under
 * `./.drone-agent/checkpoints/<name>.json`, drives them with the
 * `/checkpoint` slash command, restores one at startup via
 * `--checkpoint.restore <name>`, and optionally writes auto-checkpoints at
 * session end and after each round (ADR 247).
 */

import {
  DRONE_PORTABLE_CONTEXT_CAPABILITY_ID,
  type DroneCheckpointCapability,
  type DronePlugin,
  type DronePortableContextCapability,
  type DroneSlashCommandContext,
} from 'drone-core';
import {
  deleteCheckpoint,
  listCheckpoints,
  readCheckpoint,
  renameCheckpoint,
  sanitizeName,
  writeCheckpoint,
} from './store.js';

type RuntimeInfo = {
  getSessionId?: () => string;
};

/** Filesystem-safe ISO timestamp used as the default checkpoint name. */
export function defaultCheckpointName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export const checkpointPlugin: DronePlugin = {
  metadata: {
    id: 'checkpoint',
    name: 'Checkpoint',
    version: '0.1.0',
    description:
      'Save and restore named portable-context snapshots under ./.drone-agent/checkpoints.',
    defaultEnabled: false,
    dependencies: [
      { id: DRONE_PORTABLE_CONTEXT_CAPABILITY_ID, optional: true },
    ],
  },
  register: async registration => {
    const capability = registration.request<DronePortableContextCapability>(
      DRONE_PORTABLE_CONTEXT_CAPABILITY_ID
    );
    const runtime = registration.request<RuntimeInfo>('runtime');
    const getSessionId = () => runtime?.getSessionId?.() ?? 'unknown';
    const config = registration.getConfig().checkpoint;

    let roundOrdinal = 0;

    async function writeAutoCheckpoint(
      prefix: string,
      sessionId: string
    ): Promise<void> {
      if (!capability) return;
      try {
        const data = await capability.exportContext();
        const name = sanitizeName(
          `${prefix}-${sessionId}-${defaultCheckpointName()}`
        );
        await writeCheckpoint(name, data);
        registration.logger.info(`checkpoint: wrote ${name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        registration.logger.warn(
          `checkpoint: auto-checkpoint failed: ${message}`
        );
      }
    }

    async function restore(
      name: string,
      ctx: DroneSlashCommandContext
    ): Promise<void> {
      if (!capability) {
        ctx.logger.error(
          '/checkpoint restore: portable-context capability unavailable'
        );
        return;
      }
      let data;
      try {
        data = await readCheckpoint(name);
      } catch {
        ctx.logger.error(`Checkpoint "${name}" not found.`);
        return;
      }
      try {
        const result = await capability.importContext(data);
        const lines = [`Restored checkpoint "${name}".`];
        if (result.unavailableTools.length > 0) {
          lines.push(
            `Unavailable tools: ${result.unavailableTools.join(', ')}`
          );
        }
        for (const warning of result.warnings) {
          lines.push(`Warning: ${warning}`);
        }
        ctx.logger.info(lines.join('\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.error(`Failed to restore checkpoint "${name}": ${message}`);
      }
    }

    registration.registerSlashCommand({
      command: '/checkpoint',
      description:
        'Portable-context checkpoints: create, restore, delete, rename, list.',
      // `restore` mutates the whole session mid-turn, so it queues; the others
      // touch only the on-disk store and run immediately.
      busyBehavior: invocation => invocation.subcommand !== 'restore',
      handler: async ctx => {
        const subcommand = ctx.args[0] ?? '';
        const name = ctx.args[1];

        if (subcommand === '' || subcommand === 'create') {
          if (!capability) {
            ctx.logger.error(
              '/checkpoint: portable-context capability unavailable'
            );
            return true;
          }
          const target = name ?? defaultCheckpointName();
          let data;
          try {
            data = await capability.exportContext();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.logger.error(`Failed to export context: ${message}`);
            return true;
          }
          try {
            await writeCheckpoint(target, data);
            ctx.logger.info(`Checkpoint created: ${sanitizeName(target)}`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.logger.error(`Failed to write checkpoint: ${message}`);
          }
          return true;
        }

        if (subcommand === 'restore') {
          if (!name) {
            ctx.logger.error('Usage: /checkpoint restore <name>');
            return true;
          }
          await restore(name, ctx);
          return true;
        }

        if (subcommand === 'delete') {
          if (!name) {
            ctx.logger.error('Usage: /checkpoint delete <name>');
            return true;
          }
          try {
            await deleteCheckpoint(name);
            ctx.logger.info(`Deleted checkpoint "${name}".`);
          } catch {
            ctx.logger.error(`Checkpoint "${name}" not found.`);
          }
          return true;
        }

        if (subcommand === 'rename') {
          const newName = ctx.args[2];
          if (!name || !newName) {
            ctx.logger.error('Usage: /checkpoint rename <old> <new>');
            return true;
          }
          try {
            await renameCheckpoint(name, newName);
            ctx.logger.info(`Renamed checkpoint "${name}" → "${newName}".`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.logger.error(`Failed to rename checkpoint: ${message}`);
          }
          return true;
        }

        if (subcommand === 'list') {
          const names = await listCheckpoints();
          ctx.logger.info(
            names.length > 0
              ? `Checkpoints:\n${names.map(n => `  - ${n}`).join('\n')}`
              : 'No checkpoints yet. Use /checkpoint create [name].'
          );
          return true;
        }

        ctx.logger.warn(
          `Usage: /checkpoint <subcommand> [args]
  Subcommands:
    create [name]        Save a checkpoint (default: timestamp)
    restore <name>       Restore a checkpoint into a fresh session
    delete <name>        Delete a checkpoint
    rename <old> <new>   Rename a checkpoint
    list                 List checkpoints`
        );
        return true;
      },
    });

    registration.registerHelp('/checkpoint create [name]  Save a checkpoint');
    registration.registerHelp(
      '/checkpoint restore <name> Restore a checkpoint'
    );
    registration.registerHelp('/checkpoint list          List checkpoints');

    registration.hooks.onSessionClear(async payload => {
      if (!config.autoOnSessionEnd) return;
      await writeAutoCheckpoint(
        'auto-end',
        payload?.sessionId ?? getSessionId()
      );
    });

    registration.hooks.onShutdown(async () => {
      if (!config.autoOnSessionEnd) return;
      await writeAutoCheckpoint('auto-end', getSessionId());
    });

    registration.hooks.onConversationEvent(async event => {
      if (!config.autoOnRoundComplete || event.kind !== 'roundComplete') return;
      roundOrdinal += 1;
      await writeAutoCheckpoint(`auto-round-${roundOrdinal}`, getSessionId());
    });

    const checkpointCapability: DroneCheckpointCapability = {
      runStartupRestore: async () => {
        const name = registration.getCliFlags()['restore'];
        if (typeof name !== 'string') {
          return { ok: false, summary: '' };
        }
        if (!capability) {
          return {
            ok: false,
            summary: `--checkpoint.restore: portable-context capability unavailable; skipping "${name}"`,
          };
        }
        let data;
        try {
          data = await readCheckpoint(name);
        } catch {
          return {
            ok: false,
            summary: `--checkpoint.restore: checkpoint "${name}" not found`,
          };
        }
        try {
          const result = await capability.importContext(data);
          const parts = [`Restored checkpoint "${name}" at startup.`];
          if (result.unavailableTools.length > 0) {
            parts.push(
              `Unavailable tools: ${result.unavailableTools.join(', ')}`
            );
          }
          return { ok: true, summary: parts.join(' ') };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            summary: `--checkpoint.restore: failed to restore "${name}": ${message}`,
          };
        }
      },
    };
    registration.offer(checkpointCapability);
  },
};
