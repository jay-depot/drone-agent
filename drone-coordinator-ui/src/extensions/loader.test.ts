import { describe, it, expect, vi } from 'vitest';
import { loadExtensionBundles } from './loader';
import type { ExtensionManifestEntry } from './types';

function entry(
  nodeId: string,
  bundles: ExtensionManifestEntry['bundles']
): ExtensionManifestEntry {
  return {
    nodeId,
    connected: true,
    protocolVersion: 1,
    capabilities: [],
    bundles,
  };
}

function deps(
  overrides: Partial<Parameters<typeof loadExtensionBundles>[1]> = {}
) {
  return {
    importModule: vi.fn().mockResolvedValue({ default: {} }),
    registerComponent: vi.fn(() => vi.fn()),
    registerRoute: vi.fn(() => vi.fn()),
    injectStylesheet: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('loadExtensionBundles', () => {
  it('registers region components + routes from a bundle', async () => {
    const Widget = () => null;
    const Page = () => null;
    const importModule = vi.fn().mockResolvedValue({
      default: {
        regions: { 'topology-widget': Widget },
        routes: [{ path: '/x', title: 'X', component: Page }],
      },
    });
    const registerComponent = vi.fn(() => vi.fn());
    const registerRoute = vi.fn(() => vi.fn());

    const result = await loadExtensionBundles(
      [
        entry('node-1', [
          { name: 'panel', version: '1', hash: 'h', scriptUrls: ['/a.js'] },
        ]),
      ],
      { ...deps(), importModule, registerComponent, registerRoute }
    );

    expect(registerComponent).toHaveBeenCalledWith(
      'topology-widget',
      Widget,
      'node-1'
    );
    expect(registerRoute).toHaveBeenCalledTimes(1);
    expect(result.loaded).toEqual(['node-1']);
  });

  it('injects stylesheets for every bundle', async () => {
    const injectStylesheet = vi.fn();
    await loadExtensionBundles(
      [
        entry('node-1', [
          {
            name: 'panel',
            version: '1',
            hash: 'h',
            scriptUrls: ['/a.js'],
            styleUrls: ['/a.css'],
          },
        ]),
      ],
      { ...deps(), injectStylesheet }
    );
    expect(injectStylesheet).toHaveBeenCalledWith('/a.css');
  });

  it('calls onReady with a working registration api', async () => {
    const onReady = vi.fn();
    const registerRoute = vi.fn(() => vi.fn());
    await loadExtensionBundles(
      [
        entry('node-1', [
          { name: 'p', version: '1', hash: 'h', scriptUrls: ['/a.js'] },
        ]),
      ],
      {
        ...deps(),
        importModule: vi.fn().mockResolvedValue({ default: { onReady } }),
        registerRoute,
      }
    );
    expect(onReady).toHaveBeenCalledTimes(1);
    const api = onReady.mock.calls[0][0];
    api.registerRoute({ path: '/y', title: 'Y', component: () => null });
    expect(registerRoute).toHaveBeenCalledTimes(1);
  });

  it('contains a failing bundle without breaking others', async () => {
    const importModule = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        default: { regions: { 'sidebar-nav': () => null } },
      });
    const registerComponent = vi.fn(() => vi.fn());
    const onError = vi.fn();

    const result = await loadExtensionBundles(
      [
        entry('node-bad', [
          { name: 'p', version: '1', hash: 'h', scriptUrls: ['/bad.js'] },
        ]),
        entry('node-good', [
          { name: 'p', version: '1', hash: 'h', scriptUrls: ['/ok.js'] },
        ]),
      ],
      { ...deps(), importModule, registerComponent, onError }
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(registerComponent).toHaveBeenCalledTimes(1);
    expect(result.loaded).toEqual(['node-good']);
  });

  it('skips a bundle whose default export is missing', async () => {
    const registerComponent = vi.fn(() => vi.fn());
    const result = await loadExtensionBundles(
      [
        entry('node-1', [
          { name: 'p', version: '1', hash: 'h', scriptUrls: ['/a.js'] },
        ]),
      ],
      {
        ...deps(),
        importModule: vi.fn().mockResolvedValue({}),
        registerComponent,
      }
    );
    expect(registerComponent).not.toHaveBeenCalled();
    expect(result.loaded).toEqual([]);
  });
});
