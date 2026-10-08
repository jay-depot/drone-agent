---
key: reference-sandboxing-options
tags:
  - reference
  - security
  - sandbox
  - architecture
created: 2026-10-08T20:32:44.903Z
updated: 2026-10-08T20:32:44.903Z
---

# Sandboxing the agent — current state and options

**Finding (2026-10-08): the codebase has NO sandbox.** A workspace search for "sandbox" returns zero results. There is no seccomp, bubblewrap, firejail, namespace, cgroup, or container confinement in any package.

## Why there is no in-process jail

- `drone-agent/src/plugins/exec.ts:48-52` — `spawn(command, { shell: true })`. Any shell command. `cwd` is caller-supplied and defaults to the process cwd. No path check.
- `drone-agent/src/plugins/file.ts:158,221,274,380,551` — every file tool does `path.resolve(input.path.trim())` with no root check. Absolute paths work anywhere the user can reach.
- `drone-agent/src/working-dir.ts:21` — `--working-dir` only runs `process.chdir()`. It does not confine.
- `drone-agent/src/plugins/terminal/plugin.ts` — opt-in PTY sessions (`node-pty`), i.e. more power, not less.

## Restrictions that exist (NOT sandboxes)

- Beacon `spawnRoots` whitelist — `drone-beacon/src/spawn-roots.ts:119` (`isSpawnRootAllowed`, exact match against expanded roots), enforced at `drone-beacon/src/routes/spawn-handlers.ts:39`. Limits the spawned agent's cwd only.
- Persona `allowedTools` + `defaultHidden` — `drone-agent/src/plugins/persona/index.ts:113-137`. Capability policy. The process can still do anything.
- MCP `allowedTools` allowlist — `docs/agents/mcp-plugin.md`.
- External-plugin trust — `docs/agents/external-plugin-loading.md` (`trusted-plugins.json`). Gates which plugin code loads.
- Resource bounds — `session.maxToolIterations` (default 50, `drone-core/src/config-types.ts:631`), persona `toolCallLimit` (`drone-core/src/persona-types.ts:70`).
- Swarm trust — TOFU TLS fingerprint + mTLS + beacon approval. Network trust, not process confinement.
- Gateway `allowedSenders` and injection opt-in — authorization, not isolation.

## Options (weakest to strongest)

1. **Capability policy only** — persona with `tools: [!exec__*, !file__*, !terminal__*, !mcp__*]`. Cheap. Weak: a prompt-injection into any remaining tool that can exec defeats it.
2. **Working-dir jail** — beacon `spawnRoots`. Weak (cwd only).
3. **OS confinement of the process** — wrap the launch: bubblewrap / firejail / `systemd-run` with `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths`, `NoNewPrivileges`, `PrivateTmp`; or Landlock/seccomp. Works because all tool I/O goes through the process.
4. **Container** — the image already exists (`docker/drone-agent.Dockerfile`) but is unhardened: runs as **root** (no `USER`), no `cap_drop`, no `read_only`, no `security_opt`. Integration compose shows a private network with no host port mappings (`docker/docker-compose.integration-test.yaml`). Harden these and mount the workspace only.
5. **Containerize spawned agents** — change the launch point. Beacon spawns the binary directly (`drone-swarm-common/src/spawner.ts`); the gateway `SpawnBackend` is a documented extension point ("can be extended for future backends (e.g., Kubernetes, Docker)", ADR 235/001, `drone-gateway/src/local-spawn-backend.ts`).
6. **Plugin sandbox** — aspirational only. The strategic-vision page names `isolated-vm` or a child-process isolate; it states vm2 is deprecated (CVE-2023-37466). No code exists.

Design note: the architecture is deliberately single-user (ADR 004), so no multi-user isolation was ever designed.
