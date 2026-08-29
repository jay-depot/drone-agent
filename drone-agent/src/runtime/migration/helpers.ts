/**
 * Migration Service — helper functions for resolving directories and beacon URLs.
 */

import os from 'node:os';
import type { DroneAgentConfig } from 'drone-core';

const DEFAULT_BEACON_HOST = 'localhost';
const DEFAULT_BEACON_PORT = 3457;

export function getProjectDir(): string {
  return process.cwd();
}

export function getUserDir(): string {
  return os.homedir();
}

export function getLocalBaseDir(scope: 'project' | 'user'): string {
  return scope === 'user' ? getUserDir() : getProjectDir();
}

export function getBeaconUrl(host?: string, port?: number): string {
  const h = host ?? DEFAULT_BEACON_HOST;
  const p = port ?? DEFAULT_BEACON_PORT;
  return `http://${h}:${p}`;
}

export function getConfigBeaconHost(
  config?: Partial<DroneAgentConfig>
): string | undefined {
  return config?.swarm?.beaconHost;
}

export function getConfigBeaconPort(
  config?: Partial<DroneAgentConfig>
): number | undefined {
  return config?.swarm?.beaconPort;
}
