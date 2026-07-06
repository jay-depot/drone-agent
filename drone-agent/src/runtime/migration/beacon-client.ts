/**
 * Migration Service — Beacon HTTP client helpers.
 */

import { getBeaconUrl } from './helpers.js';
import type { AssetType, SwarmScope } from './types.js';

export function getBeaconEndpoint(type: AssetType): string {
  switch (type) {
    case 'persona':
      return '/personas';
    case 'skill':
      return '/skills';
    case 'insight':
      return '/insights';
    case 'principle':
      return '/principles';
    case 'wiki':
      return '/wiki';
  }
}

export function getBeaconItemEndpoint(type: AssetType, id: string): string {
  return `${getBeaconEndpoint(type)}/${encodeURIComponent(id)}`;
}

/**
 * Read a single asset from the beacon (or proxied coordinator).
 */
export async function fetchBeaconAsset(
  type: AssetType,
  id: string,
  scope?: SwarmScope,
  beaconHost?: string,
  beaconPort?: number
): Promise<Record<string, unknown> | null> {
  const baseUrl = getBeaconUrl(beaconHost, beaconPort);
  const endpoint = getBeaconItemEndpoint(type, id);
  const query = scope ? `?scope=${scope}` : '';
  try {
    const res = await fetch(`${baseUrl}${endpoint}${query}`);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * POST an asset to the beacon.
 */
export async function postBeaconAsset(
  type: AssetType,
  body: Record<string, unknown>,
  scope?: SwarmScope,
  beaconHost?: string,
  beaconPort?: number
): Promise<boolean> {
  const baseUrl = getBeaconUrl(beaconHost, beaconPort);
  const endpoint = getBeaconEndpoint(type);
  const payload = scope ? { ...body, scope } : body;
  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * PUT an asset to the beacon (for wiki pages which use PUT).
 */
export async function putBeaconAsset(
  type: AssetType,
  id: string,
  body: Record<string, unknown>,
  scope?: SwarmScope,
  beaconHost?: string,
  beaconPort?: number
): Promise<boolean> {
  const baseUrl = getBeaconUrl(beaconHost, beaconPort);
  const endpoint = getBeaconItemEndpoint(type, id);
  const payload = scope ? { ...body, scope } : body;
  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * DELETE an asset from the beacon.
 */
export async function deleteBeaconAsset(
  type: AssetType,
  id: string,
  scope?: SwarmScope,
  beaconHost?: string,
  beaconPort?: number
): Promise<boolean> {
  const baseUrl = getBeaconUrl(beaconHost, beaconPort);
  const endpoint = getBeaconItemEndpoint(type, id);
  const query = scope ? `?scope=${scope}` : '';
  try {
    const res = await fetch(`${baseUrl}${endpoint}${query}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}
