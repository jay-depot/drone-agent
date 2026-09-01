---
key: coordinator-probe-auth-gap
tags:
  - swarm
  - coordinator
  - bootstrap
  - auth
  - resolved
created: 2026-09-01T20:48:07.995Z
updated: 2026-09-01T22:16:42.546Z
---

RESOLVED (2026-09-01): All findings fixed across the two chained executions (ADR 182 on feat/web-port-auth-enforcement, ADR 183 on feat/workflow-system-improvements).

1. Primary-port unreachability → documented + routed around: bootstrap default URL is now the web port (http://localhost:8080); the primary 3456 port stays TLS+mTLS (by design, no loopback exemption).
2. Web-port /api token theater → /api added to PROTECTED_PREFIXES (938ead7); drone-swarm + generated scripts + probe got the token path (f4e5e7d, 54e6d19); UI login validates against /api/personas (49b401d).
3. Probe dishonesty (ENOENT hidden as "not reachable") → command -v presence check + exit/stderr surfaced in discovery prompt and hard-stop message.
4. Restart unit-name mismatch → FIXED in ADR 183: detectServiceLaunch asks ctx.agent to observe the real systemd unit / docker container name; the confirm-gated restart command uses what the agent verified (test pins `systemctl restart drone-coordinator-prod.service`).
5. --help HTTPS drift → help line corrected (HTTPS ON by default; COORDINATOR_HTTPS env not read — use --no-https).

Nothing remains open from this gap document. Coordinator host context (for future sessions): native systemd on ambiorix, web port 4300 (custom), drone-coordinator unit name may be custom — trust the agent-observed restart command.