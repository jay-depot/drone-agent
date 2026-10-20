import type { SwarmNodeIdentity } from 'drone-swarm-common';

let signingIdentity: SwarmNodeIdentity | null = null;

export function setSigningIdentity(identity: SwarmNodeIdentity): void {
  signingIdentity = identity;
}

export function getSigningIdentity(): SwarmNodeIdentity | null {
  return signingIdentity;
}
