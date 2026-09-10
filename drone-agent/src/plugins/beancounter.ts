import type {
  DroneLlmCapability,
  DroneLlmUsageLedgerEntry,
  DronePlugin,
} from 'drone-core';

function totalTokens(entries: readonly DroneLlmUsageLedgerEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.usage.totalTokens, 0);
}

function totalCost(entries: readonly DroneLlmUsageLedgerEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.usage.cost ?? 0), 0);
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export const beancounterPlugin: DronePlugin = {
  metadata: {
    id: 'beancounter',
    name: 'Beancounter',
    version: '0.1.0',
    description:
      'Mid-bar display of provider-reported session token usage and cost.',
    defaultEnabled: false,
    dependencies: [{ id: 'llm' }],
  },
  register: async registration => {
    const llm = registration.request<DroneLlmCapability>('llm');
    if (!llm) {
      registration.logger.warn(
        'LLM broker not available; beancounter has no usage to display'
      );
      return;
    }

    registration.offer({
      id: 'beancounter',
      label: 'USED',
      getContent: () => {
        const entries = llm.getUsageLedger();
        if (entries.length === 0) {
          return [];
        }
        return [
          `${formatTokens(totalTokens(entries))} tok · $${totalCost(entries).toFixed(4)}`,
        ];
      },
    });

    registration.registerHelp(
      'beancounter        Mid-bar session token & cost display (provider-reported usage)'
    );
  },
};
