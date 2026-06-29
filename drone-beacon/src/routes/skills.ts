import type { FastifyInstance } from 'fastify';
import type { CreateSkillRequest } from '../types.js';
import { getCoordinatorClient } from './context.js';
import * as db from '../db.js';
import { logger } from '../logger.js';

export default function skillRoutes(app: FastifyInstance) {
  // Create a local skill
  app.post<{ Body: CreateSkillRequest }>('/skills', async (request, reply) => {
    const skill = db.createSkill(request.body, 'local');

    // Sync to coordinator
    const client = getCoordinatorClient();
    if (client) {
      client.pushSkill(skill).catch(err => {
        logger.warn(`Failed to push skill to coordinator: ${err}`);
      });
    }

    return reply.code(201).send(skill);
  });

  // List all skills (local + synced from coordinator)
  app.get('/skills', async () => {
    return db.listSkills();
  });

  // Get a single skill
  app.get<{ Params: { id: string } }>('/skills/:id', async (request, reply) => {
    const skill = db.getSkill(request.params.id);
    if (!skill) {
      return reply.code(404).send({ error: 'Skill not found' });
    }
    return skill;
  });

  // Update a local skill
  app.put<{ Params: { id: string }; Body: Partial<CreateSkillRequest> }>(
    '/skills/:id',
    async (request, reply) => {
      const skill = db.updateSkill(request.params.id, request.body);
      if (!skill) {
        return reply.code(404).send({ error: 'Skill not found' });
      }

      // Sync update to coordinator (only local scope)
      if (skill.scope === 'local') {
        const client = getCoordinatorClient();
        if (client) {
          client.pushSkill(skill).catch(err => {
            logger.warn(`Failed to push skill update to coordinator: ${err}`);
          });
        }
      }

      return skill;
    }
  );

  // Delete a local skill
  app.delete<{ Params: { id: string } }>(
    '/skills/:id',
    async (request, reply) => {
      const existing = db.getSkill(request.params.id);
      const deleted = db.deleteSkill(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Skill not found' });
      }

      // Sync delete to coordinator (only local scope)
      if (existing?.scope === 'local') {
        const client = getCoordinatorClient();
        if (client) {
          client.deleteSkill(request.params.id).catch(err => {
            logger.warn(`Failed to delete skill from coordinator: ${err}`);
          });
        }
      }

      return { success: true };
    }
  );
}