---
key: mcp-fix-items-1-2-plan
tags:
  - mcp
  - plan
  - fix
  - session-id
  - isError
created: 2026-07-08T01:55:47.764Z
updated: 2026-07-08T01:55:47.764Z
---

# MCP Client Fix Plan — Items 1 & 2 (Session-Id + isError)

Created: 2026-07-07. Status: READY FOR EXECUTION (plan persona).

## What & Why

`drone-agent/src/plugins/mcp/client.ts` has two spec-compliance defects (see project memory `mcp-client-gaps`):

- **Item 1** — The streamable-HTTP transport (`createStreamableHttpJsonRpcClient`, ~client.ts:489-552) never reads `response.headers`, so the server-issued `Mcp-Session-Id` is never captured or echoed. Spec-compliant HTTP servers reject subsequent calls. Fix: runtime-only capture + echo (no `drone-core` config change — confirmed with user).
- **Item 2** — `callTool` (~client.ts:877-884) returns the raw `tools/call` result and never inspects `isError`, so tool failures look like successes. Fix: throw on `isError === true` (confirmed Option A); the conversation service's `executeToolSafely` already converts thrown errors into a real `{kind:'error'}` tool result, so the LLM sees a genuine failure.

## Existing scaffolding (DO NOT rebuild)

Tests ALREADY exist (the `mcp-client-gaps` "No tests" note was stale and has been corrected). The fast suite `drone-agent/test/mcp-client.test.ts` uses `createMockFetch` from `drone-agent/test/mcp-fake-server.ts` (in-process `fetch` mock). It deliberately locks in CURRENT behavior under a "PHASE 1 RULE". Two tests encode the defects and must be flipped:

- `mcp-client.test.ts:233` "does NOT surface isError to the caller (current behavior)"
- No session-id test exists yet (must be ADDED).

The `mcp-fake-server.ts` `okResponse` helper returns `headers: new Headers()` (empty). It must optionally emit `mcp-session-id` on the `initialize` response.

## Agent assignment

| Step | Action                                                      | Agent type             |
| ---- | ----------------------------------------------------------- | ---------------------- |
| 1    | Bug 1 impl (session-id capture/echo)                        | coder                  |
| 2    | Bug 2 impl (throw on isError)                               | coder                  |
| 3    | Flip + add tests in mcp-client.test.ts + mcp-fake-server.ts | coder (tester reviews) |
| 4    | Reviewer pass over client.ts + tests                        | reviewer               |
| 5    | Run validation: typecheck, lint, tests                      | coder/executor         |

Steps 1 & 2 both touch `client.ts` but in disjoint functions — a single coder executes them in order (1 then 2). Step 3 depends on 1 & 2. Step 4 depends on 3. Step 5 depends on 4.

## Steps

### Step 1 — Capture & echo `Mcp-Session-Id` (client.ts, `createStreamableHttpJsonRpcClient`)

In `client.ts` (~line 489):

1. Add a closure variable alongside `let nextId = 1; let closed = false;` (line ~498):
   ```ts
   let sessionId: string | undefined;
   ```
2. In the `request` function, merge the captured id into the outgoing `fetch` headers (lines ~515-521). Place it BEFORE `...options.headers` so the server-issued id is authoritative and a user cannot accidentally override it:
   ```ts
   const response = await fetch(options.url, {
     method: 'POST',
     headers: {
       'content-type': 'application/json',
       accept: 'application/json',
       ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
       ...options.headers,
     },
     body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
     signal: controller.signal,
   });
   ```
3. After the `if (!response.ok) { throw ... }` guard (line ~523), capture the id from every successful response (idempotent — only overwrites when present):
   ```ts
   const serverSessionId = response.headers.get('mcp-session-id');
   if (serverSessionId) {
     sessionId = serverSessionId;
   }
   ```
   This is strictly HTTP-only; stdio builder (`createStdioJsonRpcClient`) is untouched. No `drone-core` change.

### Step 2 — Throw on `isError` in `callTool` (client.ts, `createMcpClientConnection`)

In `client.ts` (~line 877), replace the `callTool` definition:

```ts
callTool: async (name, args) => {
  const result = await requestWithRetry<unknown>(
    'tools/call',
    { name, arguments: args },
    false
  );
  if (isRecord(result) && result.isError === true) {
    const text = extractToolErrorText(result);
    throw new Error(
      `MCP tool '${name}' failed${text ? `: ${text}` : ''}`
    );
  }
  return result;
},
```

Add a module-local helper (near other small helpers, e.g. after `asArray`):

```ts
function extractToolErrorText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return '';
  }
  return result.content
    .filter(isRecord)
    .map(c => (typeof c.text === 'string' ? c.text : ''))
    .join('\n')
    .trim();
}
```

`isRecord` is already imported at the top of client.ts (`import { isRecord } from '../../shared/type-guards.js'`). No change to `index.ts` mount wrapper — `executeToolSafely` in `conversation-service.ts:233` already maps a thrown error to `{kind:'error', content}`, so the LLM sees a real failure.

### Step 3 — Update test scaffolding

**3a. `drone-agent/test/mcp-fake-server.ts`:** add a `sessionId?: string` field to `MockFetchOptions`. In `createMockFetch`, after a successful `okResponse` for the `initialize` method, attach the header:

```ts
const resp = okResponse(handle(id, method, parsed.params));
if (method === 'initialize' && options.sessionId) {
  resp.headers.set('mcp-session-id', options.sessionId);
}
return resp;
```

(Existing `okResponse` returns a real `Headers` instance, so `.set` works.) Leave non-initialize responses header-less to faithfully simulate the wire.

**3b. `drone-agent/test/mcp-client.test.ts`:**

- REPLACE the test at line ~233 "does NOT surface isError to the caller (current behavior)" with:
  ```ts
  it('rejects when tools/call returns isError: true', async () => {
    const mock = currentMock!;
    mock.onRequest('tools/call', params => {
      const p = (params ?? {}) as { name?: string };
      return {
        content: [{ type: 'text', text: `failed ${p.name}` }],
        isError: true,
      };
    });
    const conn = await makeConnection(mock);
    await expect(conn.callTool('echo', {})).rejects.toThrow(
      /MCP tool 'echo' failed/
    );
  });
  ```
- ADD a new test (in or after the `initialize handshake` describe, or a new `describe('Mcp-Session-Id')`):
  ```ts
  it('captures Mcp-Session-Id from initialize and echoes it on subsequent requests', async () => {
    const mock = createMockFetch({ sessionId: 'sess-xyz' });
    installFetch(mock);
    const conn = await makeConnection(mock);
    await conn.callTool('echo', {}); // a post-initialize request
    const call = mock.lastRequest('tools/call')!;
    expect(call.headers['mcp-session-id']).toBe('sess-xyz');
  });
  ```
- Keep the existing success test at line ~226 (verifies `isError: false` still returns the result).

### Step 4 — Reviewer pass

Review `client.ts` diff + test changes for: (a) session id placed before `options.headers` merge; (b) capture only on `response.ok`; (c) `isError` check uses `isRecord` guard and `=== true`; (d) error message readable; (e) no regression to stdio path; (f) tests assert NEW behavior, not old.

### Step 5 — Validation

Run from workspace root:

- `pnpm typecheck` — must pass (no new type errors in client.ts).
- `pnpm lint` — ESLint + Prettier, must pass.
- `pnpm test mcp-client` (or `pnpm test` filtering `mcp-client.test.ts`) — all MCP fast-suite tests pass, including the two changed/added tests.
- `pnpm test mcp` — slow stdio integration suite still passes (unaffected, but confirm).

## Validation criteria (must ALL hold)

1. `pnpm typecheck` exits 0.
2. `pnpm lint` exits 0.
3. `pnpm test` passes for `mcp-client.test.ts`: the `rejects on isError` test passes AND the `captures Mcp-Session-Id` test passes; no test asserts the old buggy behavior.
4. `pnpm test mcp` (slow suite) still passes.
5. LSP diagnostics clean for `drone-agent/src/plugins/mcp/client.ts` (no new errors/warnings).
6. No `drone-core` changes were required (item 1 is runtime-only by decision).

## Notes / non-goals

- No config-schema change (session id is not pre-seedable — was an optional path, user chose runtime-only).
- No GET/SSE or DELETE session-termination work (those are gap items 8, out of scope).
- `discoveredToolCount` (item 9) and protocol-version negotiation (item 4) are NOT addressed here.
