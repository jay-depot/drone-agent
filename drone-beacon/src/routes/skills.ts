import type { FastifyInstance } from 'fastify';
import type { CreateSkillRequest, Skill } from '../types.js';
import { getCoordinatorClient } from './context.js';
import * as db from '../db/index.js';
import { logger } from '../logger.js';
import { skillStorageKey } from 'drone-core';

export default function skillRoutes(app: FastifyInstance) {
  // ── Global skills (key === id) ──────────────────────────────────────
  app.post<{ Body: CreateSkillRequest }>('/skills', async (request, reply) => {
    const skill = db.createSkill(request.body, { scope: 'local' });
    pushGlobalSkill(skill);
    return reply.code(201).send(skill);
  });

  app.get('/skills', async () => {
    return db.listSkills();
  });

  // Global route: only resolves global skills so ids never map ambiguously.
  app.get<{ Params: { id: string } }>('/skills/:id', async (request, reply) => {
    const skill = db.getGlobalSkill(request.params.id);
    if (!skill) {
      return reply.code(404).send({ error: 'Skill not found' });
    }
    return skill;
  });

  app.put<{ Params: { id: string }; Body: Partial<CreateSkillRequest> }>(
    '/skills/:id',
    async (request, reply) => {
      const skill = db.updateSkillByKey(request.params.id, request.body);
      if (!skill) {
        return reply.code(404).send({ error: 'Skill not found' });
      }
      pushGlobalSkill(skill);
      // codeql[js/reflected-xss]
      return skill;
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/skills/:id',
    async (request, reply) => {
      const existing = db.getGlobalSkill(request.params.id);
      const deleted = db.deleteSkillByKey(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Skill not found' });
      }
      pushDeleteOnCoordinator(existing);
      return { success: true };
    }
  );

  // ── Persona-owned skills ────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/personas/:id/skills',
    async (request, reply) => {
      const persona = db.getPersona(request.params.id);
      if (!persona) {
        return reply.code(404).send({ error: 'Persona not found' });
      }
      return db.listSkillsByPersona(request.params.id);
    }
  );

  app.post<{ Params: { id: string }; Body: CreateSkillRequest }>(
    '/personas/:id/skills',
    async (request, reply) => {
      const persona = db.getPersona(request.params.id);
      if (!persona) {
        return reply.code(404).send({ error: 'Persona not found' });
      }
      const scope = persona.scope === 'coordinator' ? 'coordinator' : 'local';
      const skill = db.createSkill(request.body, {
        scope,
        personaId: request.params.id,
      });
      // Owned skills never sync to the coordinator (they are private to their
      // owner, which is itself beacon-local or coordinator-scoped).
      return reply.code(201).send(skill);
    }
  );

  app.put<{
    Params: { id: string; skillId: string };
    Body: Partial<CreateSkillRequest>;
  }>('/personas/:id/skills/:skillId', async (request, reply) => {
    const key = skillStorageKey(request.params.id, request.params.skillId);
    const skill = db.updateSkillByKey(key, request.body);
    if (!skill) {
      return reply.code(404).send({ error: 'Skill not found' });
    }
    // codeql[js/reflected-xss]
    return skill;
  });

  app.delete<{ Params: { id: string; skillId: string } }>(
    '/personas/:id/skills/:skillId',
    async (request, reply) => {
      const key = skillStorageKey(request.params.id, request.params.skillId);
      const deleted = db.deleteSkillByKey(key);
      if (!deleted) {
        return reply.code(404).send({ error: 'Skill not found' });
      }
      return { success: true };
    }
  );

  function pushGlobalSkill(skill: Skill): void {
    if (skill.personaId || skill.scope !== 'local') return;
    const client = getCoordinatorClient();
    if (client) {
      client.pushSkill(skill).catch(err => {
        logger.warn(`Failed to push skill to coordinator: ${err}`);
      });
    }
  }

  function pushDeleteOnCoordinator(existing: Skill | undefined): void {
    if (!existing || existing.personaId || existing.scope !== 'local') return;
    const client = getCoordinatorClient();
    if (client) {
      client.deleteSkill(existing.id).catch(err => {
        logger.warn(`Failed to delete skill from coordinator: ${err}`);
      });
    }
  }
}
