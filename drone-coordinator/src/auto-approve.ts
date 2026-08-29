/**
 * Runtime opt-in that makes new beacon trust registrations start as
 * "approved" instead of "pending".
 *
 * This exists for test/integration deployments (docker compose swarm) where
 * there is no operator to click Approve. It is OFF by default and can only
 * be enabled through the coordinator's config file
 * (`autoApproveBeacons: true`) — never by a request — so production
 * deployments keep the manual TOFU approval gate.
 *
 * Security notes:
 * - The anti-spoof check (presented mTLS client cert must match the claimed
 *   TLS fingerprint) is unaffected.
 * - Public-key identity anchoring is unaffected.
 * - The only weakened invariant is "a human saw the verification code",
 *   which is meaningless in an unattended test swarm.
 */

let autoApprove = false;

export function setAutoApproveBeacons(value: boolean): void {
  autoApprove = value;
}

export function isAutoApproveBeacons(): boolean {
  return autoApprove;
}
