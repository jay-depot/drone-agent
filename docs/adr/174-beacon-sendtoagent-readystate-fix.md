---
tags: [decision, beacon, websocket, bug-fix, ready-state]
related: [concepts/swarm-prompt-fragments.md, decisions/173-swarm-prompt-fragments.md, modules/drone-beacon.md, decisions/123-rate-limit-mtls-ws-reverse-channel.md]
---

# 174: Beacon `sendToAgent` numeric-readyState fix

**Status**: Implemented (2026-08-29, branch `feat/coordinator-sysmessage-insert`, commit `b30b748`)

## Context

Every server→agent push in the beacon flows through one gate:

```ts
if (conn && conn.socket.readyState === 'OPEN') {
  conn.socket.send(JSON.stringify(message));
  return true;
}
return false;
```

The beacon's WebSocket server is `@fastify/websocket`, whose sockets are `ws`-library `WebSocket` instances. In `ws`, `readyState` is a **number** (`CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3`) — `ws.WebSocket.OPEN === 1`. Comparing it to the string `'OPEN'` is always `false`, so `sendToAgent` returned `false` for every connected agent without ever sending a frame.

This pre-existing bug silently disabled **all** live server pushes — direct message delivery to connected agents, channel broadcasts, and ack confirmations included — from the day the WS messaging feature shipped. The unread-message replay path still worked (delivered on connect before any `sendToAgent` call, via unbound delivery plus DB-backed re-delivery on reconnect), which is why the feature appeared functional: everything looked like a reconnect, never a live push.

The fragment-push feature (ADR 173) rides entirely on `sendToAgent`-family pushes and has an integration test asserting real-time frame delivery, which is what finally exposed it: `fragmentSync` never arrived in the Docker swarm (`pnpm test:integration` timed out waiting for the frame).

## Decision

Accept **both** ready-state representations in the gate — the numeric protocol constant (1) and the WHATWG string (`'OPEN'`) — instead of assuming one:

```ts
const readyState = conn.socket.readyState;
if (readyState !== 1 && readyState !== 'OPEN') {
  return false;
}
conn.socket.send(JSON.stringify(message));
return true;
```

The source comment records why: a representation mismatch must never silently drop a push. (If the socket layer ever changes to a WHATWG client, the string arm keeps the check correct; the numeric check keeps it correct under `ws`.)

## Consequence

- Live server→agent delivery actually works: the probe client received `fragmentSync`, `connected`, and `fragment` set-removes in real time after the fix (verified against a locally running beacon before re-running the Docker suite).
- Pre-existing consumers regain intended behavior: inter-agent messaging (`sendToAgent`), channel broadcast (`sendToChannel` loops through `sendToAgent`), and acks — delivery had been degrading to connect-time-only replay all along.

## Verification

- `drone-beacon/test/ws-server.test.ts` covers the helpers (unconnected → false, TTL sweep removal-push, sync-all no-throw).
- The integration-level coverage lives in `drone-agent/test/swarm-fragments-integration.test.ts`: registers an agent over REST, opens a WS from the test-runner container, and polls for `fragmentSync` on connect + a live `fragment` push — green in the provisioned Docker swarm after the fix.

## Key Points

- Numeric `readyState` (1) vs the string `'OPEN'`: always compare against both or against numeric constants only; never mix representations in one comparison.
- A silent boolean-returning deliverer (`false`) is easy to miss because callers often ignore the return value — pair deliverer helpers with an integration test that asserts the message actually arrives.

## Related

- [[decisions/175-beacon-islocalconnection-rfc1918]] — the other WS-delivery blocker fixed in the same investigation
- [[concepts/swarm-prompt-fragments]] — the feature that surfaced this
- [[decisions/173-swarm-prompt-fragments]] — the fragment delivery design (WS push + resync)