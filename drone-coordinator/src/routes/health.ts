import type { FastifyInstance } from 'fastify';

let coordinatorFingerprint: string | undefined;

/**
 * Record the coordinator's TLS certificate fingerprint so the health
 * endpoint can report it. Set at startup when HTTPS is enabled.
 */
export function setCoordinatorFingerprint(fp: string | undefined): void {
  coordinatorFingerprint = fp;
}

/**
 * The coordinator's TLS certificate fingerprint, or undefined if HTTPS is
 * not enabled. Used to compute the bidirectional verification code.
 */
export function getCoordinatorFingerprint(): string | undefined {
  return coordinatorFingerprint;
}

export default function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: Date.now(),
      ...(coordinatorFingerprint
        ? { tlsFingerprint: coordinatorFingerprint }
        : {}),
    };
  });
}
