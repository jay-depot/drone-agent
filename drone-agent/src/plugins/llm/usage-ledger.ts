import type { DroneLlmUsage, DroneLlmUsageLedgerEntry } from 'drone-core';

/**
 * Session-lifetime ledger of provider-reported LLM usage. The llm broker
 * records one entry per successful broker-routed chat call (main rounds,
 * model roles, the image describer) and resets it on session clear.
 */
export function createUsageLedger() {
  const entries: DroneLlmUsageLedgerEntry[] = [];

  return {
    record(input: {
      providerId: string;
      model: string;
      role?: string;
      usage: DroneLlmUsage;
    }): void {
      entries.push({ ...input, at: Date.now() });
    },
    clear(): void {
      entries.length = 0;
    },
    getAll(): readonly DroneLlmUsageLedgerEntry[] {
      return entries;
    },
  };
}

export type UsageLedger = ReturnType<typeof createUsageLedger>;
