---
key: plan-extension-web-port-transport
tags:
  []
created: 2026-10-20T01:49:08.710Z
updated: 2026-10-20T02:19:14.932Z
---

# Plan: Swarm Extensions Over the Coordinator's Unencrypted Port

Status: EXECUTED (2026-10-20). ADR written: 257. Commit: 427fd516 on `feat/swarm-extensions`.

## 1. Summary

### The problem

A swarm extension cannot connect to the coordinator. The extension SDK
(`createExtensionNode` in `drone-swarm-common`) sends `POST /api/beacons` and then
opens a WebSocket to `/ws/beacon`.

The coordinator runs two HTTP servers:

| Port | Default | Security | Has `/ws/beacon`? |
| --- | --- | --- | --- |
| Primary (swarm) | 3456 | TLS + mTLS client certificate | Yes |
| Web | 8080 (bound 127.0.0.1) | none, or bearer token | **No** |

`registerBeaconWebSocket(app)` is called only inside the `if (opts.enableMtls)`
branch (`drone-coordinator/src/index.ts:369-380`). Therefore `/ws/beacon` does not
exist on the web port. A node pointed at `http://127.0.0.1:8080` registers, then
gets a 404 on the socket.

A node pointed at the primary port (3456) is worse off. A same-host caller is
often seen with a non-loopback source address, because the primary port binds a
non-loopback interface. Then `isLoopbackIp()` returns false, so the node registers
as `pending`. Approval needs two steps: a signed
`POST /api/beacons/trust/:id/confirm-fingerprint`, then operator approval. The SDK
never sends step 1. The node can never be approved. This is a hard deadlock.

### Why we implement this change

The unencrypted web port already has the correct trust posture for local
extensions: registration from loopback is auto-approved, and the port binds
127.0.0.1. But the port has no reverse channel. This change adds the reverse
channel, and the two route behaviours it needs, to the web port.

### What we do NOT change

- The mTLS path.
- `drone-beacon`.
- Authentication on the web port.
- The 3456 approval deadlock.

A new approval flow is planned for a later iteration. It will address all three.

## 2. Locked Decisions

| # | Decision | Selection |
| --- | --- | --- |
| D1 | Target surface | Use the existing web port (8080). No new port. No third server. |
| D2 | Where extensions run | Coordinator host only. Web port stays bound to 127.0.0.1. Loopback registration is auto-approved. |
| D3 | Node identity on the certificate-less socket | None. The node claims its id. Local callers are trusted. No new auth scheme. |
| D4 | mTLS path | Unchanged. Fix the web port only. The 3456 deadlock stays reachable, and the docs must say so. |
| D5 | Bundle upload on the web port | Accept a claimed node id from a local caller. No signature. |
| D6 | Node identification at the WebSocket upgrade | Query parameter `?beaconId=<id>`. |
| D7 | Consumers to retarget | `mcp-swarm` default URL and the docs. No `drone-gateway` code change. |
| D8 | SDK hygiene | Fix the false "connected" log and the reconnect backoff. |
| D9 | Registration address fields | Beacons send their listen address and listen port. Extensions send their address only (always 127.0.0.1) and no port. `port` becomes optional and nullable. |

### Accepted risks (documented, not mitigated)

1. Any local process can register as an extension and inject prompt fragments into
   every agent session.
2. Any local process can open a certificate-less socket that claims another node's
   id. This displaces that node's socket, because `connections` holds one socket
   per `beaconId`. Denial of service only.
3. Any local process can upload a bundle under another node's id. Bundles are
   served same-origin with full page trust.
4. An extension pointed at `https://...:3456` still stays pending forever.

## 3. Steps

(Full step text preserved in the original section below.)

## 4. Validation Criteria

(Full text preserved in the original section below.)

## 5. Notes for the Executing Agent

(Full text preserved in the original section below.)

---

## EXECUTION SUMMARY (appended 2026-10-20 by the `code` agent)

All 13 steps executed. All automated validation passes:
`pnpm -r run build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`
(4243 passed / 16 skipped), clean LSP diagnostics, `drone-beacon/` diff empty.

Files changed (30, commit 427fd516):
- `drone-coordinator/src/db/init.ts` — nullable `port` DDL + `makeBeaconPortOptional`
  rebuild migration; `db/index.ts` re-exports it.
- `drone-coordinator/src/types.ts` — `Beacon.port`/`BeaconTrust.port` -> `number | null`,
  `RegisterBeaconRequest`/`RegisterBeaconTrustRequest.port` optional, `extension?` field.
- `drone-coordinator/src/db/beacon-trust.ts`, `db/beacons.ts` — merge-on-omit for host/port.
- `drone-coordinator/src/routes/beacons.ts` — extension payload + protocol-version 400.
- `drone-coordinator/src/mtls.ts` — shared `resolveRequestNodeId` (cert wins, fails closed;
  else `x-node-id` header then `?beaconId=`).
- `drone-coordinator/src/beacon-ws.ts` — `admitBeaconSocket` extracted; idempotent
  `startBeaconLivenessSweep` + `stopBeaconLivenessSweep`.
- `drone-coordinator/src/index.ts` — `/ws/beacon` registered on both servers; sweep
  stopped on shutdown.
- `drone-coordinator/src/routes/extensions.ts` — claimed node id on bundle PUT/DELETE.
- `drone-swarm-common/src/extension-server.ts` — host-only payload, claimed-id socket
  over http, honest admission logging + backoff, boot despite registration failure,
  **and claimed `x-node-id` on bundle upload** (defect found in the manual E2E).
- `mcp-swarm/src/index.ts` + `README.md` — default coordinator URL -> `http://127.0.0.1:8080`.
- `drone-coordinator-ui/src/lib/types.ts`, `pages/beacon-detail.tsx`, `pages/topology.tsx`
  — address renders host-only when `port` is null (no `127.0.0.1:null`).
- `docs/adr/257-extension-node-web-port-transport.md` (new) + `docs/adr/index.md` row;
  `docs/agents/swarm-extensions.md` Transport section + example retarget.
- Tests: `beacon-ws-web-port.test.ts`, `routes/extensions.test.ts`, `mcp-swarm/test/config.test.ts`
  (new); `db.test.ts`, `beacon-ws.test.ts`, `mtls.test.ts`, `routes/beacons.test.ts`,
  `extensions-routes.test.ts`, `extension-server.test.ts` (extended).

### Deviations from the plan (all justified)
1. **Step 1 DDL fix.** The plan's `beacon_trust` rebuild DDL omitted
   `fingerprint_confirmed_at` (added by an earlier migration). Added it; otherwise the
   migration would have dropped the column. Caught by the migration test.
2. **UI port guards (Step 11/validation 2).** The plan listed the two UI render sites
   as a validation criterion but did not put a UI step in section 3. Fixed both render
   sites and the UI `Beacon.port` type, because the criterion would otherwise fail.
3. **SDK bundle upload (Step 9).** The plan did not state it, but `uploadBundle` must
   claim the node id over http or bundle upload 401s on the web port (D5). Found by the
   manual end-to-end check; fixed and covered by a new test.

### Manual end-to-end result
Coordinator on `--no-https` (web 8080, primary 3456) + `mcp-swarm`:
`GET /api/extensions` -> `connected: true`, `bundles: ['status-panel']`; the
`swarm.session.list` action POST returned `{ok:true,status:200,body:{sessions:[],count:0}}`.
Behavioural checks 1-6 all confirmed.
