import type { DronePromptFragment } from 'drone-core';

import type { SwarmMemoryRetriever } from './memory-retrieval.js';

const PITCH_LINE_MAX = 240;

function pitchOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= PITCH_LINE_MAX) return oneLine;
  return `${oneLine.slice(0, PITCH_LINE_MAX - 1)}…`;
}

/**
 * Renders each entry's pitch as `— {pitch}`. The pitch is sourced from the
 * wiki page's stored `pitch` schema field when present (field-first), falling
 * back to the best-scoring vector chunk for pages written without one.
 */

/**
 * The `# Swarm Memory (wiki)` header fragment: an advertise+recall index of
 * wiki entries relevant to the current conversation. Reads the retriever's
 * cache ONLY — never the network — so it stays cheap and synchronous at
 * prompt-build time. Returns false (hidden entirely) while disabled or
 * before the first retrieval returns.
 */
export function createSwarmMemoryFragment(
  retriever: SwarmMemoryRetriever
): DronePromptFragment {
  return {
    key: 'swarm-memory',
    phase: 'header',
    render: async () => {
      const cache = retriever.getCache();
      if (!retriever.isEnabled() || !cache || cache.entries.length === 0) {
        return false;
      }
      const lines: string[] = [
        '# Swarm Memory',
        '',
        'The following entries in swarm memory may be relevant to this conversation:',
        '',
      ];
      for (const entry of cache.entries) {
        const pitch = pitchOf(entry.pitch);
        lines.push(
          `- id: \`${entry.pageId}\` (${entry.origin}) · Title: ${entry.title} · score: ${entry.score.toFixed(2)}${pitch ? ` — ${pitch}` : ''}`
        );
      }
      lines.push('');
      lines.push(
        '---',
        'If a suggested page is relevant, call `swarm__wiki_read` to load its full contents.',
        '',
        'Pages are built from past session history and can contain useful context around ',
        'continuing work, revisiting previous decisions, and avoiding repeated mistakes.'
      );
      return lines.join('\n');
    },
  };
}
