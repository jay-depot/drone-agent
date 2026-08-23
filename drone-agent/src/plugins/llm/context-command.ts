import type {
  DroneLlmCapability,
  DronePlugin,
} from 'drone-core';

/**
 * `/context` — the inspectable surface for context-window resolution.
 * Decision 156's provenance log line lands nowhere durable, so this command
 * answers "why is this number weird?" at the moment of suspicion: which slot
 * supplied the window (metadata catalog, driver probe detail, config
 * fallback), how much headroom remains, and what is reserved for responses.
 * Doubles as the acceptance tool for driver-side window-resolution changes.
 */
export function registerContextCommand(
  registration: Parameters<DronePlugin['register']>[0],
  llm: DroneLlmCapability
): void {
  registration.registerSlashCommand({
    command: '/context',
    description:
      'Show the active model, its resolved context window + provenance, and estimated usage.',
    handler: async ctx => {
      let provider;
      try {
        provider = llm.getActiveProvider();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`No active LLM provider: ${msg}`);
        return true;
      }

      const model = llm.getModel();
      const info = await provider.getContextWindowInfo?.({ model });
      if (!info || !(info.contextWindowTokens > 0)) {
        ctx.logger.warn(
          'Context window unavailable for the active model (probe returned nothing).'
        );
        return true;
      }

      const detailSuffix = info.detail ? `, ${info.detail}` : '';
      const lines = [
        `Model: ${llm.getActiveProviderId()}/${model}`,
        `Context window: ${info.contextWindowTokens.toLocaleString()} tokens (source: ${info.source}${detailSuffix})`,
      ];

      const sessionConfig = ctx.engine.getConfig?.()?.session;
      if (sessionConfig?.responseReserveTokens) {
        lines.push(
          `Response reserve: ${sessionConfig.responseReserveTokens.toLocaleString()} tokens`
        );
      }

      if (ctx.conversation?.getEstimatedContextUsagePercent) {
        try {
          const percent =
            await ctx.conversation.getEstimatedContextUsagePercent();
          lines.push(`Estimated usage: ${percent.toFixed(1)}%`);
        } catch {
          // Usage estimation is best-effort display data; never fail the
          // command over it.
        }
      }

      ctx.logger.info(lines.join('\n'));
      return true;
    },
  });
}
