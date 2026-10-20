# 257. Swarm extension transport over the coordinator's unencrypted web port

- Status: Accepted
- Date: 2026-10-20

## Context

A swarm extension ([ADR 254](254-swarm-extensions.md)) connects to the
coordinator by sending `POST /api/beacons` and then opening a WebSocket to
`/ws/beacon`. The coordinator runs two HTTP servers:

| Port            | Default                | Security                      | Has `/ws/beacon`? |
| --------------- | ---------------------- | ----------------------------- | ----------------- |
| Primary (swarm) | 3456                   | TLS + mTLS client certificate | Yes               |
| Web             | 8080 (bound 127.0.0.1) | none, or bearer token         | **No**            |

`registerBeaconWebSocket(app)` was called only inside the `if (opts.enableMtls)`
branch (`drone-coordinator/src/index.ts`), so `/ws/beacon` did not exist on the
web port. A node pointed at `http://127.0.0.1:8080` registered, then got a 404
on the socket.

A node pointed at the primary port (3456) was worse off. The primary port binds
a non-loopback interface, so a same-host caller is often seen with a
non-loopback source address and `isLoopbackIp()` returns false. The node then
registers as `pending` (`beacon-trust.ts`). Approval needs two steps: a signed
`POST /api/beacons/trust/:id/confirm-fingerprint`, then operator approval. The
SDK never sends step 1, so the node can never be approved. This is a hard
deadlock.

The unencrypted web port already had the correct trust posture for local
extensions: registration from loopback is auto-approved, and the port binds
127.0.0.1. It only lacked a reverse channel. This decision adds the reverse
channel and the two route behaviours it needs to the web port.

## Decision

**D1 — Target surface.** Use the existing web port (8080). No new port, no third
server. _Rejected:_ a dedicated extension port; a third `buildApp` instance.

**D2 — Where extensions run.** Coordinator host only. The web port stays bound
to 127.0.0.1. Loopback registration is auto-approved. _Rejected:_ remote
extensions (deferred behind a future pre-approval token flow).

**D3 — Node identity on the certificate-less socket.** None. The node claims its
id. Local callers are trusted. No new auth scheme. _Rejected:_ Ed25519
challenge-response over the socket.

**D4 — mTLS path.** Unchanged. Only the web port is fixed. The 3456 deadlock
stays reachable, and the docs say so. _Rejected:_ teaching the SDK the
`confirm-fingerprint` handshake in this pass.

**D5 — Bundle upload on the web port.** Accept a claimed node id from a local
caller. No signature. _Rejected:_ requiring a signature for bundle uploads.

**D6 — Node identification at the WebSocket upgrade.** Query parameter
`?beaconId=<id>`, with the `x-node-id` header accepted first. _Rejected:_ a
`hello` frame after the upgrade (needs a frame-dispatch state machine before
admission).

**D7 — Consumers to retarget.** The `mcp-swarm` default URL and the docs. No
`drone-gateway` code change (the gateway already points at the primary port and
keeps the mTLS path).

**D8 — SDK hygiene.** Fix the false "connected" log and the reconnect backoff: a
node that never reaches admission now escalates 1s to 30s and logs one warning,
instead of logging success on `open` and reconnect-storming at 1s.

**D9 — Registration address fields.** Beacons send their listen address and
listen port. Extensions send their address only (always 127.0.0.1) and no port.
`port` becomes optional and nullable in the request, the `beacons` table, and
the `beacon_trust` table.

The shared resolver `resolveRequestNodeId` picks the node id: a client
certificate wins when one is presented and fails closed when it does not
resolve; without a certificate the caller's own claim is used, from the
`x-node-id` header and then from a `beaconId` query parameter. The claim is
trusted only because the web port is bound to loopback.

## Consequences

Accepted risks (documented, not mitigated):

1. Any local process can register as an extension and inject prompt fragments
   into every agent session.
2. Any local process can open a certificate-less socket that claims another
   node's id. This displaces that node's socket, because `connections` holds one
   socket per `beaconId`. Denial of service only.
3. Any local process can upload a bundle under another node's id. Bundles are
   served same-origin with full page trust.
4. An extension pointed at `https://...:3456` still stays pending forever.

The `port` column migration is idempotent: SQLite cannot drop a NOT NULL
constraint in place, so `makeBeaconPortOptional` rebuilds `beacons` and
`beacon_trust` with explicit DDL, preserving every other constraint, default,
and primary key. `host` and `port` follow the ADR 200 merge-on-omit rule: an
omitted field preserves the stored value.

## Deferred

- The real approval flow (coordinator → beacon → agent, with a pre-approval
  token) that addresses all three of the following at once: the accepted risks
  above, the mTLS/3456 deadlock, and remote extensions.
- Bundle verification (signatures, sandboxing).
