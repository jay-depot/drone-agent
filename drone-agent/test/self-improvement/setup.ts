import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os, { tmpdir } from 'node:os';
import { afterEach, beforeEach, vi } from 'vitest';
import {
  createDefaultAgentConfig,
  toToolResultContent,
  type DronePlugin,
} from 'drone-core';
import { createDronePluginEngine } from '../../src/runtime/plugin-engine.js';
import { selfImprovementPlugin } from '../../src/plugins/self-improvement/index.js';
import { createTestPlugin, silentLogger } from '../helpers.js';

export function insightFilePath(
  projectDir: string,
  targetType: string,
  targetId: string
): string {
  if (targetType === 'persona') {
    return path.join(
      projectDir,
      '.drone-agent',
      'personas',
      targetId,
      'insights',
      'insights.json'
    );
  }
  return path.join(
    projectDir,
    '.drone-agent',
    'insights',
    targetType,
    `${targetId}.json`
  );
}

export function principleFilePath(
  projectDir: string,
  targetType: string,
  targetId: string
): string {
  if (targetType === 'persona') {
    return path.join(
      projectDir,
      '.drone-agent',
      'personas',
      targetId,
      'principles',
      'principles.json'
    );
  }
  return path.join(
    projectDir,
    '.drone-agent',
    'principles',
    targetType,
    `${targetId}.json`
  );
}

export function userInsightFilePath(
  targetType: string,
  targetId: string
): string {
  if (targetType === 'persona') {
    return path.join(
      os.homedir(),
      '.drone-agent',
      'personas',
      targetId,
      'insights',
      'insights.json'
    );
  }
  return path.join(
    os.homedir(),
    '.drone-agent',
    'insights',
    targetType,
    `${targetId}.json`
  );
}

export async function withTempHome<T>(
  fn: (homeDir: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'self-improvement-home-'));
  try {
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    return await fn(dir);
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
}

export async function createEngine(options?: {
  personaCapability?: unknown;
  skillsCapability?: unknown;
}): Promise<
  Omit<ReturnType<typeof createDronePluginEngine>, 'executeTool'> & {
    executeTool: (
      canonicalName: string,
      input: Record<string, unknown>,
      onProgress?: (chunk: string) => void,
      context?: import('drone-core').DroneToolExecutionContext
    ) => Promise<string>;
  }
> {
  const plugins: DronePlugin[] = [selfImprovementPlugin];

  if (options?.personaCapability !== undefined) {
    plugins.push(
      createTestPlugin({
        id: 'persona',
        defaultEnabled: true,
        capability: options.personaCapability,
      })
    );
  }

  if (options?.skillsCapability !== undefined) {
    plugins.push(
      createTestPlugin({
        id: 'skills',
        defaultEnabled: true,
        capability: options.skillsCapability,
      })
    );
  }

  const enabledPlugins = ['self-improvement'];
  if (options?.personaCapability !== undefined) {
    enabledPlugins.push('persona');
  }
  if (options?.skillsCapability !== undefined) {
    enabledPlugins.push('skills');
  }

  const engine = createDronePluginEngine({
    plugins,
    config: { ...createDefaultAgentConfig(), enabledPlugins },
    logger: silentLogger(),
  });

  await engine.initialize();
  return {
    ...engine,
    executeTool: async (
      canonicalName: string,
      input: Record<string, unknown>,
      onProgress?: (chunk: string) => void,
      context?: import('drone-core').DroneToolExecutionContext
    ) => {
      const result = await engine.executeTool(
        canonicalName,
        input,
        onProgress,
        context
      );
      return toToolResultContent(result);
    },
  };
}
