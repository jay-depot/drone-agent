# Bootstrap Plugin

The `bootstrap` plugin provides setup workflows for new projects and users. It is not enabled by default — use `--plugin bootstrap` to enable it.

## Tools

- **`bootstrap__analyze`** — Detects project language, framework, build system, and suggests plugins

## Workflows

- **`bootstrap__project`** — Interactive project setup: detects project type, suggests plugins, writes config, enables them immediately via `enablePlugin()`
- **`bootstrap__user`** — Interactive user setup: probes for LLM providers (Ollama, OpenRouter), configures defaults, writes user config
- **`bootstrap__swarm-memory`** — Interactive swarm memory pipeline setup for the coordinator host: generates the session-end ingest hook and cron catch-up scripts, wires the `sessionEnd` config-file trigger (coordinator + optional beacon), merges config via the `drone-swarm-common` loader, offers ask-first server restarts, and smoke tests the pipeline on real ended conversations (confirm-first)

## Future Workflows (not yet implemented)

- `bootstrap__standalone-agent`
- `bootstrap__swarm`
