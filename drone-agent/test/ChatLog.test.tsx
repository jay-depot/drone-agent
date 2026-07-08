/**
 * Tests for ChatLog — committed scrollback rendering.
 *
 * The refactor carries a pre-rendered `node` on committed entries (from
 * the tail region). ChatLog must render `entry.node` inside <Static>
 * when present, and only fall back to renderEntry(text) when it is absent.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ChatLog } from '../src/tui/components/ChatLog.js';
import { DEFAULT_GRAYSCALE_SCHEME } from '../src/tui/theme.js';
import type { ChatEntry } from '../src/tui/types.js';

type Opts = Parameters<typeof ChatLog>[0];

function renderChatLog(entries: ChatEntry[]): ReturnType<typeof render> {
  return render(
    <ChatLog
      entries={entries}
      tailItems={[]}
      scheme={DEFAULT_GRAYSCALE_SCHEME}
    />
  );
}

const tick = () => new Promise(r => setTimeout(r, 0));

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
        node: <span>RENDERED_NODE_MARKER</span>,
      },
    ];
    const inst = renderChatLog(entries);
    instance = inst;
    await tick();
    const frame = inst.lastFrame() ?? '';
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
    await tick();
    const frame = inst.lastFrame() ?? '';
    expect(frame).toContain('plain info line');
    expect(frame).toContain('hello there');
  });

  it('renders a markdown entry through the Markdown component when no node', async () => {
    const entries: ChatEntry[] = [
      { id: '1', kind: 'markdown', text: '# Heading' },
    ];
    const inst = renderChatLog(entries);
    instance = inst;
    await tick();
    const frame = inst.lastFrame() ?? '';
    // Markdown heading text survives (rendering is component-driven).
    expect(frame).toContain('Heading');
  });
});
