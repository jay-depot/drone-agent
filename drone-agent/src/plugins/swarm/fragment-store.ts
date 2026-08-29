/**
 * Pure, in-memory fragment store for the swarm plugin.
 *
 * Holds the current fragment set delivered by the beacon (targeted rows +
 * broadcasts, merged and TTL-filtered server-side) and renders the two
 * prompt seams. No network I/O — the beacon pushes deltas (`fragment`)
 * and full-state resyncs (`fragmentSync`) over WS; render() only reads
 * this Map so prompt rendering never blocks on the swarm.
 */

import type { DroneSwarmFragment } from 'drone-core';

type StoredFragment = Pick<
  DroneSwarmFragment,
  'id' | 'target' | 'content' | 'phase'
>;

export type FragmentApplyResult = 'added' | 'updated' | 'unchanged';

export type FragmentReplaceResult = 'changed' | 'unchanged';

export interface SwarmFragmentStore {
  applySet(fragment: DroneSwarmFragment): FragmentApplyResult;
  applyRemove(id: string, target: string): boolean;
  replaceAll(fragments: DroneSwarmFragment[]): FragmentReplaceResult;
  renderHeader(): string | false;
  renderFooter(): string | false;
  size(): number;
}

function fragmentKey(
  fragment: Pick<DroneSwarmFragment, 'id' | 'target'>
): string {
  return `${fragment.target}\u0000${fragment.id}`;
}

function renderBucket(
  heading: string,
  fragments: StoredFragment[]
): string | false {
  if (fragments.length === 0) {
    return false;
  }
  const sorted = [...fragments].sort((a, b) => a.id.localeCompare(b.id));
  const blocks = sorted.map(f => `## [${f.id}]\n\n${f.content}`);
  return `# ${heading}\n\n${blocks.join('\n\n')}`;
}

function renderAll(map: Map<string, StoredFragment>): {
  header: string;
  footer: string;
} {
  const values = Array.from(map.values());
  return {
    header:
      renderBucket(
        'Swarm Fragments',
        values.filter(f => f.phase === 'header')
      ) || '',
    footer:
      renderBucket(
        'Swarm Directives',
        values.filter(f => f.phase === 'footer')
      ) || '',
  };
}

export function createSwarmFragmentStore(): SwarmFragmentStore {
  const fragments = new Map<string, StoredFragment>();

  return {
    applySet(fragment) {
      const key = fragmentKey(fragment);
      const existing = fragments.get(key);
      if (
        existing &&
        existing.content === fragment.content &&
        existing.phase === fragment.phase
      ) {
        return 'unchanged';
      }
      fragments.set(key, {
        id: fragment.id,
        target: fragment.target,
        content: fragment.content,
        phase: fragment.phase,
      });
      return existing ? 'updated' : 'added';
    },

    applyRemove(id, target) {
      const key = fragmentKey({ id, target });
      return fragments.delete(key);
    },

    replaceAll(next) {
      const before = renderAll(fragments);
      fragments.clear();
      for (const fragment of next) {
        fragments.set(fragmentKey(fragment), {
          id: fragment.id,
          target: fragment.target,
          content: fragment.content,
          phase: fragment.phase,
        });
      }
      const after = renderAll(fragments);
      if (before.header === after.header && before.footer === after.footer) {
        return 'unchanged';
      }
      return 'changed';
    },

    renderHeader() {
      return renderBucket(
        'Swarm Fragments',
        Array.from(fragments.values()).filter(f => f.phase === 'header')
      );
    },

    renderFooter() {
      return renderBucket(
        'Swarm Directives',
        Array.from(fragments.values()).filter(f => f.phase === 'footer')
      );
    },

    size() {
      return fragments.size;
    },
  };
}
