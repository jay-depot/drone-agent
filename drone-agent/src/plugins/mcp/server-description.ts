// ── MCP Server Description Generation + Caching ─────────────────────
//
// When connecting to a new MCP server, this module calls a "clean" LLM
// (raw provider.chat(), no tools, no session) with the tool list and asks
// it to summarize what the server does in one short sentence. The summary
// is surfaced to the LLM by the `# MCP Servers` header prompt fragment
// (see ./prompt-fragments.ts).
//
// Cache location: ~/.drone-agent/cache/mcp/server-descriptions.json
//   - Single JSON file keyed by server ID:
//     { serverId: { description, generatedAt, promptVersion } }
//   - An entry whose promptVersion does not match PROMPT_VERSION is treated
//     as a miss and regenerated, so tuning the prompt re-summarizes every
//     server on its next connect.
//
// -----------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DroneLlmCapability, DroneLogger } from 'drone-core';
import { withPathLock } from '../../shared/file-lock.js';

const PROMPT_VERSION = 2;

const SYSTEM_PROMPT =
  'You are a tool catalog summarizer. Given a list of MCP tools with names and ' +
  'descriptions, write ONE short sentence (20 words or fewer) describing what ' +
  "the server does. Lead with the server's purpose. No preamble, no markdown, " +
  'no lists.';

type DescriptionCacheEntry = {
  description: string;
  generatedAt: string;
  promptVersion: number;
};

type DescriptionCache = Record<string, DescriptionCacheEntry>;

function cacheDir(): string {
  return path.join(os.homedir(), '.drone-agent', 'cache', 'mcp');
}

function cacheFile(): string {
  return path.join(cacheDir(), 'server-descriptions.json');
}

async function readCache(): Promise<DescriptionCache> {
  try {
    const raw = await readFile(cacheFile(), 'utf-8');
    return JSON.parse(raw) as DescriptionCache;
  } catch {
    return {};
  }
}

async function readCachedDescription(
  serverId: string
): Promise<string | undefined> {
  const entry = (await readCache())[serverId];
  if (!entry) return undefined;
  if (entry.promptVersion !== PROMPT_VERSION) return undefined;
  return entry.description;
}

/**
 * Read every current-version cached description at once, so a caller can
 * seed its in-memory map with a single disk read instead of one per render.
 */
export async function readCachedDescriptions(): Promise<
  Record<string, string>
> {
  const cache = await readCache();
  const out: Record<string, string> = {};
  for (const [serverId, entry] of Object.entries(cache)) {
    if (entry.promptVersion === PROMPT_VERSION) {
      out[serverId] = entry.description;
    }
  }
  return out;
}

async function writeCachedDescription(
  serverId: string,
  description: string
): Promise<void> {
  await withPathLock(cacheFile(), async () => {
    const cache = await readCache();
    cache[serverId] = {
      description,
      generatedAt: new Date().toISOString(),
      promptVersion: PROMPT_VERSION,
    };
    await mkdir(cacheDir(), { recursive: true });
    const file = cacheFile();
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf-8');
    await rename(tmp, file);
  });
}

/**
 * Get or create a server description for the given MCP server.
 *
 * 1. Try the local cache (~/.drone-agent/cache/mcp/server-descriptions.json).
 * 2. If not cached and an LLM capability is available, generate a summary
 *    via the LLM and cache it.
 * 3. If no LLM is available, return undefined (caller renders no prose).
 */
export async function getOrCreateServerDescription(
  serverId: string,
  tools: Array<{ name: string; description?: string }>,
  llmCapability: DroneLlmCapability | undefined,
  logger: DroneLogger
): Promise<string | undefined> {
  const cached = await readCachedDescription(serverId);
  if (cached) return cached;

  if (!llmCapability) return undefined;

  try {
    const role = llmCapability.resolveModelForRole('describer');
    const response = await role.provider.chat({
      model: role.model,
      reasoningLevel: role.reasoningLevel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
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
