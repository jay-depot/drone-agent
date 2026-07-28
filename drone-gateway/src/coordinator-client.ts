import { logger } from './logger.js';

export class CoordinatorClient {
  private baseUrl: string;
  private token: string | undefined;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const url = `${this.baseUrl}${path}`;
    logger.debug({ method, url }, 'Coordinator request');
    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async spawnAgent(
    targetBeaconId: string,
    opts?: {
      personaId?: string;
      task?: string;
      spawnId?: string;
    }
  ): Promise<unknown> {
    const res = await this.request('POST', '/api/spawn', {
      targetBeaconId,
      ...opts,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Spawn failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  async listBeacons(): Promise<unknown> {
    const res = await this.request('GET', '/api/beacons');
    if (!res.ok) {
      throw new Error(`List beacons failed (${res.status})`);
    }
    return res.json();
  }

  async listAgents(beaconId?: string): Promise<unknown> {
    const query = beaconId ? `?beaconId=${beaconId}` : '';
    const res = await this.request('GET', `/api/agents/location${query}`);
    if (!res.ok) {
      throw new Error(`List agents failed (${res.status})`);
    }
    return res.json();
  }

  async getSpawn(beaconId: string, spawnId: string): Promise<unknown> {
    const res = await this.request('GET', `/api/spawn/${beaconId}/${spawnId}`);
    if (!res.ok) {
      throw new Error(`Get spawn failed (${res.status})`);
    }
    return res.json();
  }

  async listSpawns(beaconId: string, status?: string): Promise<unknown> {
    const query = status ? `?status=${status}` : '';
    const res = await this.request('GET', `/api/spawn/${beaconId}${query}`);
    if (!res.ok) {
      throw new Error(`List spawns failed (${res.status})`);
    }
    return res.json();
  }

  async terminateSpawn(beaconId: string, spawnId: string): Promise<unknown> {
    const res = await this.request(
      'DELETE',
      `/api/spawn/${beaconId}/${spawnId}`
    );
    if (!res.ok) {
      throw new Error(`Terminate spawn failed (${res.status})`);
    }
    return res.json();
  }

  /**
   * Send a message to an agent via the coordinator's message relay.
   */
  async sendMessage(agentId: string, message: string): Promise<unknown> {
    const res = await this.request('POST', '/api/messages/relay', {
      toAgentId: agentId,
      body: JSON.stringify({ type: 'chat', text: message }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Send message failed (${res.status}): ${text}`);
    }
    return res.json();
  }
}
