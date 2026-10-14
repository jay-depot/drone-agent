import { describe, expect, it } from 'vitest';
import {
  createExtensionInjectionStore,
  type InjectionBudget,
} from '../../../src/plugins/extensions/injection-store.js';

describe('ExtensionInjectionStore — fragments', () => {
  it('applies, updates, and removes a fragment', () => {
    const store = createExtensionInjectionStore();
    expect(
      store.applyFragment({
        extensionId: 'ext-1',
        injectionId: 'frag-1',
        content: '# Hello',
      })
    ).toBe('added');

    // identical content is a no-op
    expect(
      store.applyFragment({
        extensionId: 'ext-1',
        injectionId: 'frag-1',
        content: '# Hello',
      })
    ).toBe('unchanged');

    expect(
      store.applyFragment({
        extensionId: 'ext-1',
        injectionId: 'frag-1',
        content: '# Updated',
      })
    ).toBe('updated');

    expect(store.remove('ext-1', 'frag-1')).toBe(true);
    expect(store.remove('ext-1', 'frag-1')).toBe(false);
  });

  it('renders header and footer buckets separately', () => {
    const store = createExtensionInjectionStore();
    store.applyFragment({
      extensionId: 'ext-1',
      injectionId: 'h',
      content: 'header body',
      phase: 'header',
    });
    store.applyFragment({
      extensionId: 'ext-1',
      injectionId: 'f',
      content: 'footer body',
      phase: 'footer',
    });

    const header = store.renderHeader();
    expect(header).toContain('# Extension Injections');
    expect(header).toContain('header body');
    expect(header).not.toContain('footer body');

    const footer = store.renderFooter();
    expect(footer).toContain('footer body');
  });

  it('hides an empty bucket', () => {
    const store = createExtensionInjectionStore();
    expect(store.renderHeader()).toBe(false);
    expect(store.renderFooter()).toBe(false);
  });

  it('enforces the byte budget', () => {
    const budget: InjectionBudget = { maxBytes: 10, maxInjections: 20 };
    const store = createExtensionInjectionStore(budget);
    expect(
      store.applyFragment({
        extensionId: 'ext-1',
        injectionId: 'frag-1',
        content: 'x'.repeat(11),
      })
    ).toBe('rejected');
    expect(store.renderHeader()).toBe(false);
  });

  it('enforces the injection-count budget', () => {
    const budget: InjectionBudget = { maxBytes: 50 * 1024, maxInjections: 2 };
    const store = createExtensionInjectionStore(budget);
    expect(
      store.applyFragment({
        extensionId: 'e',
        injectionId: 'a',
        content: 'x',
      })
    ).toBe('added');
    expect(
      store.applyFragment({
        extensionId: 'e',
        injectionId: 'b',
        content: 'x',
      })
    ).toBe('added');
    expect(
      store.applyFragment({
        extensionId: 'e',
        injectionId: 'c',
        content: 'x',
      })
    ).toBe('rejected');
  });

  it('budgets per extension (one extension cannot crowd out another)', () => {
    const budget: InjectionBudget = { maxBytes: 50 * 1024, maxInjections: 1 };
    const store = createExtensionInjectionStore(budget);
    store.applyFragment({ extensionId: 'a', injectionId: '1', content: 'x' });
    expect(
      store.applyFragment({ extensionId: 'b', injectionId: '1', content: 'x' })
    ).toBe('added');
  });
});

describe('ExtensionInjectionStore — tool selections', () => {
  it('applies, dedupes, and removes tool selections', () => {
    const store = createExtensionInjectionStore();
    expect(
      store.applyToolSelection({
        extensionId: 'ext-1',
        injectionId: 'tools-1',
        tools: [{ capability: 'a' }, { capability: 'b' }],
      })
    ).toBe('added');

    expect(
      store.applyToolSelection({
        extensionId: 'ext-1',
        injectionId: 'tools-1',
        tools: [{ capability: 'a' }, { capability: 'b' }],
      })
    ).toBe('unchanged');

    store.removeTools('ext-1', ['a']);
    const remaining = store
      .list()
      .flatMap(i => i.tools.map(t => t.capability));
    expect(remaining).toEqual(['b']);
  });

  it('removes the whole selection when the last tool is dropped', () => {
    const store = createExtensionInjectionStore();
    store.applyToolSelection({
      extensionId: 'ext-1',
      injectionId: 'tools-1',
      tools: [{ capability: 'a' }],
    });
    store.removeTools('ext-1', ['a']);
    expect(store.list()).toEqual([]);
  });
});

describe('ExtensionInjectionStore — clearing', () => {
  it('clears one extension without touching another', () => {
    const store = createExtensionInjectionStore();
    store.applyFragment({ extensionId: 'a', injectionId: '1', content: 'x' });
    store.applyFragment({ extensionId: 'b', injectionId: '1', content: 'y' });
    store.clearExtension('a');
    expect(store.listExtensions()).toEqual(['b']);
  });

  it('clearAll drops everything', () => {
    const store = createExtensionInjectionStore();
    store.applyFragment({ extensionId: 'a', injectionId: '1', content: 'x' });
    store.clearAll();
    expect(store.list()).toEqual([]);
  });
});
