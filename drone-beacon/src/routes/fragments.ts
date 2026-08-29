import type { FastifyInstance } from 'fastify';
import type { DroneSwarmFragment } from 'drone-core';
import * as db from '../db/index.js';
import { validateFragmentUpsert } from '../fragments-limits.js';
import {
  pushFragmentToAgent,
  pushFragmentSyncToAllConnected,
  isAgentConnected,
} from '../ws-server.js';

function pushFragmentUpsert(fragment: DroneSwarmFragment): void {
  if (fragment.target === 'broadcast') {
    pushFragmentSyncToAllConnected();
    return;
  }
  if (isAgentConnected(fragment.target)) {
    pushFragmentToAgent(fragment.target, 'set', fragment);
  }
}

function pushFragmentRemoval(fragment: DroneSwarmFragment): void {
  if (fragment.target === 'broadcast') {
    pushFragmentSyncToAllConnected();
    return;
  }
  if (isAgentConnected(fragment.target)) {
    pushFragmentToAgent(fragment.target, 'remove', fragment);
  }
}

export default function fragmentRoutes(app: FastifyInstance) {
  // List fragments (raw rows; merged view is computed per agent for delivery)
  app.get<{ Querystring: { target?: string; scope?: string } }>(
    '/fragments',
    async request => {
      const fragments = db.listFragments({
        target: request.query.target,
        scope: request.query.scope,
      });
      return { fragments };
    }
  );

  // Upsert a fragment (idempotent keyed upsert; accept-and-queue for
  // unknown agentIds)
  app.post<{ Body: unknown }>('/fragments', async (request, reply) => {
    const result = validateFragmentUpsert(request.body, {
      countBroadcasts: () => db.listFragments({ target: 'broadcast' }).length,
      countTargetedForAgent: target => db.listFragments({ target }).length,
    });

    if (!result.ok) {
      return reply.code(400).send({ error: result.error, code: result.code });
    }

    const fragment = db.upsertFragment(result.normalized);
    pushFragmentUpsert(fragment);

    return reply.code(200).send({ ok: true, fragment });
  });

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

      pushFragmentRemoval(deleted);
      return reply.code(200).send({ ok: true });
    }
  );
}
