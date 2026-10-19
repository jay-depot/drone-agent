import { createExtensionNode, type ExtensionNode } from 'drone-swarm-common';
import { logger } from './logger.js';
import type { SwarmExtensionConfig } from './types.js';

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

  constructor(
    private readonly coordinatorUrl: string,
    private readonly config: SwarmExtensionConfig
  ) {}

  /** Start the node without waiting for registration. Safe to call once. */
  start(): void {
    void createExtensionNode({
      coordinatorUrl: this.coordinatorUrl,
      dataDir: this.config.dataDir,
      id: this.config.id,
      name: this.config.name,
      capabilities: [],
      awaitRegistration: false,
      requestTimeoutMs: this.config.requestTimeoutMs,
      handlers: {
        onSessionStarted: session =>
          logger.debug({ sessionId: session.sessionId }, 'session started'),
        onSessionEnded: session =>
          logger.debug({ sessionId: session.sessionId }, 'session ended'),
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

  /** Idempotent. Stops the node so terminate requests can no longer go out. */
  async stop(): Promise<void> {
    this.stopped = true;
    const node = this.node;
    this.node = null;
    if (node) await node.stop();
  }
}
