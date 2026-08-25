---
key: audit-input-validation-sweep
tags: []
created: 2026-08-25T18:34:41.935Z
updated: 2026-08-25T18:34:41.935Z
---

# Audit: trim-before-validate / unenforced-required-input sweep (all plugins)

Two read-only subagent audits covered every .ts file under drone-agent/src/plugins/ (both flat files and directories) plus runtime/builtin-commands.ts (~94 files). Dispatch path confirmed schema-less: executeTool -> tool.execute directly.

## CRASH (real, reachable today)

1. memory/index.ts:166 — tool `memory.manage`: `const key = (input.key as string).trim();` runs BEFORE its own `if (!key) throw 'memory.manage requires a non-empty key.'`. Omitted/mistyped key => raw TypeError. Fix: `const key = typeof input.key === 'string' ? input.key.trim() : '';`

## LATENT (schema says required, nothing enforces; misleading downstream errors)

2. swarm/tools-wiki.ts (:31,:95,:141,:208) — wiki_read/wiki_write/wiki_search/wiki_delete: pageId/query/title/content cast-unchecked. encodeURIComponent(undefined) => fetches /wiki/undefined => misleading "Wiki page not found: undefined". Write PUTs doc with absent title/content keys.
3. swarm/tools-coordinator.ts (:99,:207,:242-246,:280, targetBeaconId ~:175) — beaconId/spawnId/targetBeaconId unenforced => requests to /spawn/undefined/undefined, confusing coordinator 404 relayed. (list_agents/status truthiness-guarded = SAFE.)
4. swarm/tools-message.ts:55 — send branch: body never type-checked, not in required[]; missing body silently queued with zero feedback. (toAgentId/toChannel guarded.)
5. subagent/plugin.ts:63-67 — `return` tool: required['result'] unenforced; omitted result is dropped by parent's typeof filter => opaque "Subagent did not return a result" masks real cause.
6. notepad.ts:57 — action required-but-unenforced; unknown/omitted action falls through BOTH set and append branches and returns {"success":true} doing NOTHING. False-success gap.
7. memory/index.ts:165,239 — `input.action as string` unenforced; degrades to "Unknown action: undefined" instead of listing valid actions.

## LATENT (defense-in-depth only, contract-backed — lowest priority)

8. bootstrap/index.ts elicitation answers (project :138-141; user :311,:329,:361,:396,:420,:459,:483,:523,:553) — `(answers.x as string).split()/trim()` etc. Verified both elicit hosts (src/elicitation.ts readline + src/tui/elicitation.ts TUI) populate EVERY requested question id unconditionally, so crash requires breaking the elicitation contract. Friendly errors exist but ordered AFTER the hazard (e.g. apiKey emptiness checked post-cast).

## Cleared (previously flagged, actually SAFE)

- bootstrap/index.ts:80-84 `(input.path as string).trim()` — leading `typeof input.path === 'string' &&` short-circuits; casts unreachable for non-strings. Same shape in bootstrap.analyze :51-54.

## Verified clean patterns worth reusing

- persona/skills select/recall: `typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''` + empty-check — exactly the correct pattern.
- git/tools/\* uniformly via requireString/resolveCwd/asPaths helpers (run-git.ts:59-78).
- lsp/tools/\* funnel into server.resolveAtPosition/parsePositionInput which typeof-validates first.
- exec.ts parseExecInput validates everything pre-spawn.
- todo/index.ts validation-first parseManageInput().
- builtin-commands.ts /tool JSON path fully try/catch'd.

Recommended follow-up fix plan scope: items 1-7 (crash + misleading-error latents); item 8 optional/deferred.
