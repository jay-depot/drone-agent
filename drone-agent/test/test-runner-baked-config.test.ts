import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseConfigWithSchema,
  parseModelSelection,
  validateProviders,
  type DroneLlmConfig,
  type DroneProviderConfig,
} from 'drone-core';

/**
 * The integration test-runner image bakes a user-level config.json at
 * build time (docker/test-runner.Dockerfile) so spawned subagents activate
 * the echo protocol driver against the compose echo-llm service. These
 * tests pin that baked JSON to the current config schema and the llm
 * broker's activation contract, so a provider-config refactor cannot
 * silently strand the image on a stale shape again — the legacy
 * `llm.provider` shape produced "No active LLM provider" failures across
 * the whole subagent dispatch suite when the providers.* shape landed.
 */

function bakedConfigDockerfile(): Promise<string> {
  return readFile(
    fileURLToPath(
      new URL('../../docker/test-runner.Dockerfile', import.meta.url)
    ),
    'utf8'
  );
}

async function extractBakedConfigJson(): Promise<Record<string, unknown>> {
  const dockerfile = await bakedConfigDockerfile();
  const match = dockerfile.match(
    /echo '([^']+)' > \/root\/\.drone-agent\/config\.json/
  );
  if (!match) {
    throw new Error(
      'Could not find the baked /root/.drone-agent/config.json echo line in docker/test-runner.Dockerfile'
    );
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe('test-runner baked config', () => {
  it('parses against the current drone-agent config schema', async () => {
    const parsed = parseConfigWithSchema(
      await extractBakedConfigJson(),
      'test-runner-baked-config'
    );
    expect(parsed.providers?.['echo']?.protocol).toBe('echo');
  });

  it('declares providers that pass semantic validation', async () => {
    const raw = await extractBakedConfigJson();
    const result = validateProviders(
      (raw.providers ?? {}) as Record<string, DroneProviderConfig>
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('activates via a canonical full-form selection backed by a declared provider entry', async () => {
    const raw = await extractBakedConfigJson();
    const llm = raw.llm as DroneLlmConfig | undefined;
    expect(llm?.active).toBeDefined();

    const selection = parseModelSelection(llm!.active!);
    expect(selection).toBeDefined();

    const providers = (raw.providers ?? {}) as Record<
      string,
      DroneProviderConfig
    >;
    const entry = providers[selection!.providerId];
    expect(entry).toBeDefined();
    expect(Object.keys(entry.models ?? {})).toContain(selection!.modelLocalId);

    // The legacy `llm.provider` selector is what stranded the image during
    // the provider/protocol/model refactor; its reappearance means a stale
    // pre-refactor shape snuck back in.
    expect(llm!.provider).toBeUndefined();
  });
});
