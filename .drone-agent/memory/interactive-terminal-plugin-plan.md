---
key: interactive-terminal-plugin-plan
tags:
  - plan
  - terminal-plugin
  - feature
  - completed
created: 2026-07-02T02:42:37.649Z
updated: 2026-07-02T02:54:43.226Z
---

# Interactive Terminal Plugin Plan — COMPLETED 2026-07-01

## Summary
Implemented the `terminal` plugin as planned. All 8 steps completed.

## Files Created
- `drone-agent/src/plugins/terminal/constants.ts` — Buffer limits, default dimensions
- `drone-agent/src/plugins/terminal/key-codec.ts` — Hybrid named sequence encoder (30+ named sequences, Alt-<char>, << escape)
- `drone-agent/src/plugins/terminal/session-manager.ts` — TerminalSessionManager class with create/write/read/screenshot/resize/list/kill/killAll
- `drone-agent/src/plugins/terminal/plugin.ts` — DronePlugin with 7 tools + prompt fragment + lifecycle hooks
- `drone-agent/src/plugins/terminal/index.ts` — Barrel export
- `drone-agent/test/terminal.test.ts` — 48 tests (key encoding, session manager, plugin registration)

## Files Modified
- `drone-core/src/config-types.ts` — Added DroneTerminalConfig type, defaults, merge stanza
- `drone-core/src/config-schema.ts` — Added terminal schema section
- `drone-core/src/index.ts` — Re-exported DroneTerminalConfig
- `drone-agent/src/plugins/index.ts` — Registered terminalPlugin in staticBuiltInPlugins
- `drone-agent/package.json` — Added node-pty dependency
- `pnpm-workspace.yaml` — Approved node-pty native build
- `drone-agent/test/log-plugin.test.ts` — Added terminal config to mock
- `drone-agent/test/prompt-file.test.ts` — Added terminal config to mock

## Observations
- Had to add missing Ctrl-I, Ctrl-J, Ctrl-M to the named sequences (test looped A-Z)
- The `<<raw>>` test expectation was wrong — `<<raw>` is correct (second `>` is raw)
- Pre-existing lint errors in drone-swarm-common/src/tls.ts (not our changes)
- 48 tests, 902 total tests pass, build/typecheck/lint all clean