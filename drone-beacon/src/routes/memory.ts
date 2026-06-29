import type { FastifyInstance } from 'fastify';
import type { CreateMemoryRequest, UpdateMemoryRequest } from '../types.js';
import { type MemoryQuery } from './context.js';
import * as db from '../db.js';

export default function memoryRoutes(app: FastifyInstance) {
  // Create a memory
  app.post<{ Body: CreateMemoryRequest }>('/memory', async (request, reply) => {
    const memory = db.createMemory(request.body);
    return reply.code(201).send(memory);
  });

  // List memories (with optional namespace filter)
  app.get<{ Querystring: MemoryQuery }>('/memory', async (request, reply) => {
    const namespace = request.query.namespace;
    const includeExpired = request.query.includeExpired === 'true';
    return db.listMemories(namespace, includeExpired);
  });

  // Get memory by ID
  app.get<{ Params: { id: string } }>('/memory/:id', async (request, reply) => {
    const memory = db.getMemory(request.params.id);
    if (!memory) {
      return reply.code(404).send({ error: 'Memory not found' });
    }
    // Check if expired
    if (db.isMemoryExpired(memory)) {
      return reply.code(404).send({ error: 'Memory not found (expired)' });
    }
    return memory;
  });

  // Get memory by key
  app.get<{ Params: { key: string }; Querystring: MemoryQuery }>(
    '/memory/key/:key',
    async (request, reply) => {
      const namespace = request.query.namespace || 'default';
      const memory = db.getMemoryByKey(request.params.key, namespace);
      if (!memory) {
        return reply.code(404).send({ error: 'Memory not found' });
      }
      // Check if expired
      if (db.isMemoryExpired(memory)) {
        return reply.code(404).send({ error: 'Memory not found (expired)' });
      }
      // Parse the value back to object if it's JSON
      let parsedValue = memory.value;
      try {
        parsedValue = JSON.parse(memory.value);
      } catch {
        // Not JSON, keep as string
      }
      return { ...memory, value: parsedValue };
    }
  );

  // Update a memory
  app.put<{ Params: { id: string }; Body: Partial<UpdateMemoryRequest> }>(
    '/memory/:id',
    async (request, reply) => {
      const memory = db.updateMemory(request.params.id, request.body);
      if (!memory) {
        return reply.code(404).send({ error: 'Memory not found' });
      }
      return memory;
    }
  );

  // Delete a memory
  app.delete<{ Params: { id: string } }>(
    '/memory/:id',
    async (request, reply) => {
      const deleted = db.deleteMemory(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Memory not found' });
      }
      return { success: true };
    }
  );
}
