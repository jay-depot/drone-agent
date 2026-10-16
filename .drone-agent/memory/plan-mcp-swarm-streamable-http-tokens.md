---
key: plan-mcp-swarm-streamable-http-tokens
tags:
  - plan
  - mcp-swarm
  - extension
  - streamable-http
  - auth-token
  - coordinator-ui
  - swarm
created: 2026-10-16T19:20:11.749Z
updated: 2026-10-16T19:20:11.749Z
---

# Plan: mcp-swarm — streamable HTTP transport + auth tokens

**Status**: ready for execution. Next ADR number = **255**.

## 1. Summary

`mcp-swarm` is the reference swarm extension. Today it runs as a stdio MCP server. Each MCP client starts its own copy. All copies register to the coordinator with the same node id. There is no place to hold settings, because each copy is short-lived.

This change makes `mcp-swarm` a long-running HTTP daemon. The daemon serves MCP over **streamable HTTP**. It also serves a **settings panel** to the coordinator UI. The panel manages **auth tokens**. The tokens let an MCP client connect. The tokens also stop a different person on the same tailnet from using your swarm.

Why:
- One process, not many processes. The coordinator sees one node.
- A long-running process can hold state (tokens) and serve a UI panel.
- Tokens give per-client access and per-client revocation.

## 2. Scope

### 2.1 In scope
- Replace the stdio transport with a stateless streamable-HTTP transport.
- Add a named-token store in `mcp-swarm`.
- Add `token.list`, `token.create`, `token.revoke`, `token.rename` capabilities (UI only).
- Rework the embedded UI bundle: a settings panel (token table) plus the existing status panel.
- Add shared crypto helpers in `drone-swarm-common`. Harden the coordinator web-token compare. Unify the LSP installer compare.
- Add `api.fetch` to the extension UI contract, so bundles can call the coordinator with the web token.
- Update docs and write ADR 255.

### 2.2 Out of scope (deferred)
- TLS termination inside `mcp-swarm`.
- Per-token permissions or scopes. All tokens have full power.
- Token expiry.
- Server-sent events, session ids, resumability, `notifications/tools/list_changed`.
- Remote (non-tailnet) access, and the pre-approval-token flow from ADR 254.

## 3. Locked decisions

| # | Decision |
|---|---|
| D1 | The token authenticates **MCP clients** against the `mcp-swarm` HTTP endpoint. The swarm-node identity stays mTLS. |
| D2 | **Many named tokens.** Each entry has `id`, `name`, `createdAt`, `lastUsedAt?`, `hash`. The store keeps **only the SHA-256 hash**. The plaintext shows **one time**, at creation. |
| D3 | Token format is `mcpsw_` + 32 random bytes as hex. Clients send `Authorization: Bearer mcpsw_…`. |
| D4 | The store bootstraps: if it is empty on the first run, it makes one token named `default`. It prints the token one time and writes it to a `0600` file in the data dir. |
| D5 | **Stateless transport.** `POST /mcp` answers `application/json`. No `Mcp-Session-Id`. `GET /mcp` answers **405**. `DELETE /mcp` answers **204**. Notifications answer **202** with no body. |
| D6 | Auth runs on every POST. A bad token answers **401** before JSON-RPC parse. |
| D7 | Default bind is `127.0.0.1:3460`. Env `MCP_SWARM_HOST` and `MCP_SWARM_PORT` change it. Plain HTTP on loopback. Docs recommend a private tailnet for wider access. |
| D8 | **Delete the stdio transport.** One transport only. |
| D9 | The capability catalog has two tiers: `mcp` and `ui`. `mcp` tools are visible to MCP clients. `ui` tools are for the coordinator UI only. |
| D10 | `token.*` is **UI only**. The MCP server keeps them out of `tools/list` and rejects them in `tools/call`. The coordinator also rejects them on the tool route. |
| D11 | The UI is **in scope**. The bundle keeps the `topology-page` status panel and adds a `settings-panel` token table. |
| D12 | Token management flows through the coordinator action route. No new coordinator surface. |
| D13 | Crypto helpers live in `drone-swarm-common`. The coordinator web-auth compare becomes constant time. The LSP installer uses the same helper. |
| D14 | Use `node:http`. No new dependency. |

## 4. Interfaces

### 4.1 HTTP MCP endpoint

| Method | Path | Auth | Answer |
|---|---|---|---|
| POST | `/mcp` | Bearer token | 200 + JSON-RPC result; 401 bad token; 400 bad JSON |
| GET | `/mcp` | Bearer token | 405 (no stream) |
| DELETE | `/mcp` | Bearer token | 204 |
| any | other | none | 404 |

`initialize` returns `protocolVersion: '2025-06-18'`, `capabilities: { tools: {} }`, `serverInfo: { name: 'mcp-swarm', version: '0.1.0' }`.

### 4.2 Capability catalog

| Capability | Tier | Action |
|---|---|---|
| `swarm.session.list` | mcp | coordinator `GET /api/sessions` |
| `swarm.wiki.read` | mcp | coordinator `GET /api/wiki/:pageId` |
| `swarm.agent.list` | mcp | coordinator `GET /api/agents/location` |
| `token.list` | ui | local handler |
| `token.create` | ui | local handler |
| `token.revoke` | ui | local handler |
| `token.rename` | ui | local handler |

Param schemas: `token.list` takes nothing. `token.create` takes `{name}`. `token.revoke` takes `{id}`. `token.rename` takes `{id, name}`.

Bodies: `token.list` → `{tokens:[{id,name,createdAt,lastUsedAt?}]}`. `token.create` → `{token:'mcpsw_…', entry:{id,name,createdAt}}`. `token.revoke` → `{revoked:true,id}`. `token.rename` → `{entry:{…}}`.

### 4.3 Token store file

Path: `<dataDir>/tokens.json`, mode `0600`.

```json
{ "version": 1, "tokens": [ { "id": "t_…", "name": "work-laptop", "createdAt": 0, "lastUsedAt": 0, "hash": "<sha256 hex>" } ] }
```

Bootstrap plaintext file: `<dataDir>/token`, mode `0600`.

### 4.4 Env vars

| Var | Default | Purpose |
|---|---|---|
| `MCP_SWARM_COORDINATOR_URL` | `http://127.0.0.1:3456` | Coordinator |
| `MCP_SWARM_DATA_DIR` | `~/.drone-agent/mcp-swarm` | identity, TLS, token store |
| `MCP_SWARM_ID` | `mcp-swarm` | node id |
| `MCP_SWARM_HOST` | `127.0.0.1` | HTTP bind host |
| `MCP_SWARM_PORT` | `3460` | HTTP bind port |

## 5. Steps

### Phase A — Shared crypto and lock

**A1 — Move the keyed lock to `drone-swarm-common`. Agent: coder.**
Files: `drone-swarm-common/src/keyed-lock.ts` (new), `drone-swarm-common/src/index.ts`, `drone-agent/src/shared/keyed-lock.ts`.
- Move the body of `drone-agent/src/shared/keyed-lock.ts` to `drone-swarm-common/src/keyed-lock.ts`.
- Add `export * from './keyed-lock.js';` to the `drone-swarm-common/src/index.ts` barrel.
- Replace `drone-agent/src/shared/keyed-lock.ts` with a re-export shim:
```ts
export { withKeyLock, withPathLock } from 'drone-swarm-common';
```
- Keep every current import path working. Do not change `file.ts`, `server-description.ts`, or the tests.
Dep: none.

**A2 — Add the token crypto helpers. Agent: coder.**
File: `drone-swarm-common/src/token-crypto.ts` (new); barrel export.
```ts
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export function generateToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('hex')}`;
}

export function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyToken(plain: string, expectedHash: string): boolean {
  return timingSafeEqualStrings(hashToken(plain), expectedHash);
}
```
Dep: none.

**A3 — Use the shared compare in the LSP installer. Agent: coder.**
File: `drone-agent/src/plugins/lsp/installer.ts`.
- Delete the private `timingSafeEqualStrings`.
- Import it from `drone-swarm-common`.
Dep: A2.

**A4 — Harden the coordinator web-token compare. Agent: coder.**
File: `drone-coordinator/src/web-auth.ts`.
- Import `timingSafeEqualStrings` from `drone-swarm-common`.
- Replace `if (headerToken !== token)` with:
```ts
if (!headerToken || !timingSafeEqualStrings(headerToken, token)) {
```
Dep: A2.

**A5 — Tests for the crypto helpers. Agent: tester.**
File: `drone-swarm-common/test/token-crypto.test.ts` (new).
- `generateToken` has the prefix and the correct length.
- `hashToken` is stable; two different plaintexts give two different hashes.
- `verifyToken` accepts the match and rejects a mismatch.
- `timingSafeEqualStrings` handles equal, unequal, and different-length inputs.
- Extend `drone-coordinator/test/auth.test.ts`: a wrong token still answers 401.
Dep: A1–A4.

**A6 — Review the shared helpers. Agent: reviewer.**
Check: no duplicate compare remains; the barrel exports resolve; the coordinator behavior is unchanged for a good token.
Dep: A5.

### Phase B — Token store (mcp-swarm)

**B1 — Add the token store. Agent: coder.**
File: `mcp-swarm/src/token-store.ts` (new).
```ts
export interface TokenEntry { id: string; name: string; createdAt: number; lastUsedAt?: number; hash: string; }
export interface TokenStore {
  list(): Omit<TokenEntry, 'hash'>[];
  create(name: string): { entry: Omit<TokenEntry, 'hash'>; token: string };
  revoke(id: string): boolean;
  rename(id: string, name: string): Omit<TokenEntry, 'hash'> | undefined;
  verify(plain: string): Omit<TokenEntry, 'hash'> | undefined;
  flush(): Promise<void>;
}
export async function loadTokenStore(dataDir: string): Promise<TokenStore>;
```
Rules:
- The in-memory array is the source of truth. A `Map<hash, id>` index serves `verify`.
- `verify` hashes the plaintext, finds the entry, then compares with `verifyToken` for constant time. On a hit it sets `lastUsedAt` in memory.
- Writes use `withPathLock(path)` plus a temp file and a rename.
- `lastUsedAt` flushes at most one time per 30 s. `flush()` writes at once.
- On load with an empty or missing file: make one token named `default`, print it one time, and write `<dataDir>/token` with mode `0600`.
- `list()` never returns `hash`.
Dep: A1, A2.

**B2 — Tests for the token store. Agent: tester.**
File: `mcp-swarm/test/token-store.test.ts` (new).
- Create, list, rename, revoke.
- The plaintext is absent from `tokens.json`; the file holds a hash.
- `verify` accepts and rejects.
- The bootstrap writes one `default` token and a `0600` file.
- Two parallel writes do not corrupt the file.
- `lastUsedAt` updates after a successful verify.
Dep: B1.

### Phase C — HTTP MCP server

**C1 — Add the HTTP server. Agent: coder.**
File: `mcp-swarm/src/http-server.ts` (new).
```ts
export interface McpHttpServerOptions {
  capabilities: DroneExtensionCapability[];
  invoke: (capability: string, params: Record<string, unknown>) => Promise<InvokeResult>;
  verify: (token: string) => boolean;
  host: string;
  port: number;
}
export function startMcpHttpServer(opts: McpHttpServerOptions): Promise<{ port: number; close: () => Promise<void> }>;
```
Rules:
- Use `node:http`.
- Read the body with a 1 MiB cap. Answer 413 when it is too large.
- Check `Authorization: Bearer`. Answer 401 on a bad or missing token.
- Parse JSON-RPC and call `handleRequest`.
- A request with an `id` answers 200 and the JSON response.
- A request without an `id` (a notification) answers 202 with no body.
- `GET /mcp` answers 405. `DELETE /mcp` answers 204. Other paths answer 404.
- Support `port: 0` for tests and return the real port.
Dep: none.

**C2 — Cut the stdio transport and add tier filtering. Agent: coder.**
File: `mcp-swarm/src/mcp-server.ts`.
- Delete `startMcpStdioServer`, `frame`, and the Content-Length parser. Keep `handleRequest`.
- `tools/list` returns only capabilities with `exposed !== 'ui'`.
- `tools/call` answers a JSON-RPC error for a `ui` capability.
Dep: C1.

**C3 — Add the tier field and the token capabilities. Agent: coder.**
Files: `drone-core/src/extension-types.ts`, `mcp-swarm/src/mapping.ts`.
- Add `exposed?: 'mcp' | 'ui'` to `DroneExtensionCapability`. Default is `mcp`.
- Add `exposed` to `CapabilityMapping`. `CAPABILITY_MAPPINGS` keeps the three read tools at `mcp`.
- Add the four `token.*` capabilities at `ui`.
- Add helpers: `mcpExposedCapabilities()` and `isMcpExposed(name)`.
Dep: none.

**C4 — Enforce the tier in the coordinator. Agent: coder.**
File: `drone-coordinator/src/routes/extensions.ts`.
- In `invoke(...)`, when `caller === 'agent'` and `cap.exposed === 'ui'`, answer 403 `{error:'Capability is not agent-callable', code:'CAPABILITY_NOT_AGENT_CALLABLE'}`.
Dep: C3.

**C5 — Wire the new server. Agent: coder.**
File: `mcp-swarm/src/index.ts`.
- `resolveConfig` gains `host` and `port`.
- `startMcpSwarm` loads the token store, starts the HTTP server, and keeps the extension node.
- `onInvokeAction` and `onInvokeTool`: a `token.*` capability runs a local handler against the token store. The three read tools still run through `createInvoker`.
- `stop` closes the server, flushes the store, and stops the node.
Dep: B1, C1, C2, C3.

**C6 — Tests for the transport and the handlers. Agent: tester.**
Files: `mcp-swarm/test/http-server.test.ts` (new), `mcp-swarm/test/mapping.test.ts` (update).
- `POST /mcp` `initialize` and `tools/list` work.
- No token and a bad token answer 401.
- `GET` answers 405. `DELETE` answers 204. A notification answers 202.
- `tools/list` omits `token.*`. `tools/call` for `token.create` fails.
- `token.create` then `token.list` then `token.revoke` work over the action handler.
- Remove the stdio framing test.
Dep: C5.

### Phase D — UI

**D1 — Add `api.fetch` to the UI contract. Agent: coder.**
File: `drone-extension-ui-types/src/index.ts`.
```ts
export interface UIExtensionApi {
  registerComponent: (region: UIRegion, component: ComponentType) => () => void;
  registerRoute: (route: PluginClientRoute) => () => void;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}
```
Dep: none.

**D2 — Pass the fetch into the loader. Agent: coder.**
Files: `drone-coordinator-ui/src/extensions/loader.ts`, `drone-coordinator-ui/src/extensions/useExtensions.tsx`.
- `LoaderDeps` gains `fetch: (path: string, init?: RequestInit) => Promise<Response>`.
- `makeApi` includes `fetch`.
- `useExtensions` passes `fetch: (path, init) => authFetch(path, init)`.
Dep: D1.

**D3 — Rework the bundle. Agent: coder.**
File: `mcp-swarm/src/bundle.ts`.
- Keep the `topology-page` status panel.
- Add a `settings-panel` component. It shows a token table: name, created, last used, and a Revoke button. It has a Create control. The Create control shows the plaintext one time in a copy box.
- The component calls the coordinator through `api.fetch`, which the bundle captures in `onReady`.
Example:
```js
let api;
export default {
  regions: { 'settings-panel': SettingsPanel, 'topology-page': StatusPanel },
  onReady: function (next) { api = next; },
};
function SettingsPanel() {
  const React = globalThis.React;
  const [tokens, setTokens] = React.useState([]);
  const load = React.useCallback(function () {
    api.fetch('/api/extensions/mcp-swarm/actions/token.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: {} }),
    }).then(function (r) { return r.json(); })
      .then(function (b) { setTokens(b.body.tokens || []); });
  }, []);
  React.useEffect(load, [load]);
  return React.createElement('div', null, tokens.length + ' token(s)');
}
```
Dep: D1, D2, C3.

**D4 — Tests for the loader and the bundle. Agent: tester.**
Files: `drone-coordinator-ui/src/extensions/loader.test.ts` (update), `mcp-swarm/test/mapping.test.ts` (update).
- The loader passes `fetch` into `makeApi`.
- The bundle registers `settings-panel` and `topology-page`.
- The settings component references only `token.*` capabilities.
- Poll for rendered content. Do not use fixed ticks.
Dep: D3.

### Phase E — Docs and ADR

**E1 — Write ADR 255. Agent: docs.**
File: `docs/adr/255-mcp-swarm-http-transport-and-tokens.md` (new). Record D1–D14, the endpoint table, the tier rule, and the deferred items. Add a pointer stub in the project wiki `decisions/` folder.

**E2 — Update the README. Agent: docs.**
File: `mcp-swarm/README.md`. New usage: a client config with `"type": "http"`, the URL, and the Bearer header. Add the env table. Add the bootstrap note. Add a security note: keep it on loopback; if you must go wider, use a private tailnet only.

**E3 — Update the extension docs. Agent: docs.**
File: `docs/agents/swarm-extensions.md`. The reference implementation is no longer stdio. Note the two tiers and the token model.

**E4 — Update the project wiki and memory. Agent: docs.**
Update the wiki pages for the extension reference and the MCP surface. Add the outcome note to this plan memory.
Dep: C, D.

### Phase F — Acceptance

**F1 — Manual acceptance walk-through. Agent: tester.**
1. Start the coordinator and a beacon. Start `mcp-swarm`. It prints one `default` token and binds `127.0.0.1:3460`.
2. `curl -X POST http://127.0.0.1:3460/mcp -H 'Authorization: Bearer mcpsw_…' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'` returns `serverInfo`. The same request with no token returns 401.
3. `curl http://127.0.0.1:3460/mcp` returns 405.
4. In the coordinator UI, open `/settings`. The `mcp-swarm` section shows the token table. Create a token. The plaintext shows one time. Use it against `/mcp`. It works. Revoke it. It no longer works (401).
5. `GET /api/extensions` lists the node with all seven capabilities.
6. Two MCP clients use two different tokens at the same time. The coordinator still sees one node.
Dep: C, D.

### Final step

**Z — Check against the validation criteria. Agent: reviewer.**
Run every item in section 7. Fix until all pass. Do not close the plan before LSP, build, typecheck, lint, and the fast tests are green.

## 6. Order and dependencies

- A1, A2, C1, C3, and D1 can start at the same time.
- A3 and A4 need A2.
- B1 needs A1 and A2.
- C2 needs C1 and C3. C4 needs C3. C5 needs B1, C1, C2, and C3.
- D2 needs D1. D3 needs D1, D2, and C3.
- Tests follow their code.
- E follows C and D.
- Z is last.

Recommended order: A → B → C → D → E → Z.

## 7. Validation criteria

1. **LSP**: `lsp__get_diagnostics` shows zero errors and zero warnings for the whole workspace, tests included. Run it after every phase.
2. **Build**: `pnpm -r run build` passes with zero errors. Run it after every `drone-core` or `drone-swarm-common` type change.
3. **Typecheck**: `pnpm typecheck` passes.
4. **Lint**: `pnpm run lint` passes with zero errors. This is the project lint process. Prettier rewrites files, so read every file again before the next change.
5. **Fast tests**: `pnpm run test` passes. All suites are green.
6. **New tests exist** for: the crypto helpers (A5), the token store (B2), the HTTP transport and tier filtering (C6), and the loader `fetch` plus the bundle (D4).
7. **Acceptance**: the F1 walk-through works.
8. No dead code, no fluff comments, no duplicate logic. Files stay under 750 lines.
9. **ADR 255** exists. `mcp-swarm/README.md` and `docs/agents/swarm-extensions.md` are updated. The project memory holds this plan with an outcome note.

## 8. Deferred (explicitly out of scope)

- TLS termination inside `mcp-swarm`.
- Per-token permissions or scopes.
- Token expiry.
- Server-sent events, session ids, resumability, `notifications/tools/list_changed`.
- Remote (non-tailnet) access and the ADR 254 pre-approval-token flow.
- Replatforming the gateway onto the extension protocol; refactoring the beacon onto `createExtensionNode`.
