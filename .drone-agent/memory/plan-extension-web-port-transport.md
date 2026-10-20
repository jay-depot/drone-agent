---
key: plan-extension-web-port-transport
tags:
  - plan
  - swarm-extensions
  - coordinator
  - web-port
  - transport
  - adr-257
  - ws-beacon
  - nullable-port
created: 2026-10-20T01:49:08.710Z
updated: 2026-10-20T01:49:08.710Z
---

# Plan: Swarm Extensions Over the Coordinator's Unencrypted Port

Status: ready for execution. ADR to be written: 257.

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

### Step 1 - Make `port` a nullable column

Agent: coder. Depends on: none.

File: `drone-coordinator/src/db/init.ts`

1. Change the DDL for `beacons` (line 41) and `beacon_trust` (line 68):
   `port INTEGER NOT NULL,` becomes `port INTEGER,`
2. Add an idempotent migration after line 291. SQLite cannot remove NOT NULL in
   place, so rebuild each table the same way the `skills` migration does at
   line 241.

```ts
export function makeBeaconPortOptional(db: Database): void {
  for (const table of ['beacons', 'beacon_trust'] as const) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const port = cols.find(c => c.name === 'port');
    if (!port || port.notnull === 0) continue;

    const names = cols.map(c => c.name).join(', ');
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE ${table}_new (...explicit DDL, port INTEGER...)`);
      db.exec(`INSERT INTO ${table}_new (${names}) SELECT ${names} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
```

Warning: `CREATE TABLE ... AS SELECT` loses constraints and defaults. Write the two
new tables with explicit DDL, copied from the existing definitions with `port`
nullable. Keep every other constraint, default, and primary key.

3. Call the migration after the schema exec block, with the other migrations.

Test: open an existing database with `port INTEGER NOT NULL`, run the migration,
assert `PRAGMA table_info` shows `notnull = 0` for both tables and existing rows
are unchanged.

### Step 2 - Make `port` optional in the types

Agent: coder. Depends on: none. Runs parallel to Step 1.

File: `drone-coordinator/src/types.ts`

| Interface | Line | Change |
| --- | --- | --- |
| `Beacon` | 18 | `port: number` becomes `port: number \| null` |
| `RegisterBeaconRequest` | 26 | `port: number` becomes `port?: number` |
| `RegisterBeaconTrustRequest` | ~57 | `port: number` becomes `port?: number` |
| `BeaconTrust` | ~40 | `port: number` becomes `port: number \| null` |

Add to `RegisterBeaconRequest`:

```ts
/**
 * Present when the caller is a swarm extension: it declares a capability
 * manifest over /ws/beacon. Extensions have no listen port.
 */
extension?: { protocolVersion: number };
```

File: `drone-coordinator/src/db/beacon-trust.ts` - change the row type at line 17 to
`port: number | null`.

### Step 3 - Merge-on-omit for `host` and `port` in the DB layer

Agent: coder. Depends on: Steps 1, 2.

This follows the ADR 200 rule: an omitted field preserves the stored value.

File: `drone-coordinator/src/db/beacon-trust.ts`, `registerBeaconTrust`:

- Re-registration branch (lines 62-105): add `const port = req.port ?? existing.port;`
  Use `port` in the UPDATE parameters and in the returned object.
- Fresh-registration branch (lines 118-140): use `port: req.port ?? null` in the
  inserted row and in the returned object.

File: `drone-coordinator/src/db/beacons.ts`, `registerBeacon`:

- Read the existing row before the INSERT OR REPLACE, as the roots merge already does.
- Resolve `host: req.host ?? existing?.host ?? null` and
  `port: req.port ?? existing?.port ?? null`.

Test: register with a port, re-register without one, assert the port is preserved.
Register without a port, assert the row stores null.

### Step 4 - Thread the optional port through `POST /api/beacons`

Agent: coder. Depends on: Step 3.

File: `drone-coordinator/src/routes/beacons.ts`

1. In the trust branch (lines 38-46), pass `extension: request.body.extension` into
   `trustReq`.
2. Reject a protocol version mismatch with 400:

```ts
if (
  request.body.extension &&
  request.body.extension.protocolVersion !== EXTENSION_PROTOCOL_VERSION
) {
  return reply.code(400).send({
    error: `Unsupported extension protocol version: ${request.body.extension.protocolVersion}`,
  });
}
```

Import `EXTENSION_PROTOCOL_VERSION` from `drone-core`.

3. In the `db.registerBeacon` call inside the trust branch, use the port the trust
   store resolved, so `beacons.port` equals `beacon_trust.port` on a re-registration
   that omits the port:

```ts
db.registerBeacon({
  id: request.body.id,
  name: request.body.name,
  host: request.body.host,
  port: trust.port ?? undefined,
  spawnRoots: request.body.spawnRoots,
  defaultSpawnRoot: request.body.defaultSpawnRoot,
});
```

Test: extension registration (no `port`, `extension: { protocolVersion: 1 }`)
returns 201 with `status: 'approved'` when the peer is loopback. `GET /api/beacons`
then shows the node with `port: null`. A `protocolVersion: 2` body returns 400.

### Step 5 - Add a shared request-to-node-id resolver

Agent: coder. Depends on: none. Runs parallel.

File: `drone-coordinator/src/mtls.ts`

Add one helper next to `resolveBeaconIdByFingerprint`. Do not duplicate this logic in
the routes.

```ts
/**
 * Resolve the calling node id. A client certificate wins when one is presented,
 * and fails closed when it does not resolve. Without a certificate (the
 * unencrypted web port) the caller's own claim is used, from the `x-node-id`
 * header and then from a `beaconId` query parameter. The claim is trusted only
 * because the web port is bound to loopback (ADR 257).
 */
export function resolveRequestNodeId(
  req: FastifyRequest
): string | undefined {
  const fingerprint = getClientCertFingerprint(req);
  if (fingerprint) {
    return resolveBeaconIdByFingerprint(fingerprint);
  }
  const header = req.headers['x-node-id'];
  if (typeof header === 'string' && header) {
    return getBeaconTrust(header) ? header : undefined;
  }
  const query = new URL(req.url ?? '', 'http://localhost').searchParams.get(
    'beaconId'
  );
  if (query) {
    return getBeaconTrust(query) ? query : undefined;
  }
  return undefined;
}
```

The certificate branch fails closed. A certificate that does not resolve is never
replaced by a claim.

Test: certificate resolves and a claim disagrees - the certificate wins.
Unresolvable certificate plus a claim - undefined. No certificate plus a valid
`x-node-id` header - that id. No certificate plus `?beaconId=` - that id. Unknown
claimed id - undefined.

### Step 6 - Extract the socket admission path and accept a claim

Agent: coder. Depends on: Step 5.

File: `drone-coordinator/src/beacon-ws.ts`

1. Extract the shared admission body out of `registerBeaconWebSocket` (lines 334-370)
   into one helper. Do not duplicate it.

```ts
function admitBeaconSocket(
  socket: WebSocket,
  beaconId: string | undefined,
  origin: 'certificate' | 'claim'
): boolean {
  if (!beaconId) {
    const reason =
      origin === 'certificate'
        ? 'Unauthorized: client certificate not a registered beacon'
        : 'Unauthorized: beaconId is missing or not registered';
    logger.warn(`Rejected beacon WebSocket connection: ${reason}`);
    socket.close(4001, reason);
    return false;
  }
  const refusal = resolveBeaconWsAdmission(beaconId);
  if (refusal) {
    logger.warn(
      `Rejected beacon WebSocket connection: beacon ${beaconId} not yet approved`
    );
    socket.close(refusal.code, refusal.reason);
    return false;
  }
  registerBeaconConnection(beaconId, socket);
  socket.on('message', (raw: Buffer) => {
    dispatchIncoming(beaconId, raw.toString());
  });
  socket.on('close', () => {
    unregisterBeaconConnection(beaconId);
  });
  return true;
}
```

2. Rewrite the route handler to use `resolveRequestNodeId` from Step 5.

```ts
app.get('/ws/beacon', { websocket: true }, (socket, request) => {
  const fastifyReq = request as unknown as FastifyRequest;
  const origin = getClientCertFingerprint(fastifyReq) ? 'certificate' : 'claim';
  admitBeaconSocket(socket, resolveRequestNodeId(fastifyReq), origin);
});
```

3. Update the module doc comment (lines 50-58). It says the endpoint authenticates
   by mTLS certificate. Add: on the unencrypted web port there is no certificate, so
   the node id is claimed, and the port is bound to loopback.

Test: certificate-less socket with a valid approved `?beaconId=` is admitted.
Unknown id closes 4001. Known but unapproved closes 4002. A certificate that does
not resolve closes 4001 even when `?beaconId=` is valid.

### Step 7 - Register `/ws/beacon` on both servers

Agent: coder. Depends on: Step 6.

File: `drone-coordinator/src/index.ts`, `buildApp` (lines 366-381). Replace the block:

```ts
  if (opts?.getToken) {
    app.addHook('onRequest', createWebAuthMiddleware(opts.getToken));
  }

  if (opts?.enableMtls) {
    app.addHook(
      'onRequest',
      createMtlsMiddleware({ httpsEnabled: !!opts.https })
    );
  }

  // The reverse channel serves beacons on the primary port (mTLS identity)
  // and extensions on the web port (claimed identity, loopback-only, ADR 257).
  await app.register(import('@fastify/websocket'));
  registerBeaconWebSocket(app);
  startBeaconLivenessSweep();
```

Make the liveness sweep idempotent. `connections` is a module-level map shared by both
servers. Two sweeps would ping and terminate every socket twice. There is currently no
existing guard - `grep` for `sweepTimer` and `stopBeaconLivenessSweep` returns nothing,
so add both.

File: `drone-coordinator/src/beacon-ws.ts`, `startBeaconLivenessSweep` (line 376):

```ts
let sweepTimer: NodeJS.Timeout | null = null;

export function startBeaconLivenessSweep(intervalMs = 30000): NodeJS.Timeout {
  if (sweepTimer) return sweepTimer;
  const interval = setInterval(/* unchanged body */);
  interval.unref();
  sweepTimer = interval;
  return interval;
}

export function stopBeaconLivenessSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
```

Call `stopBeaconLivenessSweep()` from the shutdown path so tests do not leak timers.

`attachUi` already guards `@fastify/websocket` with `if (!app.hasRequestDecorator('ws'))`,
so no change is needed there.

Test: call `startBeaconLivenessSweep()` twice and assert only one timer exists. Build
the web app and assert `/ws/beacon` exists on it.

### Step 8 - Accept a claimed node id on bundle upload and delete

Agent: coder. Depends on: Step 5.

File: `drone-coordinator/src/routes/extensions.ts`

Replace the inline certificate resolution in PUT (lines 166-175) and DELETE
(lines 242-250) with the shared helper:

```ts
const nodeId = resolveRequestNodeId(request);
if (!nodeId) {
  return reply.code(401).send({ error: 'A registered node identity is required' });
}
```

Update both route comments. They say the auth is the uploading node's mTLS certificate.

Test: certificate present resolves by fingerprint as before. No certificate plus
`x-node-id: mcp-swarm` uploads successfully. Unknown `x-node-id` returns 401. No
certificate and no claim returns 401.

### Step 9 - SDK: registration payload, socket target, logging, backoff

Agent: coder. Depends on: Steps 4, 7.

File: `drone-swarm-common/src/extension-server.ts`

(a) Send the node's own address and no port (lines 148-162):

```ts
body: JSON.stringify({
  id: opts.id,
  name: opts.name,
  host: opts.host,
  publicKey: identity.publicKey,
  tlsFingerprint: tlsIdentity.fingerprint,
  fingerprintConfirmed: false,
  extension: { protocolVersion: EXTENSION_PROTOCOL_VERSION },
}),
```

Add to `CreateExtensionNodeOptions`:

```ts
/**
 * The address other swarm members should use to reach this node. Extensions
 * have no listen port, so no port is registered. v0 extensions are local-only,
 * so this defaults to loopback (ADR 257).
 */
host?: string;
```

Set `const host = opts.host ?? '127.0.0.1';` at the top of `createExtensionNode`.

(b) Certificate-less socket for http:// coordinators (lines 234-241):

```ts
const wsUrl = opts.coordinatorUrl.replace(/^http/, 'ws') + '/ws/beacon';
const certless = !opts.coordinatorUrl.startsWith('https:');
const target = certless
  ? `${wsUrl}?beaconId=${encodeURIComponent(opts.id)}`
  : wsUrl;
const wsOptions: WebSocket.ClientOptions = certless
  ? { headers: { 'x-node-id': opts.id } }
  : {
      // codeql[js/disabling-certificate-verification]
      rejectUnauthorized: false,
      cert: tlsIdentity.certPem,
      key: tlsIdentity.keyPem,
    };
ws = new WebSocket(target, wsOptions);
```

Keep the https: branch byte-for-byte equivalent to today, so the mTLS path does not
change.

(c) Do not log success before admission. Add `let admitted = false;` and
`let policyCloseLogged = false;` next to `attempts`.

- On open: `logger.info(\`Extension node ${opts.id} socket open, awaiting admission\`)`.
  Do NOT reset `attempts`.
- In the `event` branch of `on('message')`: if `!admitted`, set `admitted = true`,
  `attempts = 0`, `policyCloseLogged = false`, and log "admitted to coordinator".
- On close(code): capture `wasAdmitted = admitted`, then `admitted = false`. If
  `!wasAdmitted && (code === 4001 || code === 4002)` and `!policyCloseLogged`, log
  one warning naming the code and saying the node was not admitted, then set
  `policyCloseLogged = true`. If `wasAdmitted`, reset `attempts = 0`. Then
  `scheduleReconnect()`.

Result: a node never admitted escalates 1s to 30s and logs one line. A node admitted
and then dropped reconnects immediately.

(d) Boot even when registration fails. Replace the tail of `createExtensionNode`
(lines 355-364):

```ts
if (opts.awaitRegistration === false) {
  void tryRegister();
} else {
  try {
    await register();
    connect();
  } catch (err) {
    logger.warn(`Extension node registration failed: ${err}`);
    connect();
    scheduleRegisterRetry();
  }
}
```

Update the `awaitRegistration` JSDoc: a registration failure no longer rejects; the
node opens the socket, which the coordinator will refuse, and retries in the
background. Update the module header comment (lines 19-23) to describe the
unencrypted web port path.

Test: registration payload has `host: '127.0.0.1'` and no `port`. An http:// base
gives a target URL with `?beaconId=` and no cert/key. An https:// base gives no query
and cert/key present. Close code 4002 logs one warning and the retry delay escalates.
Admission resets the delay. A failing `register()` with default options still resolves
and opens the socket.

### Step 10 - Retarget `mcp-swarm`

Agent: coder. Depends on: Step 9.

File: `mcp-swarm/src/index.ts` line 35:

```ts
coordinatorUrl: env.MCP_SWARM_COORDINATOR_URL ?? 'http://127.0.0.1:8080',
```

File: `mcp-swarm/README.md` - update the environment table default, and add one
sentence to "What it does" step 1: the node connects to the coordinator's web port,
which is unencrypted and bound to loopback, and registration is auto-approved because
the caller is local.

Test: assert the resolved default is `http://127.0.0.1:8080`.

### Step 11 - Documentation and ADR

Agent: coder. Depends on: Steps 1-10. Write the ADR after the code is stable.

File: `docs/adr/257-extension-node-web-port-transport.md` (new)

- Status: Accepted.
- Context: the deadlock from section 1, with the `index.ts:369-380` citation and the
  `beacon-trust.ts` pending rule.
- Decision: D1-D9, each with its rejected alternative.
- Consequences: the four accepted risks.
- Deferred: the real approval flow; the mTLS/3456 deadlock; remote extensions; bundle
  verification.

File: `docs/adr/index.md` - add the 257 row.

File: `docs/agents/swarm-extensions.md`

- Change the worked example from `coordinatorUrl: 'http://127.0.0.1:3456'` to
  `'http://127.0.0.1:8080'`.
- Add a `## Transport` section: a table of the two ports, the identity mechanism for
  each, and the statement that the SDK does not implement the mTLS approval handshake.
  State that pointing an extension at the primary port leaves it pending.
- Update "Constraints (v0)" with a pointer to ADR 257.
- Update the "Registration" subsection: it currently says registration is "mTLS,
  Ed25519 identity + TLS cert". Add that on the web port there is no client
  certificate and the node id is claimed.

File: `docs/agents/swarm-plugin.md` - verify nothing in it claims extensions use mTLS,
and correct it if it does.

### Step 12 - Tests

Agent: tester. Depends on: each step, delivered with that step.

Every step lists its own tests. Add these integration tests at the end:

| File | Test |
| --- | --- |
| `drone-coordinator/test/beacon-ws-web-port.test.ts` | Certificate-less `/ws/beacon?beaconId=...` for an approved node is admitted on a web app. |
| `drone-coordinator/test/routes/extensions.test.ts` | Bundle PUT with `x-node-id` succeeds. DELETE with `x-node-id` succeeds. |
| `drone-coordinator/test/routes/beacons.test.ts` | Extension registration records `port: null` and `host: '127.0.0.1'`. Protocol version mismatch returns 400. |
| `drone-coordinator/test/db.test.ts` | Port merge-on-omit, and the nullable-port migration. |
| `drone-swarm-common/test/extension-server.test.ts` | Payload shape, socket target per scheme, admitted log, backoff on 4001/4002, boot despite registration failure. |
| `mcp-swarm/test/*.test.ts` | Default coordinator URL is port 8080. |

Use a waitUntil-style polling helper for asynchronous assertions. Never use fixed
timers.

### Step 13 - Validate the work against section 4

Agent: reviewer. Depends on: Steps 1-12.

1. Run every command in section 4.
2. Read the diff against every decision in section 2. Report any drift.
3. Confirm the mTLS path is byte-for-byte unchanged. The `drone-beacon/` diff must be
   empty.
4. Run the manual end-to-end check.

## 4. Validation Criteria

### Automated

All must pass with zero errors:

```
pnpm -r run build
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm lint` runs Prettier. Re-read every file after it runs before editing again.

LSP diagnostics must be clean for the whole workspace. Check severity error and
severity warning. No new diagnostics.

After changing `drone-core` or `drone-swarm-common` types, run `pnpm -r run build`
before trusting TypeScript in dependent packages. They resolve those packages from
`dist/`.

### Behavioural

1. `POST /api/beacons` on the web app with `extension: { protocolVersion: 1 }`, no
   `port`, from a loopback peer returns 201 with `status: 'approved'`.
2. `GET /api/beacons` shows that node with `host: '127.0.0.1'` and `port: null`. The
   coordinator UI shows the address as `127.0.0.1`, not `127.0.0.1:null` and not
   `127.0.0.1:0`. The two render sites are `drone-coordinator-ui/src/pages/beacon-detail.tsx:242`
   and `drone-coordinator-ui/src/pages/topology.tsx:332`.
3. A certificate-less WebSocket to `/ws/beacon?beaconId=<node>` stays open. An unknown
   id closes 4001. The same node with an unapproved status closes 4002.
4. `PUT /api/extensions/bundles/<name>` with `x-node-id: <node>` returns 200.
5. A node that never reaches admission logs one warning and its retry delay reaches
   30s. It does not log "connected to coordinator" and does not log once per second.
6. `drone-beacon` connects exactly as before. Its registration payload still carries
   its own host and port. Its socket still authenticates by certificate.

### Manual end-to-end

Run on the coordinator host:

```bash
pnpm --filter drone-coordinator run start
pnpm --filter mcp-swarm run build
node mcp-swarm/bin/mcp-swarm
curl -s http://127.0.0.1:8080/api/extensions | jq '.[] | {nodeId, connected, bundles}'
curl -s -X POST http://127.0.0.1:8080/api/extensions/mcp-swarm/actions/swarm.session.list \
  -H 'Content-Type: application/json' -d '{"params":{}}'
curl -sI http://127.0.0.1:8080/api/extensions | grep -o 'plugin-scripts[^"]*'
```

Success: `connected: true`, a non-empty `bundles` array, and the fourth command returns
a 200 body from the extension.

## 5. Notes for the Executing Agent

- Do not touch `drone-beacon/`. It is already correct. If a type change forces an edit
  there, stop and report it.
- Do not add authentication. That is the next iteration, by explicit instruction.
- Do not remove the mTLS exemptions in `mtls.ts` (lines 66-82). They are load-bearing
  for the still-supported beacon approval handshake.
- Keep names descriptive. Remove single-word step comments. Do not exceed 750 lines per
  file; `beacon-ws.ts` is at 563 lines, so watch it.
