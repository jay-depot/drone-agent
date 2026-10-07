---
tags: [decision, adr, testing, docker, providers]
related: [concepts/test-infrastructure.md, concepts/provider-model-selection.md, entities/DroneAgentConfig.md, decisions/155-provider-model-config.md, decisions/137-integration-test-isolation.md]
---

# 159: Test-Runner Baked Provider Config

**Status**: Implemented (2026-08-24)

## Context

The isolated integration swarm ([[decisions/137-integration-test-isolation]]) bakes a user-level agent config into the test-runner image at build time: `docker/test-runner.Dockerfile` writes `/root/.drone-agent/config.json` with a `RUN echo '…' >` line. After the provider/protocol/model refactor ([[decisions/155-provider-model-config]]) merged to `main`, CI's `pnpm test:integration` failed all 6 subagent dispatch tests with:

```
AssertionError: expected 'No active LLM provider. Ensure a providers config
entry exists and its protocol plugin is enabled.' to be undefined
```

The image still baked the **pre-refactor selector shape**:

```json
{"llm":{"provider":"echo"},"enabledPlugins":["llm","echo"]}
```

That shape worked only in the old world where the echo plugin self-registered as a provider via the now-deprecated legacy `registerProvider` path, matched against `llm.provider`. Under providers-as-data, the llm broker instantiates one provider per `config.providers` entry whose protocol has a registered driver and auto-activates from the canonical `llm.active: "<providerId>/<modelLocalId>"`. The legacy-section migrator synthesizes entries only for `ollama`/`openai`/`anthropic`/`openrouter` sections — a bare `llm.provider` value pointing at a *plugin* id synthesizes nothing. Zero provider instances existed, activation fell through, and every spawned subagent threw.

The drift survived for weeks because the JSON lives inside a Dockerfile heredoc-style string: nothing typechecks it, the fast suite stayed green (its tests construct capability mocks directly), and only the slow Docker-provisioned run exercised the real config path.

## Decision

1. **Re-bake the config in the current shape.** The image now writes:

```json
{
  "providers": {
    "echo": {
      "protocol": "echo",
      "baseUrl": "http://echo-llm:3458",
      "models": { "echo-model": {} }
    }
  },
  "llm": { "active": "echo/echo-model" },
  "enabledPlugins": ["llm", "echo"]
}
```

Choices within the fix:

- `baseUrl` is **pinned explicitly** to the compose service hostname instead of relying on the echo driver's `LLM_ECHO_URL` env fallback — explicit beats implicit inside an immutable image artifact.
- The declared model key `echo-model` matches the model id the conversation loop sends (the echo service accepts any model id, but declaring it makes the activation contract satisfiable and self-documenting).
- Plugins stay force-enabled via `enabledPlugins` because echo has `defaultEnabled: false`.

2. **Pin the baked config to the live schema with a fast unit test.** `drone-agent/test/test-runner-baked-config.test.ts` extracts the JSON literal from the Dockerfile `echo` line and asserts three things:

   - It parses against `parseConfigWithSchema` (the real config schema).
   - `validateProviders` reports zero errors and warnings.
   - `llm.active` parses via `parseModelSelection` into a `providerId` that exists in `providers`, with the selected `modelLocalId` present in that entry's `models` map — i.e. the llm broker's actual activation contract.
   - Additionally, the legacy `llm.provider` selector is asserted absent, so a stale pre-refactor shape cannot reappear silently.

## Alternatives Considered

- **Generate the config at runtime from env in the test fixtures** — hides the contract the image depends on and leaves the stale Dockerfile in place; rejected.
- **Assert on raw Dockerfile text** (string matching) — brittle and semantically empty; parsing the extracted JSON through the real validators catches both shape drift and semantic drift; chosen.
- **Rely on the integration run itself to catch drift** — this is exactly the feedback loop that let the breakage sit unnoticed for weeks; rejected.

## Consequences

- Config-schema refactors now fail the fast suite if they strand the baked image config, instead of surfacing as CI-only failures days later.
- The regression test reads a repo file (`docker/test-runner.Dockerfile`) from a unit test — acceptable coupling, since the file *is* the subject under test.
- Process rule reinforced: a cross-cutting config-shape refactor must sweep every consumer, including **non-typechecked** ones — Dockerfiles baking JSON, compose environment blocks, scripts that emit config files. Hidden consumers have no compiler.

## Validation

- `pnpm test:integration`: 8 files passed, 65 passed / 4 skipped (the expected echo-instant-response skips), 0 failures — all 6 previously failing subagent dispatch tests green.
- Fast suite green including the 3 new assertions; verified the new test fails against the old baked config (which still *parsed* cleanly — proving the activation-contract assertions, not the schema check, are the load-bearing ones).
- Typecheck, lint, build clean. Authored as `feda09f` on `feat/provider-model-config`; landed on `main` via the PR #70 squash merge `8a56922`.

## Related

- [[decisions/155-provider-model-config]] — the refactor that changed the config shape
- [[decisions/137-integration-test-isolation]] — the Docker swarm this image belongs to (and round 1 of this plan's fixes)
- [[concepts/test-infrastructure]] — integration testing infrastructure
- [[concepts/provider-model-selection]] — the selection identity `llm.active` must satisfy
