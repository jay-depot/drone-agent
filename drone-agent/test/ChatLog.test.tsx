/**
 * Tests for ChatLog — committed scrollback rendering.
 *
 * The refactor carries a pre-rendered `node` on committed entries (from
 * the tail region). ChatLog must render `entry.node` inside <Static>
 * when present, and only fall back to renderEntry(text) when it is absent.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { ChatLog } from '../src/tui/components/ChatLog.js';
import { DEFAULT_GRAYSCALE_SCHEME } from '../src/tui/theme.js';
import type { ChatEntry } from '../src/tui/types.js';

function renderChatLog(entries: ChatEntry[]): ReturnType<typeof render> {
  return render(
    <ChatLog
      entries={entries}
      tailItems={[]}
      scheme={DEFAULT_GRAYSCALE_SCHEME}
    />
  );
}

/**
 * Poll until `lastFrame()` satisfies `predicate` or `timeoutMs` elapses.
 *
 * Ink renders asynchronously; a fixed `setTimeout(0)` is NOT a reliable
 * barrier and flakes on slower CI runners (lastFrame() returns the empty
 * pre-render frame). We instead wait for the specific content to actually
 * appear in the output.
 */
async function waitUntilFrame(
  inst: ReturnType<typeof render>,
  predicate: (frame: string) => boolean,
  timeoutMs = 1000
): Promise<string> {
  const start = Date.now();
  let frame = inst.lastFrame() ?? '';
  while (!predicate(frame) && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10));
    frame = inst.lastFrame() ?? '';
  }
  return frame;
}

describe('ChatLog', () => {
  let instance: ReturnType<typeof render> | null = null;
  afterEach(() => {
    instance?.cleanup();
    instance = null;
  });

  it('renders entry.node when present, ignoring the plain text fallback', async () => {
    // `text` carries a marker that must NOT appear because the node wins.
    const entries: ChatEntry[] = [
      {
        id: '1',
        kind: 'markdown',
        text: 'FALLBACK_TEXT_SHOULD_NOT_APPEAR',
        node: <Text>RENDERED_NODE_MARKER</Text>,
      },
    ];
    const inst = renderChatLog(entries);
    instance = inst;
    const frame = await waitUntilFrame(inst, f =>
      f.includes('RENDERED_NODE_MARKER')
    );
    expect(frame).toContain('RENDERED_NODE_MARKER');
    expect(frame).not.toContain('FALLBACK_TEXT_SHOULD_NOT_APPEAR');
  });

  it('falls back to renderEntry(text) when node is absent', async () => {
    const entries: ChatEntry[] = [
      { id: '1', kind: 'info', text: 'plain info line' },
      { id: '2', kind: 'user', text: 'hello there' },
    ];
    const inst = renderChatLog(entries);
    instance = inst;
    const frame = await waitUntilFrame(inst, f =>
      f.includes('plain info line')
    );
    expect(frame).toContain('plain info line');
    expect(frame).toContain('hello there');
  });

  it('renders a markdown entry through the Markdown component when no node', async () => {
    const entries: ChatEntry[] = [
      { id: '1', kind: 'markdown', text: '# Heading' },
    ];
    const inst = renderChatLog(entries);
    instance = inst;
    const frame = await waitUntilFrame(inst, f => f.includes('Heading'));
    // Markdown heading text survives (rendering is component-driven).
    expect(frame).toContain('Heading');
  });

  it('renders markdown lists without crashing on marked list-item objects', async () => {
    const entries: ChatEntry[] = [
      {
        id: '1',
        kind: 'markdown',
        text: ['- alpha', '- beta', '', '1. first', '2. second'].join('\n'),
      },
    ];

    const inst = renderChatLog(entries);
    instance = inst;
    const frame = await waitUntilFrame(inst, f => f.includes('alpha'));

    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
    expect(frame).toContain('first');
    expect(frame).toContain('second');
  });
});
