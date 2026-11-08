import {
  createExtensionNode,
  type ExtensionNode,
  type InvokeCtx,
  type InvokeResult,
} from 'drone-swarm-common';
import type { DroneSessionSnapshot, DroneSessionEndedEvent } from 'drone-core';
import { logger } from './logger.js';
import type { SwarmExtensionConfig } from './types.js';
import { SCHEDULE_CAPABILITIES } from './schedule/catalog.js';

/** Handlers the gateway installs on the node (session state + tool invokes). */
export interface ExtensionNodeHandlers {
  onSessionStarted: (s: DroneSessionSnapshot) => void;
  onSessionEnded: (e: DroneSessionEndedEvent) => void;
  onInvokeTool: (
    cap: string,
    params: unknown,
    ctx: InvokeCtx
  ) => Promise<InvokeResult>;
}

/**
 * Owns the gateway's swarm extension node: one node per gateway process.
 *
 * The node starts in the background and retries registration, so the gateway
 * serves conversations before the coordinator answers. Until the node exists,
 * {@link fetch} rejects with a clear error instead of a low-level socket error;
 * the spawn path then reports a coordinator outage rather than hanging.
 */
export class ExtensionNodeHandle {
  private node: ExtensionNode | null = null;
  private stopped = false;
  private handlers: ExtensionNodeHandlers | null = null;

  constructor(
    private readonly coordinatorUrl: string,
    private readonly config: SwarmExtensionConfig
  ) {}

  /** Install the session and invoke handlers before {@link start}. */
  setHandlers(handlers: ExtensionNodeHandlers): void {
    this.handlers = handlers;
  }

  /** Start the node without waiting for registration. Safe to call once. */
  start(): void {
    void createExtensionNode({
      coordinatorUrl: this.coordinatorUrl,
      dataDir: this.config.dataDir,
      id: this.config.id,
      name: this.config.name,
      capabilities: SCHEDULE_CAPABILITIES,
      awaitRegistration: false,
      requestTimeoutMs: this.config.requestTimeoutMs,
      handlers: {
        onSessionStarted: session => {
          logger.debug({ sessionId: session.sessionId }, 'session started');
          this.handlers?.onSessionStarted(session);
        },
        onSessionEnded: session => {
          logger.debug({ sessionId: session.sessionId }, 'session ended');
          this.handlers?.onSessionEnded(session);
        },
        onInvokeTool: (cap, params, ctx) => {
          if (!this.handlers) {
            return Promise.resolve({
              ok: false,
              status: 503,
              body: { error: 'gateway not ready' },
            });
          }
          return this.handlers.onInvokeTool(cap, params, ctx);
        },
      },
    })
      .then(node => {
        if (this.stopped) {
          void node.stop();
          return;
        }
        this.node = node;
      })
      .catch(err => {
        logger.error(`Extension node failed: ${err}`);
      });
  }

  isReady(): boolean {
    return this.node !== null;
  }

  /** Delegates to the node's mTLS fetch; rejects while the node is absent. */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const node = this.node;
    if (!node) {
      throw new Error(
        'coordinator unavailable: gateway extension node not connected'
      );
    }
    return node.getFetch()(url, init);
  }

  /** Push a persistent prompt fragment into a target session. No-op when absent. */
  injectFragment(input: {
    target: string;
    id: string;
    content: string;
    phase?: 'header' | 'footer';
    ttlMs?: number;
  }): void {
    this.node?.injectFragment(input);
  }

  /** Select capabilities as tools for a target session. No-op when absent. */
  injectTools(input: { target: string; capabilities: string[] }): void {
    this.node?.injectTools(input);
  }

  /** Remove a prior injection. No-op when absent. */
  removeInjection(input: {
    target: string;
    kind: 'fragment' | 'reminder' | 'tools';
    injectionId?: string;
    tools?: string[];
  }): void {
    this.node?.removeInjection(input);
  }

  /** Idempotent. Stops the node so terminate requests can no longer go out. */
  async stop(): Promise<void> {
    this.stopped = true;
    const node = this.node;
    this.node = null;
    if (node) await node.stop();
  }
}
