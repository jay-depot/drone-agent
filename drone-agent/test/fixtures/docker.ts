/**
 * Docker Container Management Utilities
 *
 * Provides utilities for managing Docker containers during integration testing.
 */

import { spawn, exec, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const execAsync = promisify(exec);

/**
 * Container health status
 */
export type ContainerHealth = 'healthy' | 'unhealthy' | 'starting' | 'unknown';

/**
 * Container information
 */
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  health: ContainerHealth;
  ports: Record<string, string>;
}

/**
 * Docker command helper
 */
async function dockerCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', data => {
      stdout += data.toString();
    });
    child.stderr?.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`docker ${args.join(' ')} failed: ${stderr}`));
      }
    });

    child.on('error', err => {
      reject(err);
    });
  });
}

/**
 * Get container info by name
 */
export async function getContainerInfo(
  name: string
): Promise<ContainerInfo | null> {
  try {
    const output = await dockerCommand([
      'inspect',
      name,
      '--format',
      '{{json .State}}',
    ]);
    const state = JSON.parse(output);

    const portsOutput = await dockerCommand([
      'inspect',
      name,
      '--format',
      '{{json .NetworkSettings.Ports}}',
    ]);
    const ports = JSON.parse(portsOutput);

    const imageOutput = await dockerCommand([
      'inspect',
      name,
      '--format',
      '{{.Config.Image}}',
    ]);
    const image = imageOutput;

    const formattedPorts: Record<string, string> = {};
    for (const [port, bindings] of Object.entries(ports)) {
      if (bindings && Array.isArray(bindings) && bindings.length > 0) {
        formattedPorts[port] = bindings[0].HostPort;
      }
    }

    let health: ContainerHealth = 'unknown';
    if (state.Health) {
      health = state.Health.Status;
    } else if (state.Running) {
      health = 'healthy';
    } else {
      health = 'unhealthy';
    }

    return {
      id: state.ID,
      name,
      image,
      status: state.Status,
      health,
      ports: formattedPorts,
    };
  } catch {
    return null;
  }
}

/**
 * Check if a container is running
 */
export async function isContainerRunning(name: string): Promise<boolean> {
  const info = await getContainerInfo(name);
  return info?.status === 'running';
}

/**
 * Wait for a container to be healthy
 */
export async function waitForContainer(
  name: string,
  maxAttempts: number = 30,
  intervalMs: number = 1000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const info = await getContainerInfo(name);
    if (info && (info.health === 'healthy' || info.status === 'running')) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Start a test environment using docker compose
 */
export async function startTestEnvironment(
  composeFile: string,
  projectName: string = 'test-swarm'
): Promise<{
  composeFile: string;
  projectName: string;
  containers: string[];
}> {
  console.log(`Starting test environment with ${composeFile}...`);

  // Build images first
  await dockerCommand(['compose', '-f', composeFile, 'build', '--quiet']);

  // Start services
  await dockerCommand([
    'compose',
    '-f',
    composeFile,
    '-p',
    projectName,
    'up',
    '-d',
  ]);

  // Get list of containers
  const output = await dockerCommand([
    'compose',
    '-f',
    composeFile,
    '-p',
    projectName,
    'ps',
    '--format',
    'json',
  ]);

  const containers = output
    .split('\n')
    .filter(l => l.trim())
    .map(line => {
      try {
        return JSON.parse(line).Name;
      } catch {
        return null;
      }
    })
    .filter((n): n is string => n !== null);

  console.log(
    `Started ${containers.length} containers: ${containers.join(', ')}`
  );

  return {
    composeFile,
    projectName,
    containers,
  };
}

/**
 * Stop a test environment
 */
export async function stopTestEnvironment(
  composeFile: string,
  projectName: string = 'test-swarm'
): Promise<void> {
  console.log(`Stopping test environment...`);

  try {
    await dockerCommand([
      'compose',
      '-f',
      composeFile,
      '-p',
      projectName,
      'down',
      '--volumes',
      '--remove-orphans',
    ]);
    console.log('Test environment stopped');
  } catch (err) {
    console.error('Error stopping test environment:', err);
  }
}

/**
 * Execute command inside a container
 */
export async function execInContainer(
  containerName: string,
  command: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = ['exec', '-t', containerName, ...command];
  return new Promise(resolve => {
    const child = spawn('docker', args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', data => {
      stdout += data.toString();
    });
    child.stderr?.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? -1,
      });
    });

    child.on('error', err => {
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: -1,
      });
    });
  });
}

/**
 * Get container logs
 */
export async function getContainerLogs(
  containerName: string,
  tail: number = 100
): Promise<string> {
  return dockerCommand(['logs', '--tail', String(tail), containerName]);
}

/**
 * Copy file from container
 */
export async function copyFromContainer(
  containerName: string,
  containerPath: string,
  localPath: string
): Promise<void> {
  await dockerCommand(['cp', `${containerName}:${containerPath}`, localPath]);
}

/**
 * Copy file to container
 */
export async function copyToContainer(
  localPath: string,
  containerName: string,
  containerPath: string
): Promise<void> {
  await dockerCommand(['cp', localPath, `${containerName}:${containerPath}`]);
}

/**
 * Get service URLs from docker compose
 */
export async function getServiceUrls(
  composeFile: string,
  projectName: string = 'test-swarm'
): Promise<Record<string, string>> {
  const output = await dockerCommand([
    'compose',
    '-f',
    composeFile,
    '-p',
    projectName,
    'ps',
    '--format',
    'json',
  ]);

  const services: Record<string, string> = {};
  const lines = output.split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const info = JSON.parse(line);
      const portsOutput = await dockerCommand([
        'inspect',
        info.Name,
        '--format',
        '{{json .NetworkSettings.Ports}}',
      ]);
      const ports = JSON.parse(portsOutput);

      // Look for exposed ports
      for (const [containerPort, bindings] of Object.entries(ports)) {
        if (bindings && Array.isArray(bindings) && bindings.length > 0) {
          const hostPort = bindings[0].HostPort;
          const port = containerPort.split('/')[0];
          services[info.Service] = `http://localhost:${hostPort}`;
          break;
        }
      }
    } catch {
      // Skip invalid lines
    }
  }

  return services;
}
