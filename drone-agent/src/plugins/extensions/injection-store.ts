import type { DroneInjectedToolSelection } from 'drone-core';

/**
 * In-memory injection store for the extensions plugin.
 *
 * Holds the injections a swarm extension has pushed into this session,
 * keyed by `(extensionId, injectionId)`. Fragments render into the prompt
 * seams; tool selections are reconciled into the tool registry elsewhere.
 * Own budget per extension (byte + count) so one extension cannot crowd out
 * the prompt or the tool list.
 */

export type InjectionKind = 'fragment' | 'reminder' | 'tools';

export interface StoredInjection {
  extensionId: string;
  injectionId: string;
  kind: InjectionKind;
  /** Fragment content (kind='fragment'). */
  content?: string;
  /** Fragment prompt seam (kind='fragment'). */
  phase: 'header' | 'footer';
  /** Tool capability selections (kind='tools'). */
  tools: DroneInjectedToolSelection[];
  /** Epoch ms of the last upsert (for budget accounting + TTL). */
  updatedAt: number;
}

export interface ApplyFragmentInput {
  extensionId: string;
  injectionId: string;
  content: string;
  phase?: 'header' | 'footer';
}

export type ApplyResult = 'added' | 'updated' | 'unchanged' | 'rejected';

export interface ExtensionInjectionStore {
  applyFragment(input: ApplyFragmentInput): ApplyResult;
  applyToolSelection(input: {
    extensionId: string;
    injectionId: string;
    tools: DroneInjectedToolSelection[];
  }): ApplyResult;
  remove(extensionId: string, injectionId: string): boolean;
  removeTools(extensionId: string, tools: string[]): void;
  clearExtension(extensionId: string): void;
  clearAll(): void;
  renderHeader(): string | false;
  renderFooter(): string | false;
  list(): StoredInjection[];
  listExtensions(): string[];
}

export interface InjectionBudget {
  maxBytes: number;
  maxInjections: number;
}

export const DEFAULT_INJECTION_BUDGET: InjectionBudget = {
  maxBytes: 50 * 1024,
  maxInjections: 20,
};

function injectionKey(extensionId: string, injectionId: string): string {
  return `${extensionId}\u0000${injectionId}`;
}

function renderBucket(
  heading: string,
  fragments: StoredInjection[]
): string | false {
  if (fragments.length === 0) return false;
  const sorted = [...fragments].sort((a, b) =>
    `${a.extensionId}/${a.injectionId}`.localeCompare(
      `${b.extensionId}/${b.injectionId}`
    )
  );
  const blocks = sorted.map(
    f => `## [${f.extensionId}/${f.injectionId}]\n\n${f.content ?? ''}`
  );
  return `# ${heading}\n\n${blocks.join('\n\n')}`;
}

export function createExtensionInjectionStore(
  budget: InjectionBudget = DEFAULT_INJECTION_BUDGET
): ExtensionInjectionStore {
  const injections = new Map<string, StoredInjection>();

  function bytesForExtension(extensionId: string): number {
    let total = 0;
    for (const inj of injections.values()) {
      if (inj.extensionId !== extensionId) continue;
      total += inj.content?.length ?? 0;
      total += inj.tools.map(t => t.capability).join('').length;
    }
    return total;
  }

  function countForExtension(extensionId: string): number {
    let total = 0;
    for (const inj of injections.values()) {
      if (inj.extensionId === extensionId) total += 1;
    }
    return total;
  }

  return {
    applyFragment({ extensionId, injectionId, content, phase = 'header' }) {
      const key = injectionKey(extensionId, injectionId);
      const existing = injections.get(key);
      if (
        existing &&
        existing.kind === 'fragment' &&
        existing.content === content &&
        existing.phase === phase
      ) {
        return 'unchanged';
      }
      if (!existing && countForExtension(extensionId) >= budget.maxInjections) {
        return 'rejected';
      }
      const previousBytes = existing?.content?.length ?? 0;
      const nextBytes =
        bytesForExtension(extensionId) - previousBytes + content.length;
      if (nextBytes > budget.maxBytes) {
        return 'rejected';
      }
      injections.set(key, {
        extensionId,
        injectionId,
        kind: 'fragment',
        content,
        phase,
        tools: [],
        updatedAt: Date.now(),
      });
      return existing ? 'updated' : 'added';
    },

    applyToolSelection({ extensionId, injectionId, tools }) {
      const key = injectionKey(extensionId, injectionId);
      const existing = injections.get(key);
      if (existing && existing.kind === 'tools') {
        const same =
          existing.tools.length === tools.length &&
          existing.tools.every(
            (t, i) =>
              t.capability === tools[i].capability &&
              t.description === tools[i].description
          );
        if (same) return 'unchanged';
      }
      if (!existing && countForExtension(extensionId) >= budget.maxInjections) {
        return 'rejected';
      }
      injections.set(key, {
        extensionId,
        injectionId,
        kind: 'tools',
        phase: 'header',
        tools,
        updatedAt: Date.now(),
      });
      return existing ? 'updated' : 'added';
    },

    remove(extensionId, injectionId) {
      return injections.delete(injectionKey(extensionId, injectionId));
    },

    removeTools(extensionId, tools) {
      const wanted = new Set(tools);
      for (const [key, inj] of injections) {
        if (inj.extensionId !== extensionId || inj.kind !== 'tools') continue;
        const remaining = inj.tools.filter(t => !wanted.has(t.capability));
        if (remaining.length === 0) {
          injections.delete(key);
        } else {
          inj.tools = remaining;
        }
      }
    },

    clearExtension(extensionId) {
      for (const [key, inj] of injections) {
        if (inj.extensionId === extensionId) injections.delete(key);
      }
    },

    clearAll() {
      injections.clear();
    },

    renderHeader() {
      return renderBucket(
        'Extension Injections',
        [...injections.values()].filter(
          i => i.kind === 'fragment' && i.phase === 'header'
        )
      );
    },

    renderFooter() {
      return renderBucket(
        'Extension Injections',
        [...injections.values()].filter(
          i => i.kind === 'fragment' && i.phase === 'footer'
        )
      );
    },

    list() {
      return [...injections.values()];
    },

    listExtensions() {
      return [...new Set([...injections.values()].map(i => i.extensionId))];
    },
  };
}
