import type { DroneConfigLayer } from 'drone-core';

/**
 * Provider secrets & scope policy (locked decision 8/9):
 *
 * - `providers` entries are BANNED from project-scope config files.
 *   Providers are machine/user-level infrastructure; projects may pin
 *   `llm.active`/`llm.reasoningLevel` but never define providers.
 *   Legacy sections (ollama/openai/anthropic/openrouter) are NOT banned —
 *   they are grandfathered during the migration window.
 * - A plaintext (non-`${VAR}`) apiKey contributed by a PROJECT-scope file
 *   produces a loud warning. User-scope plaintext keys are fine; swarm
 *   underlays are sanctioned distribution channels.
 *
 * `${VAR}` interpolation itself happens at layer parse time
 * (config-schema.transformEnvVars); an unset variable already fails with a
 * descriptive error there.
 */

export type ScopePolicyResult = {
  /** Startup-fatal violations. */
  errors: string[];
  /** Loud-but-non-fatal security notices. */
  warnings: string[];
};

export function enforceProviderScopePolicy(
  layers: DroneConfigLayer[]
): ScopePolicyResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const layer of layers) {
    if (layer.scope !== 'project' || !layer.config) continue;

    const providers = layer.config.providers;
    if (providers && Object.keys(providers).length > 0) {
      errors.push(
        `Project-scope config ${
          layer.path ? `(${layer.path}) ` : ''
        }defines "providers" entries [${Object.keys(providers).join(', ')}]. Providers are banned at project scope — define them in user config (~/.drone-agent/config.json) or distribute them via swarm underlays. Projects may pin llm.active instead.`
      );
    }

    const secretSections = ['openai', 'anthropic', 'openrouter'] as const;
    for (const section of secretSections) {
      const apiKey = layer.config[section]?.apiKey;
      if (!apiKey) continue;
      if (apiKey.includes('${')) continue;
      warnings.push(
        `Project-scope config ${
          layer.path ? `(${layer.path}) ` : ''
        }contains a plaintext apiKey for "${section}". Prefer "\${ENV_VAR}" interpolation or move the key to user scope.`
      );
    }
  }

  return { errors, warnings };
}
