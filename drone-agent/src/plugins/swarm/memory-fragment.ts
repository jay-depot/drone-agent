import { MAX_PITCH_CHARS } from 'drone-swarm-common';
import type { DronePromptFragment } from 'drone-core';

import type { SwarmMemoryRetriever } from './memory-retrieval.js';

function pitchOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_PITCH_CHARS) return oneLine;
  return `${oneLine.slice(0, MAX_PITCH_CHARS)}…`;
}

/**
 * The `# Swarm Memory` footer fragment: an advertise+recall index of the
 * knowledge sources relevant to the current conversation. Wiki entries are
 * rendered from the page's stored `pitch` schema field when present
 * (field-first), falling back to the best-scoring vector chunk; workspace
 * file entries are rendered from the best-matching chunk's snippet. Reads the
 * retriever's cache ONLY — never the network — so it stays cheap and
 * synchronous at prompt-build time. Returns false (hidden entirely) while
 * disabled or before the first retrieval returns.
 */
export function createSwarmMemoryFragment(
  retriever: SwarmMemoryRetriever
): DronePromptFragment {
  return {
    key: 'swarm-memory',
    phase: 'footer',
    render: async () => {
      const cache = retriever.getCache();
      if (!retriever.isEnabled() || !cache || cache.entries.length === 0) {
        return false;
      }
      const lines: string[] = [
        '# Swarm Memory',
        '',
        'The following knowledge sources may be relevant to this conversation:',
        '',
      ];
      for (const entry of cache.entries) {
        if (entry.kind === 'wiki') {
          const pitch = pitchOf(entry.pitch);
          lines.push(
            `- wiki \`${entry.pageId}\` (${entry.origin}) · Title: ${entry.title} · score: ${entry.score.toFixed(2)}${pitch ? ` — ${pitch}` : ''}`
          );
        } else {
          const snippet = pitchOf(entry.snippet);
          lines.push(
            `- file \`${entry.filePath}\` · score: ${entry.score.toFixed(2)}${snippet ? ` — ${snippet}` : ''}`
          );
        }
      }
      lines.push('');
      lines.push(
        '---',
        'If a suggested wiki page is relevant, call `swarm__wiki_read` to load its full contents.',
        'If a suggested file is relevant, read it with `file__read`.',
        '',
        'These sources come from past session history and indexed project files, and can ',
        'contain useful context around continuing work, revisiting previous decisions, and ',
        'avoiding repeated mistakes.'
      );
      return lines.join('\n');
    },
  };
}
