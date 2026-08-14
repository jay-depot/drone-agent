import type { FastifyInstance } from 'fastify';
import type { CreatePersonaRequest } from '../types.js';
import * as db from '../db/index.js';

export default function personaRoutes(app: FastifyInstance) {
  app.post<{ Body: CreatePersonaRequest }>(
    '/personas',
    async (request, reply) => {
      const persona = db.createPersona(request.body);
      return reply.code(201).send(persona);
    }
  );

  app.get('/personas', async () => {
    return db.listPersonas();
  });

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

  app.put<{ Params: { id: string }; Body: Partial<CreatePersonaRequest> }>(
    '/personas/:id',
    async (request, reply) => {
      const persona = db.updatePersona(request.params.id, request.body);
      if (!persona) {
        return reply.code(404).send({ error: 'Persona not found' });
      }
      // codeql[js/reflected-xss]
      return persona;
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/personas/:id',
    async (request, reply) => {
      const deleted = db.deletePersona(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Persona not found' });
      }
      return { success: true };
    }
  );
}
