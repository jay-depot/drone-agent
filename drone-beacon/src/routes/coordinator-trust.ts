import type { FastifyInstance } from 'fastify';
import {
  confirmCoordinatorFingerprint,
  getPendingCoordinatorFingerprint,
  isCoordinatorTrusted,
} from '../coordinator-trust.js';

export default function coordinatorTrustRoutes(app: FastifyInstance) {
  // Report the current coordinator trust state (used by agents to surface
  // a pending fingerprint to the user).
  app.get('/coordinator/trust', async () => {
    return {
      trusted: isCoordinatorTrusted(),
      pendingFingerprint: getPendingCoordinatorFingerprint() ?? null,
    };
  });

  // Confirm the pending coordinator fingerprint (human-only, via the agent).
  app.post<{ Body: { fingerprint: string } }>(
    '/coordinator/trust',
    async (request, reply) => {
      const { fingerprint } = request.body ?? {};
      if (!fingerprint) {
        return reply.code(400).send({ error: 'fingerprint required' });
      }
      const ok = confirmCoordinatorFingerprint(fingerprint);
      if (!ok) {
        return reply.code(400).send({
          error:
            'Fingerprint does not match the pending coordinator fingerprint',
        });
      }
      return { success: true };
    }
  );
}
