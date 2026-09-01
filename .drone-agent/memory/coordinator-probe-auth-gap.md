---
key: coordinator-probe-auth-gap
tags:
  - swarm
  - coordinator
  - bootstrap
  - auth
  - bug
  - mtls
  - web-auth
  - diagnosis
created: 2026-09-01T20:48:07.995Z
updated: 2026-09-01T20:56:16.217Z
---

FINDINGS (2026-09-01, while debugging "bootstrap__swarm-memory can't reach coordinator"):

1. PRIMARY PORT (3456) IS UNREACHABLE TO drone-swarm BY DEFAULT — architectural. Coordinator primary port defaults to HTTPS with self-signed cert (drone-coordinator/src/index.ts:93 useHttps:true) AND mounts mTLS client-cert pinning on all /api routes (src/mtls.ts + buildApp enableMtls:true) with NO loopback exemption (only /health and POST /api/beacons exempt). drone-swarm's SwarmClient is bare fetch: no CA trust, no client cert, no auth header (drone-swarm/src/client.ts:43-56). http://…:3456 → TLS reset; https://…:3456 → self-signed reject; trusted CA → 401 "client certificate required". No URL form works today.

2. WEB PORT /api/* AUTH GAP (confirmed live): PROTECTED_PREFIXES (web-auth.ts:9-25) has no '/api' entry; routes moved under /api (routes/index.ts prefix:'/api') → token never enforced for /api/* on the web port. User's live server: curl http://localhost:4300/api/beacons returns full beacon JSON with no token. Login is token-theater for API calls. Fix (add '/api') must ship together with drone-swarm Bearer support or it re-breaks the ingest pipeline for non-loopback use.

3. AMBIORIX EVIDENCE — prime suspect is now the SPAWN, not the URL: user's coordinator webPort is 4300 (custom). curl to /api/beacons works in the same shell; the agent's own swarm stack reaches beacon 127.0.0.1:3457 and loads 22 coordinator personas through it (network + coordinator up). Yet the workflow reports NOT reachable for both 3456 and 4300. probeCoordinator shells out to `drone-swarm` via createExecFileRunner (spawn, no shell); ANY spawn failure (ENOENT — not installed/not on PATH; bad shim; instant crash) resolves to code -1 → "not reachable", and probeCoordinator DISCARDS stderr (swarm-memory.ts probeCoordinator only checks result.code). The real error never surfaces. 10-second diagnostic: `which drone-swarm; drone-swarm --coordinator http://localhost:4300 session list --limit 1; echo exit=$?`. Note: a pre-/api-prefix (old dialect) drone-swarm would get 200 + index.html from the SPA fallback and report reachable with 0 sessions — so reported failure implies spawn-level or connection-level refusal, not dialect drift.

4. drone-swarm normalizeBaseUrl() (src/address.ts) force-prepends http:// to schemeless URLs; https:// must be explicit.

5. Doc drift: coordinator --help says HTTPS default follows COORDINATOR_HTTPS env; code hardcodes useHttps:true.

6. Restart quirk: detectLaunchMode probes `systemctl status drone-coordinator` but restartServer runs `systemctl restart coordinator` / `docker restart coordinator` (server arg 'coordinator').

7. Fix set for the workflow (plan-worthy): (a) surface spawn errors — check binary presence (which/command -v) and include result.stderr in the not-reachable message; (b) probe GET /health (mTLS-exempt on both ports) instead of `drone-swarm session list`, or accept a drone-swarm path option; (c) add '/api' to PROTECTED_PREFIXES + drone-swarm --token/env DRONE_SWARM_TOKEN Bearer support, wired into hook/catchup scripts + bootstrap probe; (d) fix restart unit-name mismatch; (e) fix --help HTTPS-default doc line.

WORKAROUNDS: native coordinator → use web-port URL (http://127.0.0.1:4300 here) for the probe/config; hook+catchup inherit it and run on the same host via cron. Installing/linking drone-swarm is mandatory regardless — hook + catch-up scripts call it by name.
