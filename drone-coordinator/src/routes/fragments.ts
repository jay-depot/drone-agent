import type { FastifyInstance } from 'fastify';
import { BROADCAST_TARGET } from 'drone-core';
import { validateFragmentUpsert, countNonReserved } from 'drone-swarm-common';
import * as db from '../db/index.js';
import { notifyFragmentsChanged } from '../beacon-ws.js';

export default function fragmentRoutes(app: FastifyInstance) {
  // List fragments (raw rows; merged view is computed per beacon for delivery)
  app.get<{ Querystring: { target?: string } }>('/fragments', async request => {
    const fragments = db.listFragments({ target: request.query.target });
    return { fragments };
  });

  // Upsert a coordinator-scoped fragment. The reserved swarm-identity id is
  // authored here by the Identity page; the general shape keeps room for
  // future coordinator-authored fragments.
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/fragments/:id',
    async (request, reply) => {
      const body = {
        ...(request.body as Record<string, unknown>),
        id: request.params.id,
      };
      const result = validateFragmentUpsert(body, {
        scope: 'coordinator',
        countBroadcasts: () =>
          countNonReserved(db.listFragments({ target: BROADCAST_TARGET })),
        countTargetedForAgent: target =>
          countNonReserved(db.listFragments({ target })),
      });

      if (!result.ok) {
        return reply.code(400).send({ error: result.error, code: result.code });
      }

      const fragment = db.upsertFragment(result.normalized);
      notifyFragmentsChanged();
      return reply.code(200).send({ ok: true, fragment });
    }
  );

  // Delete a fragment. When the id exists under both targets, ?target=
  // disambiguates; when omitted and ambiguous, reject.
  app.delete<{ Params: { id: string }; Querystring: { target?: string } }>(
    '/fragments/:id',
    async (request, reply) => {
      const { id } = request.params;
      const rows = db.listFragments().filter(f => f.id === id);

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Fragment not found' });
      }

      let target = request.query.target;
      if (!target) {
        if (rows.length > 1) {
          return reply.code(400).send({
            error: `Fragment ${id} exists under multiple targets; specify ?target=`,
            code: 'validation',
          });
        }
        target = rows[0].target;
      }

      const deleted = db.deleteFragment(id, target);
      if (!deleted) {
        return reply.code(404).send({ error: 'Fragment not found' });
      }

      notifyFragmentsChanged();
      return reply.code(200).send({ ok: true });
    }
  );
}
