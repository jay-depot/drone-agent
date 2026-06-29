import type { FastifyInstance } from 'fastify';
import type { CreatePersonaRequest } from '../types.js';
import { getCoordinatorClient, proxyToCoordinator } from './context.js';
import * as db from '../db.js';
import { logger } from '../logger.js';

export default function personaRoutes(app: FastifyInstance) {
  // Create a local persona (beacon-scoped)
  app.post<{ Body: CreatePersonaRequest }>(
    '/personas',
    async (request, reply) => {
      const persona = db.createPersona(request.body, 'local');

      // Sync to coordinator
      const client = getCoordinatorClient();
      if (client) {
        client.pushPersona(persona).catch(err => {
          logger.warn(`Failed to push persona to coordinator: ${err}`);
        });
      }

      // Log the event
      db.createEventLog({
        eventType: 'persona.created',
        targetId: persona.id,
        targetType: 'persona',
      });

      return reply.code(201).send(persona);
    }
  );

  // List all personas (local + synced from coordinator)
  app.get('/personas', async () => {
    return db.listPersonas();
  });

  // Get a single persona
  app.get<{ Params: { id: string } }>(
    '/personas/:id',
    async (request, reply) => {
      const persona = db.getPersona(request.params.id);
      if (!persona) {
        return reply.code(404).send({ error: 'Persona not found' });
      }
      return persona;
    }
  );

  // Update a local persona
  app.put<{ Params: { id: string }; Body: Partial<CreatePersonaRequest> }>(
    '/personas/:id',
    async (request, reply) => {
      const persona = db.updatePersona(request.params.id, request.body);
      if (!persona) {
        return reply.code(404).send({ error: 'Persona not found' });
      }

      // Sync update to coordinator (only local scope)
      if (persona.scope === 'local') {
        const client = getCoordinatorClient();
        if (client) {
          client.pushPersona(persona).catch(err => {
            logger.warn(`Failed to push persona update to coordinator: ${err}`);
          });
        }
      }

      return persona;
    }
  );

  // Delete a local persona
  app.delete<{ Params: { id: string } }>(
    '/personas/:id',
    async (request, reply) => {
      const existing = db.getPersona(request.params.id);
      const deleted = db.deletePersona(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Persona not found' });
      }

      // Sync delete to coordinator (only local scope)
      if (existing?.scope === 'local') {
        const client = getCoordinatorClient();
        if (client) {
          client.deletePersona(request.params.id).catch(err => {
            logger.warn(`Failed to delete persona from coordinator: ${err}`);
          });
        }
      }

      return { success: true };
    }
  );
}
