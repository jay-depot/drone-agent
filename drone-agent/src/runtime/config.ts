import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  applyAgentConfigLayer,
  createDefaultAgentConfig,
  parseConfigWithSchema,
  type DroneConfigLayer,
  type DroneResolvedConfig,
} from 'drone-core';

export const CONFIG_DIRECTORY_NAME = '.drone-agent';
export const CONFIG_FILE_NAME = 'config.json';

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfigLayer(
  scope: DroneConfigLayer['scope'],
  filePath: string
): Promise<DroneConfigLayer | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }

  const fileContents = await readFile(filePath, 'utf-8');
  const parsed = parseConfigWithSchema(JSON.parse(fileContents), filePath);

  return {
    scope,
    path: filePath,
    config: parsed,
  };
}

export async function findProjectConfigPath(
  startDirectory: string
): Promise<string | undefined> {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    const candidate = path.join(
      currentDirectory,
      CONFIG_DIRECTORY_NAME,
      CONFIG_FILE_NAME
    );
    if (await pathExists(candidate)) {
      return candidate;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

export async function loadAgentConfig(
  startDirectory: string
): Promise<DroneResolvedConfig> {
  const layers: DroneConfigLayer[] = [
    {
      scope: 'default',
      config: createDefaultAgentConfig(),
    },
  ];

  const userConfigPath = path.join(
    os.homedir(),
    CONFIG_DIRECTORY_NAME,
    CONFIG_FILE_NAME
  );
  const userLayer = await loadConfigLayer('user', userConfigPath);
  if (userLayer) {
    layers.push(userLayer);
  }

  const projectConfigPath = await findProjectConfigPath(startDirectory);
  if (projectConfigPath) {
    const projectLayer = await loadConfigLayer('project', projectConfigPath);
    if (projectLayer) {
      layers.push(projectLayer);
    }
  }

  let mergedConfig = createDefaultAgentConfig();
  for (const layer of layers) {
    mergedConfig = applyAgentConfigLayer(mergedConfig, layer.config);
  }

  return {
    config: mergedConfig,
    layers,
  };
}
