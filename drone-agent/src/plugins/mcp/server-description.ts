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

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DroneLlmCapability, DroneLogger } from 'drone-core';

const CACHE_DIR = path.join(os.homedir(), '.drone-agent', 'cache', 'mcp');
const CACHE_FILE = path.join(CACHE_DIR, 'server-descriptions.json');

type DescriptionCache = Record<
  string,
  { description: string; generatedAt: string }
>;

function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readCache(): DescriptionCache {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(raw) as DescriptionCache;
  } catch {
    return {};
  }
}

function writeCache(cache: DescriptionCache): void {
  ensureCacheDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

function readCachedDescription(serverId: string): string | undefined {
  const cache = readCache();
  return cache[serverId]?.description;
}

function writeCachedDescription(serverId: string, description: string): void {
  const cache = readCache();
  cache[serverId] = {
    description,
    generatedAt: new Date().toISOString(),
  };
  writeCache(cache);
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
  const cached = readCachedDescription(serverId);
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
      writeCachedDescription(serverId, description);
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
