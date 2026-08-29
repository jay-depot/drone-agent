import type { FastifyInstance } from 'fastify';
import * as db from '../db/index.js';

export default function fragmentRoutes(app: FastifyInstance) {
  // Read-only in v1; authoring endpoints arrive with the persistent-WS
  // rework (see db/fragments.ts for the scaffolding).
  app.get<{ Querystring: { target?: string } }>(
    '/fragments',
    async request => {
      const fragments = db.listFragments({ target: request.query.target });
      return { fragments };
    }
  );
}