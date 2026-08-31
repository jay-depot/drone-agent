---
key: swarm-memory-bootstrap-gap
tags:
  - swarm
  - bootstrap
  - memory-pipeline
  - docs-drift
  - gap
created: 2026-08-31T21:14:33.642Z
updated: 2026-08-31T21:14:33.642Z
---

FINDING (2026-08-31): The `bootstrap__swarm-memory` workflow does NOT exist in code — docs reference a phantom.

- Total registered workflows in the whole repo: bootstrap__project + bootstrap__user (drone-agent/src/plugins/bootstrap/index.ts:209,592), skills__create (skills/index.ts:264), persona__create (persona/index.ts:509), macros 'reload' (macros/index.ts:180). Nothing else.
- grep `bootstrap__(swarm|swarm-memory|standalone)` hits ONLY docs: docs/agents/memory-pipeline.md:9-13 claims the workflow + coordinator-wiki-librarian persona "already implement a complete pipeline (shell script + systemd timer + spawned librarian)" and recommends it — false. docs/agents/bootstrap-plugin.md:15-18 correctly lists bootstrap__swarm (+standalone-agent) under "Future Workflows (not yet implemented)". docs contradict each other.
- ADR 151 ([[decisions/151-memory-pipeline-infra]]) Context line repeats the phantom: "bootstrap__swarm-memory generates a curl+jq shell script + systemd timer". Git log of drone-agent/src/plugins/bootstrap shows NO commit ever added it (only e2cc270 2026-06-23 added project/user workflows).
- The OTHER half of the "opinionated default" half-exists but is broken: drone-coordinator/src/index.ts seedDefaults() (line 652) seeds the coordinator-wiki-librarian persona with instructions referencing session_list / session_get_log / session_mark_processed tools (lines 693,711-715) — those strings appear NOWHERE except inside persona prompt text; no such agent tools are registered anywhere (session pipeline access is /swarm-session slash command + drone-swarm CLI, not LLM tools). So the librarian's own documented workflow steps 2/3/6 are unexecutable as shipped.
- No sessionEnd config examples in config-library/. No systemd script artifacts anywhere in repo.
- Modern design implication if resurrected: per ADR 151, sessionEnd triggers (config-file, command|spawn union) replaced the systemd-timer approach; per ADR 179, a full bootstrap should ALSO set up the READ side (swarm.memory config: enabled/topK/minScore/anchors/window) — neither exists. ADR 179 residual note already deferred "wiki-librarian persona guidance update".
- Candidate follow-ups: (1) fix docs to say the workflow is not implemented (per AGENTS.md aspirational/false-claim rule); (2) fix librarian persona tool names (session_* → real swarm__* tools or CLI guidance); (3) decide whether to build bootstrap__swarm-memory (write coordinator config w/ sessionEnd spawn trigger + pipeline script via drone-swarm + swarm.memory section) or drop the "opinionated default" framing from memory-pipeline.md.
