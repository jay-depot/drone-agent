// ── MCP Server Description Generation + Caching ─────────────────────
//
// When connecting to a new MCP server, this module calls a "clean" LLM
// (raw provider.chat(), no tools, no session) with the tool list and asks
// it to summarize what the server does in ≤3 sentences. The summary is
// included in the __list_tools description.
//
// Cache location: ~/.drone-agent/cache/mcp/server-descriptions.json
//   - Single JSON file keyed by server ID: { serverId: { description, generatedAt } }
//   - Cache is never invalidated automatically (deferred to a roadmap task).
//   - If an entry exists, it is reused without calling the LLM.
//
// -----------------------------------------------------------------------

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DroneLlmCapability, DroneLogger } from 'drone-core';

const CACHE_DIR = path.join(os.homedir(), '.drone-agent', 'cache', 'mcp');
const CACHE_FILE = path.join(CACHE_DIR, 'server-descriptions.json');

type DescriptionCache = Record<
  string,
  { description: string; generatedAt: string }
>;

async function ensureCacheDir(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
}

async function readCache(): Promise<DescriptionCache> {
  try {
    const raw = await readFile(CACHE_FILE, 'utf-8');
    return JSON.parse(raw) as DescriptionCache;
  } catch {
    return {};
  }
}

async function writeCache(cache: DescriptionCache): Promise<void> {
  await ensureCacheDir();
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

async function readCachedDescription(
  serverId: string
): Promise<string | undefined> {
  const cache = await readCache();
  return cache[serverId]?.description;
}

async function writeCachedDescription(
  serverId: string,
  description: string
): Promise<void> {
  const cache = await readCache();
  cache[serverId] = {
    description,
    generatedAt: new Date().toISOString(),
  };
  await writeCache(cache);
}

/**
 * Get or create a server description for the given MCP server.
 *
 * 1. Try the local cache (~/.drone-agent/cache/mcp/server-descriptions.json).
 * 2. If not cached and an LLM capability is available, generate a summary
 *    via the LLM and cache it.
 * 3. If no LLM is available, return undefined (caller falls back to generic).
 */
export async function getOrCreateServerDescription(
  serverId: string,
  tools: Array<{ name: string; description?: string }>,
  llmCapability: DroneLlmCapability | undefined,
  logger: DroneLogger
): Promise<string | undefined> {
  // 1. Try cache
  const cached = await readCachedDescription(serverId);
  if (cached) return cached;

  // 2. Generate via LLM
  if (!llmCapability) return undefined;

  try {
    const provider = llmCapability.getActiveProvider();
    const model = llmCapability.getModel();
    const response = await provider.chat({
      model,
      messages: [
        {
          role: 'system',
          content:
            "You are a tool catalog summarizer. Given a list of MCP tools with names and descriptions, describe what the server does in no more than 3 sentences. Focus on the server's purpose and key capabilities.",
        },
        {
          role: 'user',
          content: JSON.stringify(
            tools.map(t => ({
              name: t.name,
              description: t.description ?? '(no description)',
            }))
          ),
        },
      ],
    });
    const description = response.message ?? '';
    if (description) {
      await writeCachedDescription(serverId, description);
    }
    return description || undefined;
  } catch (error) {
    logger.warn(
      `mcp server description generation failed for ${serverId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}
