import type { DroneExtensionManifest } from 'drone-core';

/**
 * In-memory registry of connected nodes that have declared a capability
 * manifest. A node is an "extension" iff it declares a manifest; the manifest
 * is replaced wholesale on re-declaration and dropped on disconnect.
 *
 * Also tracks each extension's outstanding injections so a disconnect can be
 * cleaned up exactly (send `injectRemove` for every tuple the node pushed).
 */

export interface ExtensionInjectionRecord {
  target: string;
  injectionId: string;
  kind: 'fragment' | 'reminder' | 'tools';
  hostBeaconId: string;
  tools?: Array<{ capability: string }>;
}

interface ExtensionNodeState {
  manifest: DroneExtensionManifest;
  injections: Map<string, ExtensionInjectionRecord>;
}

const nodes = new Map<string, ExtensionNodeState>();

function injectionKey(target: string, injectionId: string): string {
  return `${target}:${injectionId}`;
}

export function setManifest(
  nodeId: string,
  manifest: DroneExtensionManifest
): void {
  const existing = nodes.get(nodeId);
  nodes.set(nodeId, {
    manifest,
    injections: existing?.injections ?? new Map(),
  });
}

export function getManifest(nodeId: string): DroneExtensionManifest | undefined {
  return nodes.get(nodeId)?.manifest;
}

export function clearManifest(nodeId: string): void {
  nodes.delete(nodeId);
}

export function isExtension(nodeId: string): boolean {
  return nodes.has(nodeId);
}

export function listExtensionNodeIds(): string[] {
  return [...nodes.keys()];
}

export function listManifests(): Array<{
  nodeId: string;
  manifest: DroneExtensionManifest;
}> {
  return [...nodes.entries()].map(([nodeId, state]) => ({
    nodeId,
    manifest: state.manifest,
  }));
}

export function recordInjection(
  nodeId: string,
  record: ExtensionInjectionRecord
): void {
  const state = nodes.get(nodeId);
  if (!state) return;
  state.injections.set(injectionKey(record.target, record.injectionId), record);
}

export function removeInjectionRecord(
  nodeId: string,
  target: string,
  injectionId: string
): void {
  nodes.get(nodeId)?.injections.delete(injectionKey(target, injectionId));
}

export function listInjections(nodeId: string): ExtensionInjectionRecord[] {
  const state = nodes.get(nodeId);
  return state ? [...state.injections.values()] : [];
}

/** Test helper: drop all registered extensions and their injection records. */
export function resetExtensionRegistry(): void {
  nodes.clear();
}
