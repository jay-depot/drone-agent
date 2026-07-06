---
key: web-ui-tailscale-detection-research
tags:
  - coordinator
  - web-ui
  - tailscale
  - auth
  - research
created: 2026-06-30T23:08:00.922Z
updated: 2026-07-06T20:06:40.532Z
---

# Tailscale Detection Research: Coordinator Web UI Auth Bypass

## Background

The drone-coordinator's web UI has an auth bypass for Tailscale connections. Currently it uses **only a CGNAT IP range check** (`100.64.0.0/10`). This research investigates best practices for more robust Tailscale detection.

## Current Implementation

**File:** `drone-coordinator/src/web-auth.ts`

- `isTailscaleIp()` — checks if IP starts with `100.` and second octet is 64–127
- `isLocalRequest()` — considers CGNAT IPs as "local" and bypasses auth
- No identity extraction, no tailnet verification

## Methods for Tailscale Detection (Ranked by Reliability)

### 1. Tailscale Local API `whois` — MOST ROBUST (Gold Standard)

**Docs:** https://tailscale.com/docs/concepts/tailscale-identity
**Blog:** https://tailscale.com/blog/grafana-auth
**Reference impl:** https://agentgateway.dev/docs/standalone/latest/integrations/auth/tailscale/

**How it works:**
Every `tailscaled` daemon exposes a local HTTP API via Unix socket:

- Linux: `/run/tailscale/tailscaled.sock`
- macOS: `/var/run/tailscale/tailscaled.sock`

Query endpoint:

```
GET http://local-tailscaled.sock/localapi/v0/whois?addr=<IP>[:<port>]
```

**Response (JSON):**

```json
{
  "Node": {
    "ID": 1234567890,
    "StableID": "node-id",
    "Name": "computer.tailnet-name.ts.net.",
    "ComputedName": "computer"
  },
  "UserProfile": {
    "ID": 12345,
    "LoginName": "user@example.com",
    "DisplayName": "John Doe"
  },
  "CapMap": {
    "company.tld/cap/app": [{ "role": ["admin"] }]
  }
}
```

**CLI equivalent:** `tailscale whois --json <IP>[:port]`

**Used by:**

- **agentgateway** — calls whois for zero-trust MCP auth
- **Tailscale golink** — authenticates users via whois
- **Grafana auth proxy** (`proxy-to-grafana`) — identifies users via whois
- **Headscale** — management UI auth
- Various self-hosted tools (Authentik integration, etc.)

**Pros:**

- Definitively confirms the IP belongs to the local tailnet (not any random CGNAT IP)
- Returns verified user identity (email, display name, profile pic)
- Returns node info, tags, grants/capabilities — usable for RBAC
- The gold standard approach adopted by the ecosystem
- Can be used alongside Tailscale Serve identity headers for defense-in-depth

**Cons:**

- Requires local tailscaled socket access (Tailscale must run on same machine)
- Socket path differs by platform
- Port is needed in userspace networking mode; optional in kernel mode
- Local API is undocumented (no official stability guarantees)
- Falls back to nothing if Tailscale isn't running on the coordinator host

---

### 2. Tailscale Serve Identity Headers

**Docs:** https://tailscale.com/docs/features/tailscale-serve#identity-headers
**Blog:** https://tailscale.com/blog/app-capabilities

**How it works:**
When traffic is proxied through `tailscale serve`, Tailscale injects verified headers and strips any existing copies (anti-spoofing):

- `Tailscale-User-Login` — requester's login name (e.g., `alice@example.com`)
- `Tailscale-User-Name` — requester's display name (e.g., `Alice Architect`)
- `Tailscale-User-Profile-Pic` — profile picture URL (if available)
- `Tailscale-App-Capabilities` — serialized JSON of app capabilities (v1.92+)

**Pros:**

- Simple HTTP header parsing
- Tailscale strips pre-existing copies of these headers (no spoofing)
- Provides verified identity without any extra API calls

**Cons:**

- **Only available when using `tailscale serve`** as a reverse proxy — NOT for direct connections to the coordinator
- Not populated for tagged devices (only user devices)
- Requires coordinator to be served through tailscale serve
- Funnel (public) traffic doesn't include these headers
- Outside the coordinator's control — depends on deployment choice

---

### 3. CGNAT IP Range Check — CURRENT APPROACH (Least Robust)

**Concern validated by community:**
Reddit discussion (r/Tailscale): "Can anyone with Tailscale bypass IP restriction of 100.64.0.0/10?"

- Consensus: **Yes.** Any Tailscale user on any tailnet has a 100.x.x.x IP. This is not exclusive to your tailnet.
- ISPs also use CGNAT (RFC 6598) — Starlink, mobile carriers, etc.
- Other mesh VPNs (ZeroTier, Netmaker) may also use this range
- Tailscale supports custom IP assignments from this range

**Pros:**

- Simple, no dependencies, no extra API calls
- Catches all Tailscale traffic (and some non-Tailscale CGNAT traffic)

**Cons:**

- **No identity information** — just an IP range
- **Not tailnet-specific** — any Tailscale user anywhere can connect from a 100.x.x.x IP
- **False positives** — ISPs and other VPNs also use CGNAT range
- Cannot distinguish between your devices and some random Tailscale user
- Essentially provides no real security

---

### 4. PROXY Protocol

**Docs:** https://tailscale.com/docs/reference/tailscale-cli/serve#use-the-proxy-protocol

Tailscale Serve supports PROXY protocol v2 for TCP forwarding, preserving the original source IP. This doesn't add identity info beyond the source IP. Only relevant if deploying behind tailscale serve with TCP forwarding.

---

### 5. `tailscale status --json` Peer Cross-Reference

**How it works:** Parse `tailscale status --json` to get a list of known peers and their IPs, then check if the connecting IP matches a known peer.

**Pros:** Can verify an IP belongs to the local tailnet
**Cons:**

- Requires running tailscale binary or querying local API
- Only tells you "is this IP in my tailnet?" — not "who is it?"
- The whois API is strictly better (does the same + returns identity)

---

## Implementation Recommendations for Coordinator

### Architecture Considerations

The coordinator is a Fastify server that:

- May or may not run on a machine with Tailscale installed
- May be accessed directly or through tailscale serve
- Already has a `web-auth.ts` auth middleware

### Recommended Approach: Layered Strategy

**Layer 1 (Primary): Local API `whois`**
When Tailscale is running locally, use the whois endpoint to:

1. Confirm the IP belongs to the local tailnet
2. Extract user identity for logging/auditing
3. Optionally enforce RBAC via CapMap/grants

**Layer 2 (Fallback): Configurable CGNAT bypass**
Keep the CGNAT range check as a configurable fallback for deployments where Tailscale isn't running locally. This should be opt-in via config (e.g., `tailscale.cgnatBypass: true`).

**Layer 3 (Optional): Tailscale Serve identity headers**
If the coordinator is deployed behind tailscale serve, identity headers provide an alternative verification path. These headers could supplement the whois check.

### Config Changes Needed

```typescript
// New config section in drone-coordinator
tailscale?: {
  enabled: boolean;        // Enable Tailscale detection
  socketPath?: string;     // Path to tailscaled socket (auto-detect if omitted)
  cgnatBypass?: boolean;   // Fallback to CGNAT range check if whois unavailable
  requireAuth?: boolean;   // Require whois success, or allow CGNAT as sufficient?
}
```

### Implementation Plan

1. **Add `tailscale` config to coordinator config schema** (drone-coordinator types + config)

2. **Create a `TailscaleDetector` service** that:
   - Auto-detects the tailscaled socket path (try Linux path first, then macOS)
   - Probes the whois endpoint with the connecting IP:port
   - Returns identity info or null
   - Has configurable timeout
   - Logs failures gracefully (don't crash if Tailscale isn't running)

3. **Update `isLocalRequest()` / auth middleware** to:
   - First try whois for CGNAT IPs
   - If whois succeeds: allow access + log identity
   - If whois fails and `cgnatBypass` enabled: allow with current CGNAT check (logged warning)
   - If whois fails and `cgnatBypass` disabled: require web token auth

4. **Add identity logging** to access logs (who connected via Tailscale)

### Risks and Mitigations

| Risk                                      | Mitigation                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| Local API undocumented, may change        | Pin tailscale version; monitor tailscale changelog; fallback to CLI `tailscale whois` |
| Socket path varies by platform/container  | Configurable; auto-detect common paths; document in config                            |
| Tailscale not running on coordinator host | CGNAT fallback (opt-in); clear error logging                                          |
| whois latency on every request            | Cache whois results per IP (TTL: 5 min); whois is a local Unix socket call (~1ms)     |
| Port requirement differs by mode          | Try with port first, fall back to without port                                        |
