---
tags: [decision, beacon, websocket, network, security, bug-fix]
related:
  [
    decisions/174-beacon-sendtoagent-readystate-fix.md,
    modules/drone-beacon.md,
    concepts/test-infrastructure.md,
    decisions/137-integration-test-isolation.md,
  ]
---

# 175: Beacon `isLocalConnection` full RFC1918 172.16/12

**Status**: Implemented (2026-08-29, branch `feat/coordinator-sysmessage-insert`, commit `99582ae`)

## Context

`isLocalConnection` in `drone-beacon/src/ws-server.ts` gates every agent WebSocket connection (reject-and-close for anything not "local"). Its private-range implementation had two defects:

1. **Truncated RFC1918** — the private range 172.16.0.0/12 was implemented as a prefix check on `'172.16.'` only, silently excluding `172.17.0.0`–`172.31.255.255`. Docker/Podman default bridge networks allocate inside exactly that excluded half (the integration test-runner connected from `172.20.0.6`).
2. **No IPv4-mapped IPv6 handling** — dual-stack clients can surface as `::ffff:127.0.0.1` style addresses; the loopback entry was special-cased but the private-range prefix checks would miss mapped variants.

The truncated-range variant bit immediately in practice: the new swarm-fragments integration suite (ADR 173) opens a WS from the `test-runner` container, and the beacon logged the request but never logged `connected via WebSocket` — the connection was rejected as non-local. (ADR 174 had to be fixed first before this second blocker became visible.)

Note that a 2026-08-19-era change _narrowed_ the check toward "loopback + own interfaces only" per a remote-beacon security posture; at some point private-LAN acceptance was restored in code (the wiki's module page had drifted — it claimed the ranges were removed while the code kept them). This ADR does **not** widen policy beyond RFC1918 semantics; it fixes the _implementation_ of the range the code already intended to allow.

## Decision

- Strip the `::ffff:` IPv4-mapped IPv6 prefix before all checks.
- Match the full RFC1918 172.16/12 block with a bounded regex — `/^172\.(1[6-9]|2\d|3[01])\./` — covering `172.16.0.0`–`172.31.255.255` (Docker/Podman bridge networks live here).
- Keep loopback `127.0.0.1`/`::1`, `192.168/16`, `10/8`, and link-local `169.254/16` as before.

```ts
const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
return (
  normalized === '127.0.0.1' ||
  ip === '::1' ||
  normalized.startsWith('192.168.') ||
  normalized.startsWith('10.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
  normalized.startsWith('169.254.')
);
```

The source comment records the rationale (a comment on the range boundary, not a step comment), so the boundary isn't re-truncated by a future "simplification". Inline range regexes are exactly the kind of thing a later cleanup would "simplify" back to `'172.16.'` — the comment plus the new unit tests are the guard.

## Consequence

- WS connects from RFC1918 172.16/12 addresses — including Docker bridge networks — are accepted, which is required for the provisioned integration swarm and for any LAN-deployed beacon.
- The bounds are exact: `172.15.x.x` and `172.32.x.x` remain rejected (regression-tested), so the "private range" predicate can't silently widen into public space.
- Combined with ADR 174, the first provisioned-swarm WS delivery test went green (`pnpm test:integration`: 9 files / 68 tests passed).

## Key Points

- CIDR blocks must be implemented as bounds, not as a leading-octet prefix: `172.16/12` ≠ `'172.16.'`.
- Strip `::ffff:` before IPv4 range checks — dual-stack clients otherwise fall through every 127.0.0.1/prefix branch.
- The unit tests pin both the accepted full range (172.17.0.6, 172.20.0.6, 172.31.255.255) and the rejections (172.15.0.1, 172.32.0.1), so the boundary cannot silently drift again.

## Related

- [174-beacon-sendtoagent-readystate-fix](174-beacon-sendtoagent-readystate-fix.md) — the other WS-delivery blocker found in the same investigation
- [137-integration-test-isolation](137-integration-test-isolation.md) — the isolated Docker swarm whose bridge network exposed this
- test-infrastructure — integration provisioning and why test-runners connect from private ranges
- [drone-beacon](../../drone-beacon/) — ws-server and its local-only WS gate
