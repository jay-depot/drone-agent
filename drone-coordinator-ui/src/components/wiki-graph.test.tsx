import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { WikiGraphEdge, WikiGraphNode } from '@/lib/types';
import WikiGraphView, { type ForceGraphHandle } from './wiki-graph';

function makeFakeHandle() {
  const handle = {} as ForceGraphHandle & {
    _destructor: ReturnType<typeof vi.fn>;
    graphData: ReturnType<typeof vi.fn>;
    nodeId: ReturnType<typeof vi.fn>;
    linkSource: ReturnType<typeof vi.fn>;
    linkTarget: ReturnType<typeof vi.fn>;
    nodeRelSize: ReturnType<typeof vi.fn>;
    nodeColor: ReturnType<typeof vi.fn>;
    linkDirectionalArrowLength: ReturnType<typeof vi.fn>;
    linkWidth: ReturnType<typeof vi.fn>;
    linkColor: ReturnType<typeof vi.fn>;
    onNodeClick: ReturnType<typeof vi.fn>;
    onBackgroundClick: ReturnType<typeof vi.fn>;
    width: ReturnType<typeof vi.fn>;
    height: ReturnType<typeof vi.fn>;
    zoomToFit: ReturnType<typeof vi.fn>;
  };

  const chain = () => handle as unknown as ForceGraphHandle;
  handle.graphData = vi.fn(chain);
  handle.nodeId = vi.fn(chain);
  handle.linkSource = vi.fn(chain);
  handle.linkTarget = vi.fn(chain);
  handle.nodeRelSize = vi.fn(chain);
  handle.nodeColor = vi.fn(chain);
  handle.linkDirectionalArrowLength = vi.fn(chain);
  handle.linkWidth = vi.fn(chain);
  handle.linkColor = vi.fn(chain);
  handle.onNodeClick = vi.fn(chain);
  handle.onBackgroundClick = vi.fn(chain);
  handle.width = vi.fn(chain);
  handle.height = vi.fn(chain);
  handle.zoomToFit = vi.fn(chain);
  handle._destructor = vi.fn();

  return handle;
}

const nodes: WikiGraphNode[] = [
  { id: 'a', title: 'A', exists: true, tags: [], scope: 'coordinator' },
  { id: 'b', title: 'B', exists: false, tags: [], scope: 'coordinator' },
];
const edges: WikiGraphEdge[] = [{ source: 'a', target: 'b', kind: 'link' }];

describe('WikiGraphView', () => {
  let handle: ReturnType<typeof makeFakeHandle>;

  beforeEach(() => {
    handle = makeFakeHandle();
  });

  const renderView = (
    props: Partial<Parameters<typeof WikiGraphView>[0]> = {}
  ) =>
    render(
      <WikiGraphView
        nodes={nodes}
        edges={edges}
        onNodeFocus={vi.fn()}
        onClearFocus={vi.fn()}
        forceGraphFactory={() => handle as unknown as ForceGraphHandle}
        {...props}
      />
    );

  it('instantiates the graph and pushes data with the expected shape', async () => {
    renderView();

    await waitFor(() => {
      expect(handle.graphData).toHaveBeenCalledWith({ nodes, links: edges });
    });
    expect(handle.nodeId).toHaveBeenCalledWith('id');
    expect(handle.linkSource).toHaveBeenCalledWith('source');
    expect(handle.linkTarget).toHaveBeenCalledWith('target');
  });

  it('wires node click to focus and background to clear', async () => {
    const onNodeFocus = vi.fn();
    const onClearFocus = vi.fn();
    renderView({ onNodeFocus, onClearFocus });

    await waitFor(() => {
      expect(handle.onNodeClick).toHaveBeenCalled();
    });

    const nodeClickCb = handle.onNodeClick.mock.calls[0][0] as (
      node: WikiGraphNode
    ) => void;
    const bgClickCb = handle.onBackgroundClick.mock.calls[0][0] as () => void;

    nodeClickCb({ ...nodes[0] });
    expect(onNodeFocus).toHaveBeenCalledWith('a');

    bgClickCb();
    expect(onClearFocus).toHaveBeenCalled();
  });

  it('applies a link color matching the current theme', async () => {
    // Ensure light root before rendering.
    document.documentElement.classList.remove('dark');
    renderView();

    await waitFor(() => {
      expect(handle.linkColor).toHaveBeenCalled();
    });
    expect(handle.linkColor).toHaveBeenLastCalledWith(
      'rgba(148, 163, 184, 0.55)'
    );
  });

  it('re-applies the dark link color when the root flips to dark', async () => {
    document.documentElement.classList.remove('dark');
    renderView();
    await waitFor(() => {
      expect(handle.linkColor).toHaveBeenCalled();
    });

    document.documentElement.classList.add('dark');
    // MutationObserver should fire synchronously after the class mutation.
    await waitFor(() => {
      expect(handle.linkColor).toHaveBeenLastCalledWith(
        'rgba(148, 163, 184, 0.35)'
      );
    });

    document.documentElement.classList.remove('dark');
  });

  it('renders a container for the graph', () => {
    renderView();
    expect(screen.getByTestId('wiki-graph-container')).toBeDefined();
  });

  it('uses a larger node size when a node is focused', async () => {
    renderView({ focusedNodeId: 'a' });

    await waitFor(() => {
      expect(handle.nodeRelSize).toHaveBeenCalledWith(10);
    });
  });

  it('destructs the graph on unmount', async () => {
    const { unmount } = renderView();
    await waitFor(() => {
      expect(handle.graphData).toHaveBeenCalled();
    });
    unmount();
    expect(handle._destructor).toHaveBeenCalled();
  });
});
