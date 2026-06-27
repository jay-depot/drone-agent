---
key: security-plan
tags:
  []
created: 2026-06-27T19:02:53.755Z
updated: 2026-06-27T19:22:14.570Z
---

# Security Implementation Plan - STATUS: PARTIALLY COMPLETE

## Overview
This document describes the security architecture for the drone-agent system, covering:
1. Agent ↔ Beacon connection (local-only, WSS encryption)
2. Beacon ↔ Coordinator connection (HTTPS + keypair authentication + approval flow)
3. Local beacon auto-approval

## Implementation Status

### COMPLETED ✓

#### Phase 1: Coordinator Approval Flow
- ✓ beacon_trust table added to coordinator DB
- ✓ /beacons routes updated for key authentication and trust
- ✓ --approve CLI command added (`drone-coordinator --approve <token>`)
- ✓ /beacons/approve endpoint for approval
- ✓ Auto-approve for localhost/127.0.0.1 beacons
- ⏳ HTTPS server support (pending - requires Fastify TLS setup)

#### Phase 2: Beacon Registration + Polling
- ✓ drone-beacon/src/identity.ts - Ed25519 keypair management
- ✓ drone-beacon/src/tls.ts - TLS certificate management
- ✓ coordinator-client updated to include publicKey, handle pending status, poll for approval

#### Phase 3: Agent-Beacon Local-Only
- ✓ drone-beacon/src/ws-server.ts - Added local-only connection enforcement (error 4003)
- ✓ drone-agent swarm plugin updated to use wss:// and https://
- ✓ TLS certificate generation (can be reused for WSS)

### PENDING
- HTTPS server for coordinator (requires Fastify TLS configuration)
- HTTPS server for beacon (for coordinator connection)

## Files Modified

### drone-coordinator
- src/db.ts - Added beacon_trust table and functions
- src/types.ts - Added BeaconTrust, BeaconTrustStatus types
- src/routes.ts - Added trust endpoints
- src/index.ts - Added --approve CLI command

### drone-beacon
- src/identity.ts - NEW - Ed25519 keypair management
- src/tls.ts - NEW - TLS certificate generation/loading
- src/coordinator-client.ts - Updated for key auth and polling
- src/ws-server.ts - Added local-only enforcement

### drone-agent
- src/plugins/swarm/index.ts - Changed ws:// to wss://, http:// to https://

## Usage

### Approve a beacon:
```bash
drone-coordinator --approve <approval_token>
```

### List beacons:
```bash
drone-coordinator list-beacons
```