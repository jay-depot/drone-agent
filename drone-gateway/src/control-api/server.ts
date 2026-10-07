import Fastify, { type FastifyInstance } from 'fastify';
import { logger } from '../logger.js';
import {
  UnknownAdapterError,
  UnknownConversationError,
  InjectionNotEnabledError,
} from '../errors.js';
import type { GatewayEngine } from '../engine.js';
import type { ControlApiConfig } from '../types.js';

export interface ControlApiServerOptions {
  engine: GatewayEngine;
  config: ControlApiConfig;
  version: string;
}

export class ControlApiServer {
  private app: FastifyInstance | null = null;
  private readonly opts: ControlApiServerOptions;

  constructor(opts: ControlApiServerOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const app = Fastify({ logger: false });
    this.app = app;
    const { token } = this.opts.config;

    if (token) {
      app.addHook('onRequest', async (req, reply) => {
        if (req.headers['authorization'] !== `Bearer ${token}`) {
          await reply.code(401).send({ ok: false, error: 'unauthorized' });
        }
      });
    }

    app.get('/status', async () => ({
      ok: true,
      version: this.opts.version,
      adapters: this.opts.engine.listAdapterIds(),
    }));

    app.get('/conversations', async () => ({
      ok: true,
      conversations: this.opts.engine.listInjectableConversations(),
    }));

    app.post('/inject', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { adapterId, conversationId, text } = body;
      if (
        typeof adapterId !== 'string' ||
        adapterId.trim() === '' ||
        typeof conversationId !== 'string' ||
        conversationId.trim() === '' ||
        typeof text !== 'string'
      ) {
        return reply.code(400).send({
          ok: false,
          error: 'adapterId, conversationId and text are required',
        });
      }
      try {
        await this.opts.engine.injectMessage(adapterId, conversationId, text);
        return { ok: true, posted: true };
      } catch (err) {
        if (
          err instanceof UnknownAdapterError ||
          err instanceof UnknownConversationError
        ) {
          return reply.code(404).send({ ok: false, error: err.message });
        }
        if (err instanceof InjectionNotEnabledError) {
          return reply.code(403).send({ ok: false, error: err.message });
        }
        logger.error({ err }, 'Injection failed');
        return reply.code(500).send({ ok: false, error: 'injection failed' });
      }
    });

    await app.listen({
      host: this.opts.config.host,
      port: this.opts.config.port,
    });
    logger.info(
      `Control API listening on ${this.opts.config.host}:${this.opts.config.port}` +
        (token ? ' (Bearer token required)' : ' (loopback trust, no token)')
    );
  }

  async stop(): Promise<void> {
    const app = this.app;
    this.app = null;
    if (app) await app.close();
  }
}
