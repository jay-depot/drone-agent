import type { DronePromptFragment } from 'drone-core';
import type { ExtensionInjectionStore } from './injection-store.js';

/**
 * Prompt fragments rendering the extension-injected fragments. Registered
 * AFTER the swarm fragments so injected content is ordered after the
 * built-ins. Each returns false when there is nothing to inject, so the
 * fragment disappears entirely rather than emitting an empty heading.
 */
export function createInjectionHeaderFragment(
  store: ExtensionInjectionStore
): DronePromptFragment {
  return {
    key: 'extensions-header',
    phase: 'header',
    render: async () => store.renderHeader(),
  };
}

export function createInjectionFooterFragment(
  store: ExtensionInjectionStore
): DronePromptFragment {
  return {
    key: 'extensions-footer',
    phase: 'footer',
    render: async () => store.renderFooter(),
  };
}
