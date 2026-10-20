# 258. Pre-approval tokens for remote swarm nodes

- Status: Accepted
- Date: 2026-10-20

## Context

A remote node (a swarm extension or a beacon) that connects to the coordinator
over the primary mTLS port registers as `pending` and needs manual approval
(ADR [254](254-swarm-extensions.md), ADR
[257](257-extension-node-web-port-transport.md)). That approval path has two
gaps:

1. It is manual. A user must approve the node in the UI or on the command line.
2. The SDK never sends the signed `confirm-fingerprint` announce, so a remote
   node can never satisfy the approval gate. This is a hard deadlock.

A **pre-approval token** closes both gaps. The user mints a token in the
coordinator UI, gives the token file to the node, and runs the node once with
`--pre-approval-token-path`. The node registers, redeems the token, and exits.
The coordinator records the node as approved. A later start of the same node
connects without manual work.

The token is a **sensitive credential**. The token file is the trust anchor.

A token must carry a coordinator signature. The coordinator had no signing key:
its only cryptographic identity was an RSA-2048 TLS certificate. This decision
therefore first gives the coordinator a dedicated Ed25519 identity.

## Decision

**D1 — Coordinator signing identity.** The coordinator gets a dedicated
Ed25519 identity, loaded with
`loadOrCreateIdentity('coordinator', configDir, 'coordinator-identity.json')`
and held in a module (mirrors the `health.ts` fingerprint holder). Signatures
use `signBeaconPayload`. The token `pubKey` is the identity's base64 SPKI
public key. _Rejected:_ signing with the RSA TLS key.

**D2 — The token file is the trust anchor.** The node checks only the token's
self-signature against the embedded `pubKey`. The token is a sensitive
credential. The UI shows a warning.

**D3 — Burn key.** `burnKey` is an Ed25519 **private key as PKCS#8 PEM**. The
coordinator stores the public half (base64 SPKI) with the `durableId`. The token
carries only the private half.

**D4 — Redemption sequence.** The token run does a normal registration, then a
redemption. The redemption approves the trust row whose `public_key` equals
`clientKey`. `durableId` is the token database primary key. It is **not** the
node id.

**D5 — Redemption route.** A dedicated route `POST /api/beacons/trust/redeem`.
The body is `{durableId, clientKey, pubKey, sig}`. The route is mTLS-exempt and
needs no web token. The burn-key signature **is** the credential. The route is
exempted in `createMtlsMiddleware` next to `POST /api/beacons`.

**D6 — UI surface.** A dedicated page at `/pre-approval-tokens`. The Topology
page links to it. There is **no** nav item. The page has a list, a create form
(one-time display, copy, download, warning), and a revoke action.

**D7 — CLI flag.** The flag `--pre-approval-token-path` accepts both `=value`
and ` value` forms. No shared `=`-aware CLI parser exists, so each binary parses
the flag locally.

**D8 — Binaries.** The flag is added to `mcp-swarm` and `drone-gateway`. The
shared logic lives in one helper, `redeemPreApprovalToken`, in
`drone-swarm-common`. `drone-beacon` is deferred.

**D9 — Expiry and revoke.** The token expires 30 days after issue
(`PRE_APPROVAL_TOKEN_TTL_MS`, a hardcoded constant). The table has `issued_at`
and `expires_at` columns. Revoke deletes the row.

**D10 — Naming and table.** `durableId` (camelCase) everywhere. The table is
`pre_approval_tokens`.

**D11 — Signature payloads.** Signatures are `:`-joined in schema order. This
matches the existing `beaconId + ':' + timestamp` convention. Base64 and PEM
data contain no colon.

```
token sig payload      = durableId + ':' + pubKey + ':' + tlsFingerprint + ':' + burnKey
redemption sig payload = durableId + ':' + clientKey + ':' + pubKey
```

**D12 — Scope.** The token targets remote (non-loopback) nodes. A loopback node
is already auto-approved.

**D13 — Label.** An optional `label` lives in the database row and the UI only.
The token file stays at its fixed field set.

**D14 — Fingerprint confirmation.** The redemption treats the burn-key
verification **as** the fingerprint confirmation. It sets both
`status='approved'` and `fingerprint_confirmed_at`.

**D15 — TLS fingerprint pinning.** The token carries the coordinator's TLS
fingerprint. The node pins it. There is no TOFU.

**D16 — Persistent trust file.** The one-shot run writes
`{coordinatorUrl, tlsFingerprint}` to `<dataDir>/coordinator-trust.json` (mode
`0600`). `createExtensionNode` reads that file when it receives no explicit
fingerprint.

## Token file

```json
{
  "durableId": "3f2a…-uuid",
  "pubKey": "<coordinator Ed25519 public key, base64 SPKI>",
  "tlsFingerprint": "<coordinator TLS cert SHA-256, hex, no colons>",
  "burnKey": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
  "sig": "<base64 Ed25519 signature>"
}
```

## Redemption request

```json
{
  "durableId": "3f2a…-uuid",
  "clientKey": "<node Ed25519 public key, base64 SPKI>",
  "pubKey": "<coordinator Ed25519 public key, base64 SPKI>",
  "sig": "<base64 Ed25519 signature over the redemption payload>"
}
```

## HTTP routes

| Method   | Path                                  | Auth                  | Purpose                          |
| -------- | ------------------------------------- | --------------------- | -------------------------------- |
| `POST`   | `/api/beacons/trust/redeem`           | none (burn signature) | Redeem a token, approve the node |
| `POST`   | `/api/pre-approval-tokens`            | web token             | Mint a token                     |
| `GET`    | `/api/pre-approval-tokens`            | web token             | List tokens                      |
| `DELETE` | `/api/pre-approval-tokens/:durableId` | web token             | Revoke a token                   |

The mint response returns the full token object one time. The list response
returns the entries only; it never returns `burnKey` or `burn_public_key`.

## Database table

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

`burned_at` is null when the token is unused. Redemption harms a token with a
single conditional `UPDATE … WHERE burned_at IS NULL`, so a double redemption is
race-safe.

## Error codes

| Code | Name                    | Cause                                    |
| ---- | ----------------------- | ---------------------------------------- |
| 404  | `TOKEN_NOT_FOUND`       | No row with that `durableId`             |
| 410  | `TOKEN_EXPIRED`         | `expires_at` is in the past              |
| 409  | `TOKEN_ALREADY_BURNED`  | The row already has `burned_at`          |
| 400  | `INVALID_SIGNATURE`     | The redemption signature does not verify |
| 404  | `CLIENT_NOT_REGISTERED` | No trust row has that `public_key`       |

## Consequences

The coordinator gains a persistent Ed25519 identity file. A token is a bearer
credential: whoever holds the token file can approve one node within 30 days.
The burn-key signature binds the approval to the node's own identity, and the
pinning removes the TOFU window for the redemption call and later runs.

## Deferred

- Token use by `drone-beacon`.
- Token lifetime configuration.
- Per-token permissions or scopes.
- A CLI mint command.
- Bundle signature verification.
- The full remote-extension feature (this ADR covers only the approval path).
