---
key: followup-swarm-console-unbacked-commands
tags:
  - followup
  - drone-gateway
  - drone-coordinator
  - swarm-console
  - endpoints
created: 2026-09-26T18:38:10.393Z
updated: 2026-09-26T18:38:10.393Z
---

# Follow-up: Swarm Console commands that need new coordinator endpoints

**Type:** Deferred follow-up. Deliberately EXCLUDED from the gateway Swarm Console implementation plan (`plan-swarm-console-control-surface`). Discovered 2026-09-26 while planning roadmap 4.4.

The v1 `swarm-console` control surface ships only commands that map onto coordinator REST endpoints that already exist. The five commands below are specified in `swarm-console-command-spec` (v1) but have **no backing endpoint**, so they are omitted from v1 grammar entirely (not stubbed — an unmatched `swarm.*` name returns the standard "Unknown command … Try swarm.help" reply).

| Command                                        | Blocker                                                                                                                            | What would need building                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `swarm.agent.focus <agentId> <text\|clear>`    | No focus endpoint. Focus exists only as a `focusChanged` transcript event.                                                         | A coordinator route that pushes a focus change to the live agent (reverse-channel `deliverUserMessage`-style command), plus agent-side handling. |
| `swarm.agent.interrupt <agentId> <message>`    | No cancel route. `POST /api/sessions/:id/message` `{steer}` only _injects_ a steering message; it never aborts the in-flight turn. | A cancel/abort verb on the session-message route wired to the agent's soft-cancel path.                                                          |
| `swarm.beacon.policy <beaconId> <key> <value>` | No policy endpoint. The only beacon-side constraint is `spawnRoots` (advertise-and-enforce) and config distribution.               | A per-beacon policy store + route (or a defined mapping onto the config-distribution mechanism).                                                 |
| `swarm.session.search <query>`                 | No session search. Only event-level `GET /api/events/search?q=`.                                                                   | A session-level search route (metadata/transcript), likely reusing FTS5. Note the spec itself calls this a "hook for future semantic search".    |
| `swarm.session.delete <sessionId>`             | No purge endpoint. Terminal state is `archived`; `DELETE /api/sync/sessions/:id` only marks the session `ended`.                   | A real purge route (hard delete of session + events), with the same care as wiki delete.                                                         |

## Notes

- Each of these is a **coordinator-side** feature, not a gateway feature. When implemented, the console can gain each command by adding one `ConsoleCommandDefinition` (the registry is designed for exactly this).
- Three of the five (`focus`, `interrupt`) are _live-agent_ operations and therefore interact with the reverse-channel command path and the agent's soft-cancel/steering machinery (see `/steer` semantics).
- `session.delete` overlaps with the `archived` terminal state introduced for session archival; a purge is genuinely destructive and should probably require an explicit flag.

## Related

- Roadmap 4.4 (drone-gateway Swarm Console control surface).
- Project memory `plan-swarm-console-control-surface` — the v1 plan.
- Project memory `swarm-console-command-spec` — the full command specification.
