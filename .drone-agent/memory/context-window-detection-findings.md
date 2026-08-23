---
key: context-window-detection-findings
tags:
  - investigation
  - llm
  - providers
  - context-window
created: 2026-08-23T19:44:53.000Z
updated: 2026-08-23T19:56:38.225Z
---

# Context-window detection investigation (2026-08-23, feat/provider-model-config @ c729dea)

User report: "detection isn't working for ollama/openrouter; only config overrides work."

## Verified empirically (repro harness against real ~/.drone-agent/config.json + live endpoints, dist built 15:13 post-decision-156)

- Broker chain WORKS at HEAD: openrouter/stealth/ox-alpha → 1000000 (source: metadata); ollama/deepseek-v4-flash:cloud → 1048576 (source: provider, live probe); unknown model → 32768 (default). All consumers route through the enriched getActiveProvider(). Wiring intact.
- Most likely explanation of user observation: sessions run before the 15:13 build executed pre-156 code (openai/openrouter/anthropic probes were dropped in Phase 2 → everything collapsed to 32768). Declared-metadata path is exactly what "config overrides work" describes.

## Real defects found

1. OPENROUTER DISCOVERY THROWS AWAY METADATA: openai-driver.ts discoverModels maps `{ id }` only, but OpenRouter /models carries context_length, top_provider.max_completion_tokens, architecture.modality. Undeclared openrouter models get zero detection → 32768 fallback. Fix: take-if-present extraction (contextWindow, maxOutputTokens, hasVision from modality includes 'image'); keeps vanilla OpenAI safe.
2. OLLAMA LOCAL MODELS REPORT GGUF TRAINING MAX, NOT RUNTIME WINDOW (user-corrected: does NOT apply to \*:cloud):
   - /api/show for LOCAL models includes `parameters` string (e.g. "num_ctx 8192") + modelfile + format:"gguf"; runtime window = request options.num_ctx (broker-sent) > Modelfile num_ctx > ollama default (~4096). Current code ignores all of this and reports context_length.
   - \*:CLOUD models: no local num_ctx concept, no modelfile, format:""; advertised context_length IS runtime truth — current detection already correct for cloud fleet.
   - Fix shape: parse show.parameters for num_ctx; cloud signal = format==='' or missing modelfile (+ ':cloud' suffix check); precedence mirrors buildOllamaOptions merge order. Optional warn when configured numCtx > GGUF max.
   - Open design question: probe receives only {model}; request-level numCtx lives in broker's effective-parameter merge → either additive wire-contract change (pass effective params into getContextWindowInfo) or driver re-reads providers entry.
3. autoImport IS VAPORWARE: documented in docs + wiki + typed in drone-core — zero references in src/. Implement stub persistence or strip until real.
4. PROVENANCE LINE INVISIBLE: decision 156's "Context window for X (source: S)" logger.info lands nowhere durable (logs/\*.json are session transcripts). Suggest /context command or status-bar surfacing of resolved window + source.
5. SECRETS (resolved): user pushes back on rotate-nag — legitimately. config.json is the file migration-persist rewrites + snapshots (.old backups) and swarm may sync; plaintext keys there MULTIPLY into artifacts. Env-exporting bash script keeps keys out of all of them → strictly better in this project's lifecycle, adopted as the approach. Residual nit only: verify whether ${VAR} interpolation reaches mcp.servers.\*.headers; if yes PAT can move too, if no, drop it.

## Good practices observed (per review persona)

- Regression test documents the >50%-on-fresh-session failure mode instead of deleting it (context-percent-regression.test.ts).
- Migration persist: backup-first + tmp+rename atomicity + raw-JSON re-parse so ${VAR} templates stay templates.
- Broker single interception point for enrichment rather than per-driver reimplementation (decision 156 rejected alternative).
