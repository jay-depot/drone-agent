import type { FastifyInstance } from 'fastify';
import type { CreateSkillRequest } from '../types.js';
import * as db from '../db.js';

export default function skillRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateSkillRequest }>('/skills', async (request, reply) => {
    const skill = db.createSkill(request.body);
    return reply.code(201).send(skill);
  });

  app.get('/skills', async () => {
    return db.listSkills();
  });

  app.get<{ Params: { id: string } }>('/skills/:id', async (request, reply) => {
    const skill = db.getSkill(request.params.id);
    if (!skill) {
      return reply.code(404).send({ error: 'Skill not found' });
    }
    return skill;
  });

  app.put<{ Params: { id: string }; Body: Partial<CreateSkillRequest> }>(
    '/skills/:id',
    async (request, reply) => {
      const skill = db.updateSkill(request.params.id, request.body);
      if (!skill) {
        return reply.code(404).send({ error: 'Skill not found' });
      }
      return skill;
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/skills/:id',
    async (request, reply) => {
      const deleted = db.deleteSkill(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Skill not found' });
      }
      return { success: true };
    }
  );
}
