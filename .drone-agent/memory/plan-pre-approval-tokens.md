---
key: plan-pre-approval-tokens
tags: []
created: 2026-10-20T15:20:44.557Z
updated: 2026-10-20T15:20:44.557Z
---

# Plan: Pre-approval tokens for beacon and extension nodes

**Status**: ready for execution. Next ADR number = **258**.
**Branch**: create `feat/pre-approval-tokens` off the current `main`.

## 1. Summary

Today a remote node (a beacon or an extension) must wait for manual approval. A user must approve it in the coordinator UI or on the command line. This plan adds a **pre-approval token**.

The user makes a token in the coordinator UI. The user gives the token to the node on the command line. The node uses the token one time. The node then exits. The coordinator records the node as approved. A later start of the same node connects without manual work.

The token is a **sensitive credential**. The UI shows a warning. The UI shows the token one time only.

**Why this is necessary**: the coordinator has **no signing key**. Its only cryptographic identity is an RSA TLS certificate. A token must carry a coordinator signature. Therefore this plan first gives the coordinator a dedicated Ed25519 identity.

## 2. Scope

### 2.1 In scope

- A dedicated Ed25519 signing identity for the coordinator.
- A `pre_approval_tokens` table in the coordinator database.
- A redemption route: `POST /api/beacons/trust/redeem`.
- Mint, list, and revoke routes for the UI.
- A one-shot redemption helper in `drone-swarm-common`.
- The `--pre-approval-token-path` flag on `mcp-swarm` and `drone-gateway`.
- Coordinator TLS fingerprint pinning for the node (no TOFU).
- A persistent coordinator trust file on the node.
- A new coordinator UI page for token management.
- Docs and ADR 258.

### 2.2 Out of scope

- Token use by `drone-beacon` (deferred; the helper makes this easy later).
- Token expiry configuration (the lifetime is a fixed constant).
- Per-token permissions or scopes.
- A CLI mint command (the UI is the mint surface).
- The full remote-extension feature (this plan only covers the approval path).
- Bundle signature verification.

## 3. Locked decisions

| #   | Decision                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | The coordinator gets a **dedicated Ed25519 identity**. Load it with `loadOrCreateIdentity('coordinator', configDir, 'coordinator-identity.json')`. Sign with `signBeaconPayload(identity.privateKeyPem, payload)`. The token `pubKey` is `identity.publicKey` (base64 SPKI). |
| Q2  | The token file **is** the trust anchor. The node checks only the self-signature against the embedded `pubKey`. The token is a sensitive credential. The UI must warn.                                                                                                        |
| Q3  | `burnKey` is an Ed25519 **private key as PKCS#8 PEM**. The coordinator stores the public half (base64 SPKI) with the `durableId`. The token carries only the private half.                                                                                                   |
| Q4  | The token run does a **normal registration, then a redemption**. The redemption approves the trust row whose `public_key` equals `clientKey`. `durableId` is the token database primary key. It is **not** the node id.                                                      |
| Q5  | Use a dedicated route: `POST /api/beacons/trust/redeem`. The body is `{durableId, clientKey, pubKey, sig}`. The route is mTLS-exempt. It needs no web token. The burn-key signature **is** the credential.                                                                   |
| Q6  | Use a **dedicated UI page** at `/pre-approval-tokens`. The Topology page links to it. There is **no** nav item. The page has a list, a create form (one-time display, copy, download, warning), and a revoke action.                                                         |
| Q7  | The token file is JSON. The flag `--pre-approval-token-path` accepts both `=value` and ` value` forms.                                                                                                                                                                       |
| Q8  | Add the flag to **`mcp-swarm` and `drone-gateway`**. Put the shared logic in one helper in `drone-swarm-common`. `drone-beacon` is deferred.                                                                                                                                 |
| Q9  | The token expires **30 days** after issue. The lifetime is a hardcoded constant. The table has `issued_at` and `expires_at` columns. Revoke deletes the row.                                                                                                                 |
| Q10 | Use `durableId` (camelCase) everywhere. The table is `pre_approval_tokens`.                                                                                                                                                                                                  |
| Q11 | Signatures are `:`-joined in schema order. This matches the existing `beaconId + ':' + timestamp` convention.                                                                                                                                                                |
| Q12 | The token targets **remote (non-loopback) nodes** for now. A loopback node is already auto-approved. The plan must not assume loopback.                                                                                                                                      |
| Q13 | Add an optional `label`. The label lives in the database row and the UI only. The token file stays at its fixed field set.                                                                                                                                                   |
| Q14 | The redemption treats the burn-key verification **as** the fingerprint confirmation. It sets both `status='approved'` and `fingerprint_confirmed_at`.                                                                                                                        |
| Q15 | The token carries the coordinator **TLS fingerprint**. The node **pins** it. There is no TOFU.                                                                                                                                                                               |
| Q16 | The one-shot run writes `{coordinatorUrl, tlsFingerprint}` to `<dataDir>/coordinator-trust.json`. `createExtensionNode` reads that file when it receives no explicit fingerprint.                                                                                            |

## 4. Interfaces

### 4.1 Token file

The user downloads this file. The node reads it.

```json
{
  "durableId": "3f2a…-uuid",
  "pubKey": "<coordinator Ed25519 public key, base64 SPKI>",
  "tlsFingerprint": "<coordinator TLS cert SHA-256, hex, no colons>",
  "burnKey": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
  "sig": "<base64 Ed25519 signature>"
}
```

### 4.2 Redemption request

The node sends this body to the redeem route.

```json
{
  "durableId": "3f2a…-uuid",
  "clientKey": "<node Ed25519 public key, base64 SPKI>",
  "pubKey": "<coordinator Ed25519 public key, base64 SPKI>",
  "sig": "<base64 Ed25519 signature over the redemption payload>"
}
```

### 4.3 Signature payloads

Both signatures use a `:`-joined string. Both use `signBeaconPayload` and `verifyBeaconSignature`.

```
token sig payload      = durableId + ':' + pubKey + ':' + tlsFingerprint + ':' + burnKey
redemption sig payload = durableId + ':' + clientKey + ':' + pubKey
```

The token signature uses the **coordinator private key**. The redemption signature uses the **burn private key**.

`:` is a safe separator. Base64 and PEM data contain no colon.

### 4.4 HTTP routes

| Method   | Path                                  | Auth                      | Purpose                             |
| -------- | ------------------------------------- | ------------------------- | ----------------------------------- |
| `POST`   | `/api/beacons/trust/redeem`           | none (burn-key signature) | Redeem a token and approve the node |
| `POST`   | `/api/pre-approval-tokens`            | web token                 | Mint a token                        |
| `GET`    | `/api/pre-approval-tokens`            | web token                 | List tokens                         |
| `DELETE` | `/api/pre-approval-tokens/:durableId` | web token                 | Revoke a token                      |

The mint response returns the full token object one time:

```json
{
  "token": {
    "durableId": "…",
    "pubKey": "…",
    "tlsFingerprint": "…",
    "burnKey": "…",
    "sig": "…"
  },
  "entry": {
    "durableId": "…",
    "label": "gateway on the pi",
    "issuedAt": 0,
    "expiresAt": 0,
    "burnedAt": null,
    "burnedBy": null
  }
}
```

The list response returns the entries only. It never returns `burnKey` or `burn_public_key`.

### 4.5 Database table

Add to `drone-coordinator/src/db/init.ts`. Use an idempotent `CREATE TABLE IF NOT EXISTS`.

```sql
CREATE TABLE IF NOT EXISTS pre_approval_tokens (
  durable_id TEXT PRIMARY KEY,
  burn_public_key TEXT NOT NULL,
  label TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  burned_at INTEGER,
  burned_by TEXT
);
```

`burned_at` is null when the token is unused. This is the "burned" column from the request.

### 4.6 CLI flag

```
--pre-approval-token-path=./token.json
--pre-approval-token-path ./token.json
```

Both forms must work. No shared CLI helper exists. Add a small local parse for this flag in each binary.

### 4.7 Trust file

Path: `<dataDir>/coordinator-trust.json`, mode `0600`.

```json
{ "coordinatorUrl": "https://10.0.0.5:3456", "tlsFingerprint": "<hex>" }
```

### 4.8 Error codes

| Code  | Name                    | Cause                                    |
| ----- | ----------------------- | ---------------------------------------- |
| `404` | `TOKEN_NOT_FOUND`       | No row with that `durableId`             |
| `410` | `TOKEN_EXPIRED`         | `expires_at` is in the past              |
| `409` | `TOKEN_ALREADY_BURNED`  | The row already has `burned_at`          |
| `400` | `INVALID_SIGNATURE`     | The redemption signature does not verify |
| `404` | `CLIENT_NOT_REGISTERED` | No trust row has that `public_key`       |

## 5. Steps

Run `lsp__get_diagnostics` after every step.

### Phase A — Shared crypto and the coordinator signing identity

**A1 — Add the pre-approval crypto helpers. Agent: coder.**
File: `drone-swarm-common/src/pre-approval.ts` (new). Add `export * from './pre-approval.js';` to `drone-swarm-common/src/index.ts`.

```ts
import { generateIdentity } from './identity.js';
import { signBeaconPayload, verifyBeaconSignature } from './verification.js';

export const PRE_APPROVAL_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PreApprovalToken {
  durableId: string;
  pubKey: string;
  tlsFingerprint: string;
  burnKey: string;
  sig: string;
}

export function buildTokenSignaturePayload(
  token: Omit<PreApprovalToken, 'sig'>
): string {
  return [
    token.durableId,
    token.pubKey,
    token.tlsFingerprint,
    token.burnKey,
  ].join(':');
}

export function buildRedemptionSignaturePayload(input: {
  durableId: string;
  clientKey: string;
  pubKey: string;
}): string {
  return [input.durableId, input.clientKey, input.pubKey].join(':');
}

export function verifyPreApprovalToken(token: PreApprovalToken): boolean {
  return verifyBeaconSignature(
    token.pubKey,
    buildTokenSignaturePayload(token),
    token.sig
  );
}

export function generateBurnKey(): {
  publicKey: string;
  privateKeyPem: string;
} {
  const burn = generateIdentity('burn');
  return { publicKey: burn.publicKey, privateKeyPem: burn.privateKeyPem };
}

export { signBeaconPayload };
```

Dep: none.

**A2 — Add the trust-file helpers. Agent: coder.**
File: `drone-swarm-common/src/coordinator-trust.ts` (new). Add the barrel export.

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CoordinatorTrust {
  coordinatorUrl: string;
  tlsFingerprint: string;
}

const TRUST_FILENAME = 'coordinator-trust.json';

export async function saveCoordinatorTrust(
  dataDir: string,
  trust: CoordinatorTrust
): Promise<void> {
  await writeFile(
    join(dataDir, TRUST_FILENAME),
    JSON.stringify(trust, null, 2),
    { mode: 0o600 }
  );
}

export async function loadCoordinatorTrust(
  dataDir: string
): Promise<CoordinatorTrust | undefined> {
  try {
    const raw = await readFile(join(dataDir, TRUST_FILENAME), 'utf8');
    return JSON.parse(raw) as CoordinatorTrust;
  } catch {
    return undefined;
  }
}
```

Dep: none.

**A3 — Add the coordinator signing identity holder. Agent: coder.**
File: `drone-coordinator/src/signing-identity.ts` (new). Mirror the `health.ts` fingerprint holder.

```ts
import type { SwarmNodeIdentity } from 'drone-swarm-common';

let signingIdentity: SwarmNodeIdentity | null = null;

export function setSigningIdentity(identity: SwarmNodeIdentity): void {
  signingIdentity = identity;
}

export function getSigningIdentity(): SwarmNodeIdentity | null {
  return signingIdentity;
}
```

Dep: none.

**A4 — Load the signing identity at coordinator startup. Agent: coder.**
File: `drone-coordinator/src/index.ts`. Next to the existing `loadOrCreateTlsIdentity(config.configDir, 'coordinator')` call:

```ts
const signingIdentity = await loadOrCreateIdentity(
  'coordinator',
  config.configDir,
  'coordinator-identity.json'
);
setSigningIdentity(signingIdentity);
logger.info(`Coordinator signing identity: ${signingIdentity.publicKeyHex}`);
```

Import `loadOrCreateIdentity` from `drone-swarm-common`. Import `setSigningIdentity` from `./signing-identity.js`.

Dep: A3.

**A5 — Tests for the helpers. Agent: tester.**
Files: `drone-swarm-common/test/pre-approval.test.ts` (new), `drone-swarm-common/test/coordinator-trust.test.ts` (new).

- `buildTokenSignaturePayload` and `buildRedemptionSignaturePayload` return the expected strings.
- A token that is signed by `generateBurnKey`'s counterpart verifies. A token with a changed field fails.
- `saveCoordinatorTrust` then `loadCoordinatorTrust` round-trips. A missing file returns `undefined`. The file mode is `0600`.

Dep: A1, A2.

### Phase B — Coordinator token store

**B1 — Add the table. Agent: coder.**
File: `drone-coordinator/src/db/init.ts`. Add the `CREATE TABLE IF NOT EXISTS pre_approval_tokens` statement from section 4.5.

Dep: none.

**B2 — Add the token accessors. Agent: coder.**
File: `drone-coordinator/src/db/pre-approval-tokens.ts` (new). Re-export from `drone-coordinator/src/db/index.ts`.

```ts
import { getDatabase } from './init.js';

export interface PreApprovalTokenRow {
  durableId: string;
  burnPublicKey: string;
  label: string | null;
  issuedAt: number;
  expiresAt: number;
  burnedAt: number | null;
  burnedBy: string | null;
}

export function createPreApprovalToken(row: {
  durableId: string;
  burnPublicKey: string;
  label: string | null;
  issuedAt: number;
  expiresAt: number;
}): PreApprovalTokenRow;

export function getPreApprovalToken(
  durableId: string
): PreApprovalTokenRow | undefined;

export function listPreApprovalTokens(): PreApprovalTokenRow[];

export function deletePreApprovalToken(durableId: string): boolean;

export function burnPreApprovalToken(
  durableId: string,
  burnedBy: string,
  burnedAt: number
): boolean;
```

`burnPreApprovalToken` must be one conditional update. This makes a double redemption safe.

```ts
const result = getDatabase()
  .prepare(
    'UPDATE pre_approval_tokens SET burned_at = ?, burned_by = ? WHERE durable_id = ? AND burned_at IS NULL'
  )
  .run(burnedAt, burnedBy, durableId);
return result.changes > 0;
```

Follow the `db/beacons.ts` accessor pattern: one `rowToPreApprovalToken(row)` mapper, inline prepared statements.

Dep: B1.

**B3 — Add `getBeaconTrustByPublicKey`. Agent: coder.**
File: `drone-coordinator/src/db/beacon-trust.ts`.

```ts
export function getBeaconTrustByPublicKey(
  publicKey: string
): BeaconTrust | undefined {
  const row = getDatabase()
    .prepare('SELECT * FROM beacon_trust WHERE public_key = ?')
    .get(publicKey) as BeaconTrustRow | undefined;
  return row ? rowToBeaconTrust(row) : undefined;
}
```

Dep: none.

**B4 — Tests for the token store. Agent: tester.**
File: `drone-coordinator/test/db/pre-approval-tokens.test.ts` (new).

- Create, get, list, delete.
- `burnPreApprovalToken` returns true once, then false.
- Two parallel burns: exactly one returns true.
- `getBeaconTrustByPublicKey` finds the row and returns `undefined` for a miss.

Dep: B2, B3.

### Phase C — Redemption route

**C1 — Add the redemption route. Agent: coder.**
File: `drone-coordinator/src/routes/pre-approval-tokens.ts` (new). Mount it in `drone-coordinator/src/routes/index.ts` under `/api`.

Handler for `POST /beacons/trust/redeem`:

```ts
const { durableId, clientKey, pubKey, sig } = request.body;
if (!durableId || !clientKey || !pubKey || !sig) {
  return reply
    .code(400)
    .send({ error: 'Invalid redemption request', code: 'INVALID_REQUEST' });
}
const token = db.getPreApprovalToken(durableId);
if (!token)
  return reply
    .code(404)
    .send({ error: 'Unknown token', code: 'TOKEN_NOT_FOUND' });
if (token.expiresAt < Date.now()) {
  return reply
    .code(410)
    .send({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
}
const payload = buildRedemptionSignaturePayload({
  durableId,
  clientKey,
  pubKey,
});
if (!verifyBeaconSignature(token.burnPublicKey, payload, sig)) {
  return reply
    .code(400)
    .send({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
}
const trust = db.getBeaconTrustByPublicKey(clientKey);
if (!trust) {
  return reply
    .code(404)
    .send({ error: 'Client is not registered', code: 'CLIENT_NOT_REGISTERED' });
}
if (!db.burnPreApprovalToken(durableId, trust.beaconId, Date.now())) {
  return reply
    .code(409)
    .send({ error: 'Token already used', code: 'TOKEN_ALREADY_BURNED' });
}
db.confirmBeaconFingerprint(trust.beaconId);
db.approveBeaconById(trust.beaconId);
publishMutationEvent({
  eventType: 'beacon.approved',
  payload: { beaconId: trust.beaconId },
});
return reply.code(200).send({ status: 'approved', beaconId: trust.beaconId });
```

Note: `approveBeaconById` requires `status='pending'` and `fingerprint_confirmed_at IS NOT NULL`. `confirmBeaconFingerprint` sets the timestamp first. If the row is already approved, `approveBeaconById` returns null. Treat this as success.

Dep: A1, B2, B3.

**C2 — Exempt the redemption route from mTLS. Agent: coder.**
File: `drone-coordinator/src/mtls.ts`. In `createMtlsMiddleware`, add the route to the bootstrap exemption list:

```ts
(req.method === 'POST' && req.url === '/api/beacons/trust/redeem') ||
```

This is necessary. A pending remote node must reach this route. The route currently matches no exemption and would answer `403`.

Dep: none.

**C3 — Tests for the redemption route. Agent: tester.**
File: `drone-coordinator/test/routes/pre-approval-tokens.test.ts` (new).

- A valid redemption approves the node and sets `fingerprintConfirmed`.
- `TOKEN_NOT_FOUND`, `TOKEN_EXPIRED`, `INVALID_SIGNATURE`, `CLIENT_NOT_REGISTERED`, `TOKEN_ALREADY_BURNED`.
- A second redemption of the same token answers `409`.
- The route is reachable without a client certificate.

Dep: C1, C2.

### Phase D — Coordinator mint routes

**D1 — Add the mint, list, and revoke routes. Agent: coder.**
File: `drone-coordinator/src/routes/pre-approval-tokens.ts`. Mount under `/api`.

```ts
const identity = getSigningIdentity();
if (!identity) {
  return reply
    .code(500)
    .send({ error: 'Coordinator signing identity is not available' });
}
const durableId = randomUUID();
const burn = generateBurnKey();
const issuedAt = Date.now();
const expiresAt = issuedAt + PRE_APPROVAL_TOKEN_TTL_MS;
const base = {
  durableId,
  pubKey: identity.publicKey,
  tlsFingerprint: getCoordinatorFingerprint() ?? '',
  burnKey: burn.privateKeyPem,
};
const token: PreApprovalToken = {
  ...base,
  sig: signBeaconPayload(
    identity.privateKeyPem,
    buildTokenSignaturePayload(base)
  ),
};
db.createPreApprovalToken({
  durableId,
  burnPublicKey: burn.publicKey,
  label: request.body?.label ?? null,
  issuedAt,
  expiresAt,
});
return reply.code(201).send({
  token,
  entry: {
    durableId,
    label: request.body?.label ?? null,
    issuedAt,
    expiresAt,
    burnedAt: null,
    burnedBy: null,
  },
});
```

`GET /pre-approval-tokens` returns `db.listPreApprovalTokens()` without `burnPublicKey`.
`DELETE /pre-approval-tokens/:durableId` returns `{ revoked: true }` or `404`.

Dep: A1, A3, B2.

**D2 — Tests for the mint routes. Agent: tester.**
File: `drone-coordinator/test/routes/pre-approval-tokens.test.ts`.

- Mint returns a token. The token verifies with `verifyPreApprovalToken`.
- The list omits `burnPublicKey`.
- Revoke deletes the row. A later redemption answers `404`.
- Mint without a signing identity answers `500`.

Dep: D1.

### Phase E — Node SDK

**E1 — Add fingerprint pinning to `createExtensionNode`. Agent: coder.**
File: `drone-swarm-common/src/extension-server.ts`.

- Add `expectedCoordinatorFingerprint?: string` to `CreateExtensionNodeOptions`.
- Resolve the pin:

```ts
const pinnedFingerprint =
  opts.expectedCoordinatorFingerprint ??
  (await loadCoordinatorTrust(opts.dataDir))?.tlsFingerprint;
```

- Pass `pinnedFingerprint` as the second argument to `createCoordinatorFetch`. It is currently `undefined`.
- For the WebSocket, when the URL is `https:` and a pin exists, check the peer certificate on the `upgrade` event:

```ts
ws.on('upgrade', res => {
  const socket = res.socket as unknown as {
    getPeerCertificate?: () => { fingerprint256?: string } | false;
    destroy?: () => void;
  };
  const cert = socket.getPeerCertificate?.();
  const fp =
    cert && typeof cert !== 'boolean'
      ? cert.fingerprint256?.replace(/:/g, '').toLowerCase()
      : undefined;
  if (pinnedFingerprint && fp && fp !== pinnedFingerprint) {
    socket.destroy?.();
    logger.warn(`Coordinator TLS fingerprint mismatch; refusing socket`);
  }
});
```

Dep: A2.

**E2 — Add the redemption helper. Agent: coder.**
File: `drone-swarm-common/src/pre-approval-redeem.ts` (new). Add the barrel export.

```ts
export interface RedeemPreApprovalTokenOptions {
  coordinatorUrl: string;
  dataDir: string;
  id: string;
  name: string;
  tokenPath: string;
}

export async function redeemPreApprovalToken(
  opts: RedeemPreApprovalTokenOptions
): Promise<void> {
  const raw = await readFile(opts.tokenPath, 'utf8');
  const token = JSON.parse(raw) as PreApprovalToken;
  if (!verifyPreApprovalToken(token)) {
    throw new Error('Pre-approval token signature is invalid');
  }
  const identity = await loadOrCreateIdentity(
    opts.id,
    opts.dataDir,
    'node-identity.json'
  );
  const tlsIdentity = await loadOrCreateTlsIdentity(opts.dataDir, 'node');
  const cfetch = createCoordinatorFetch(
    opts.coordinatorUrl,
    token.tlsFingerprint,
    undefined,
    tlsIdentity
  );
  const register = await cfetch(`${opts.coordinatorUrl}/api/beacons`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: opts.id,
      name: opts.name,
      host: '127.0.0.1',
      publicKey: identity.publicKey,
      tlsFingerprint: tlsIdentity.fingerprint,
      fingerprintConfirmed: false,
      extension: { protocolVersion: EXTENSION_PROTOCOL_VERSION },
    }),
  });
  if (!register.ok) {
    throw new Error(
      `Registration failed: ${register.status} ${await register.text()}`
    );
  }
  const redemption = {
    durableId: token.durableId,
    clientKey: identity.publicKey,
    pubKey: token.pubKey,
  };
  const redeem = await cfetch(
    `${opts.coordinatorUrl}/api/beacons/trust/redeem`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...redemption,
        sig: signBeaconPayload(
          token.burnKey,
          buildRedemptionSignaturePayload(redemption)
        ),
      }),
    }
  );
  if (!redeem.ok) {
    throw new Error(
      `Redemption failed: ${redeem.status} ${await redeem.text()}`
    );
  }
  await saveCoordinatorTrust(opts.dataDir, {
    coordinatorUrl: opts.coordinatorUrl,
    tlsFingerprint: token.tlsFingerprint,
  });
}
```

Dep: A1, A2, E1.

**E3 — Tests. Agent: tester.**
File: `drone-swarm-common/test/pre-approval-redeem.test.ts` (new).

- A valid token registers, redeems, and writes the trust file.
- An invalid token signature throws before any network call.
- A failed registration throws.

Dep: E2.

### Phase F — Binaries

**F1 — Add the flag to `mcp-swarm`. Agent: coder.**
File: `mcp-swarm/src/index.ts`.

- Add `preApprovalTokenPath?: string` to `McpSwarmConfig`.
- Add a small parse of `process.argv` for `--pre-approval-token-path` that accepts both `=value` and ` value`.
- In `main()`:

```ts
if (config.preApprovalTokenPath) {
  await redeemPreApprovalToken({
    coordinatorUrl: config.coordinatorUrl,
    dataDir: config.dataDir,
    id: config.id,
    name: config.id,
    tokenPath: config.preApprovalTokenPath,
  });
  console.log('Pre-approval complete. Exiting.');
  return;
}
await startMcpSwarm();
```

Wrap the call in `try`/`catch`. Log the error and `process.exit(1)` on failure.

Dep: E2.

**F2 — Add the flag to `drone-gateway`. Agent: coder.**
File: `drone-gateway/src/index.ts` (`parseArgs`) and the serve path.

- Add `preApprovalTokenPath` to `CliConfig`.
- Parse `--pre-approval-token-path` (both forms).
- Before starting the daemon, if the flag is set, call `redeemPreApprovalToken` with the gateway's extension node id, name, dataDir, and coordinator URL. Then `process.exit(0)`.
- Get the node id, name, dataDir, and URL from the existing `resolveSwarmExtension` result.

Dep: E2.

**F3 — Tests. Agent: tester.**
Files: `mcp-swarm/test/cli.test.ts` (new), `drone-gateway/test/cli.test.ts` (update or new).

- Both flag forms parse to the same path.
- The flag is absent by default.
- With the flag, the binary calls the helper and exits (mock the helper).

Dep: F1, F2.

### Phase G — Coordinator UI

**G1 — Add the types. Agent: coder.**
File: `drone-coordinator-ui/src/lib/types.ts`.

```ts
export interface PreApprovalToken {
  durableId: string;
  pubKey: string;
  tlsFingerprint: string;
  burnKey: string;
  sig: string;
}

export interface PreApprovalTokenEntry {
  durableId: string;
  label: string | null;
  issuedAt: number;
  expiresAt: number;
  burnedAt: number | null;
  burnedBy: string | null;
}
```

Dep: none.

**G2 — Add copy and download helpers. Agent: coder.**
File: `drone-coordinator-ui/src/lib/download.ts` (new).

```ts
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
```

Dep: none.

**G3 — Add the page. Agent: coder.**
File: `drone-coordinator-ui/src/pages/pre-approval-tokens.tsx` (new).

- Load the list with `GET /api/pre-approval-tokens`.
- A create form with an optional label. On submit, `POST /api/pre-approval-tokens`.
- Show the returned token one time. Use a monospace box. Add a Copy button and a Download button.
- Show a warning: "This token is a sensitive credential. Store it securely. It is shown one time only."
- A table of tokens: label, durableId, issued, expires, status (unused / burned / expired). Each row has a Revoke button (`DELETE`).
- Use `useAuthenticatedFetch`. Use `extractApiError` and `useToast().error` for errors.

Dep: G1, G2.

**G4 — Register the route and add the Topology link. Agent: coder.**
Files: `drone-coordinator-ui/src/App.tsx`, `drone-coordinator-ui/src/pages/topology.tsx`.

- Add `<Route path="/pre-approval-tokens" element={<PreApprovalTokensPage />} />` to the route table. Do **not** add a `navItems` entry.
- Add a link or button on the Topology page near the trust actions: "Pre-approval tokens" → `/pre-approval-tokens`.

Dep: G3.

**G5 — Tests. Agent: tester.**
File: `drone-coordinator-ui/src/pages/pre-approval-tokens.test.tsx` (new).

- The page renders the list.
- A create action shows the token box and the warning.
- The Copy button calls the clipboard.
- The route renders without a nav item.
- Poll for rendered content. Do not use fixed ticks.

Dep: G3, G4.

### Phase H — Docs and ADR

**H1 — Write ADR 258. Agent: docs.**
File: `docs/adr/258-pre-approval-tokens.md` (new). Record the decisions in section 3. Include the token schema, the redemption schema, the signature payloads, the routes, the table, and the error codes. Add a pointer stub in the project wiki `decisions/` folder.

**H2 — Update the extension docs. Agent: docs.**
File: `docs/agents/swarm-extensions.md`. Add a "Pre-approval tokens" section: the flag, the one-shot behavior, the trust file, and the pinning.

**H3 — Update the READMEs. Agent: docs.**
Files: `mcp-swarm/README.md`, `drone-gateway/README.md`. Document the flag and the token file. Add a security note: the token is a sensitive credential.

**H4 — Update the project wiki and memory. Agent: docs.**
Update the extension pages. Add the outcome note to this plan memory.

Dep: C, D, E, F, G.

### Phase Z — Final check

**Z — Check the work against the validation criteria. Agent: reviewer.**
Run every item in section 7. Fix until all pass. Do not close the plan until LSP, build, typecheck, lint, and the fast tests are green.

## 6. Order and dependencies

- A1, A2, A3, B1, B3 can start at the same time.
- A4 needs A3. A5 needs A1 and A2.
- B2 needs B1. B4 needs B2 and B3.
- C1 needs A1, B2, B3. C2 is independent. C3 needs C1 and C2.
- D1 needs A1, A3, B2. D2 needs D1.
- E1 needs A2. E2 needs A1, A2, E1. E3 needs E2.
- F1 and F2 need E2. F3 needs F1 and F2.
- G1, G2 are independent. G3 needs G1 and G2. G4 needs G3. G5 needs G3 and G4.
- H follows C, D, E, F, G.
- Z is last.

Recommended order: A → B → C → D → E → F → G → H → Z.

## 7. Validation criteria

1. **LSP**: `lsp__get_diagnostics` shows zero errors and zero warnings for the whole workspace, tests included. Run it after every phase.
2. **Build**: `pnpm -r run build` passes with zero errors. Run it after every `drone-core`, `drone-swarm-common`, or `drone-extension-ui-types` change.
3. **Typecheck**: `pnpm typecheck` passes.
4. **Lint**: `pnpm run lint` passes with zero errors. This is the project lint process. Prettier rewrites files. Read every file again before the next change.
5. **Fast tests**: `pnpm run test` passes. All suites are green.
6. **New tests exist** for: the crypto and trust helpers (A5), the token store and `getBeaconTrustByPublicKey` (B4), the redemption route and the mTLS exemption (C3), the mint routes (D2), the redemption helper (E3), the CLI flags (F3), and the UI page (G5).
7. **Acceptance** (manual walk-through):
   1. Start the coordinator on a non-loopback address. Confirm the signing identity is created.
   2. In the UI, open the Topology page. Follow the link to the token page. Mint a token with a label. The UI shows the token one time and shows the warning.
   3. Download the token file.
   4. Point `mcp-swarm` at the coordinator's non-loopback address. Run it with `--pre-approval-token-path`. It registers, redeems, writes `coordinator-trust.json`, and exits 0.
   5. Confirm the node is `approved` and `fingerprintConfirmed: true` in the UI.
   6. Run the same token again. It answers `TOKEN_ALREADY_BURNED` and exits 1.
   7. Run `mcp-swarm` without the flag. It connects as approved. Confirm no TOFU prompt and no manual approval.
   8. Mint a second token. Revoke it. A redemption answers `TOKEN_NOT_FOUND`.
8. **No dead code, no fluff comments, no duplicate logic.** Files stay under 750 lines.
9. **ADR 258** exists. The docs and READMEs are updated. The project memory holds this plan with an outcome note.

## 8. Deferred

- Token use by `drone-beacon`.
- Token lifetime configuration.
- Per-token permissions or scopes.
- A CLI mint command.
- Bundle signature verification.
- The full remote-extension feature (this plan covers only the approval path).

## Outcome

Executed 2026-10-20 on branch `feat/pre-approval-tokens` (two commits: `d13ba3f4` phases A–E, `1a9aeea8` phases F–H). All phases A–H done; Phase Z green.

**Plan gap (deviation):** the plan said "create the branch off `main`", but the feature depends on the swarm-extension infrastructure (`mcp-swarm`, `createExtensionNode`, the gateway extension node, ADR 254/256/257) that exists only on `feat/swarm-extensions`, not on `main`. Branched off `feat/swarm-extensions` instead.

**Delivered:**

- A — `drone-swarm-common/src/pre-approval.ts` (token + redemption signature payloads, `verifyPreApprovalToken`, `generateBurnKey`, `PRE_APPROVAL_TOKEN_TTL_MS`) and `coordinator-trust.ts` (`save`/`loadCoordinatorTrust`); `drone-coordinator/src/signing-identity.ts` + startup load of `coordinator-identity.json`.
- B — `pre_approval_tokens` table + `drone-coordinator/src/db/pre-approval-tokens.ts` accessors (race-safe `burnPreApprovalToken`); `getBeaconTrustByPublicKey`.
- C/D — `drone-coordinator/src/routes/pre-approval-tokens.ts`: `POST /api/beacons/trust/redeem` (mTLS-exempt), mint/list/revoke; mounted under `/api`.
- E — `createExtensionNode` fingerprint pinning (`expectedCoordinatorFingerprint` + trust-file fallback + WS peer-cert check); `drone-swarm-common/src/pre-approval-redeem.ts` helper.
- F — `--pre-approval-token-path` (both `=` and space forms) on `mcp-swarm` and `drone-gateway`, one-shot redeem-then-exit.
- G — coordinator UI page `/pre-approval-tokens` (create + one-time display + copy/download + warning + revoke), Topology link, **no** nav item; `lib/download.ts`.
- H — ADR 258 + `docs/adr/index.md` + wiki pointer stub; `docs/agents/swarm-extensions.md` "Pre-approval tokens" section; `mcp-swarm/README.md`; `drone-gateway/CONTEXT.md` (the gateway has **no** README — documented the flag in the glossary instead); wiki module pages (`drone-coordinator`, `drone-swarm-common`, `drone-coordinator-ui`, `mcp-swarm`, `drone-gateway`).

**Validation:** LSP clean; `pnpm -r run build` 0 errors; `pnpm typecheck` 0; `pnpm run lint` 0; `pnpm run test` 4289 passed / 16 skipped. New tests: 8 (crypto/trust), 7 (token store), 12 (routes), 5 (redeem helper), 14 (CLI), 5 (UI).

**Notes for the record:** the UI test env needs `NODE_ENV=test` (the package's own `test` script sets it — `React.act is not a function` otherwise); the plan's `apply_diff` snippets omit hunk headers, so every diff needed a `@@` header added.
