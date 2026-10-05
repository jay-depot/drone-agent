import { logger } from './logger.js';
import type { SwarmApi } from './console/swarm-api.js';

export class CoordinatorClient implements SwarmApi {
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
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  private async getJson(path: string, failMessage: string): Promise<unknown> {
    const res = await this.request('GET', path);
    if (!res.ok) {
      throw new Error(`${failMessage} (${res.status})`);
    }
    return res.json();
  }

  private async mutate(
    method: string,
    path: string,
    body: unknown,
    failMessage: string,
    includeBody = false
  ): Promise<unknown> {
    const res = await this.request(method, path, body);
    if (!res.ok) {
      if (includeBody) {
        const text = await res.text();
        throw new Error(`${failMessage} (${res.status}): ${text}`);
      }
      throw new Error(`${failMessage} (${res.status})`);
    }
    return res.json();
  }

  private async getArray(
    path: string,
    failMessage: string
  ): Promise<unknown[]> {
    const data = await this.getJson(path, failMessage);
    return Array.isArray(data) ? data : [];
  }

  async spawnAgent(input: {
    targetBeaconId: string;
    personaId?: string;
    task?: string;
    spawnId?: string;
  }): Promise<unknown> {
    return this.mutate('POST', '/api/spawn', input, 'Spawn failed', true);
  }

  async listBeacons(): Promise<unknown[]> {
    return this.getArray('/api/beacons', 'List beacons failed');
  }

  async listSpawns(beaconId: string, status?: string): Promise<unknown[]> {
    const query = status ? `?status=${status}` : '';
    return this.getArray(
      `/api/spawn/${beaconId}${query}`,
      'List spawns failed'
    );
  }

  async terminateSpawn(beaconId: string, spawnId: string): Promise<unknown> {
    return this.mutate(
      'DELETE',
      `/api/spawn/${beaconId}/${spawnId}`,
      undefined,
      'Terminate spawn failed'
    );
  }

  /**
   * Send a message to an agent via the coordinator's message relay.
   */
  async sendMessage(agentId: string, message: string): Promise<unknown> {
    return this.mutate(
      'POST',
      '/api/messages/relay',
      {
        toAgentId: agentId,
        body: JSON.stringify({ type: 'chat', text: message }),
      },
      'Send message failed',
      true
    );
  }

  async listSessions(query?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ sessions: unknown[]; count: number }> {
    const params = new URLSearchParams();
    if (query?.status) params.set('status', query.status);
    if (query?.limit !== undefined) params.set('limit', String(query.limit));
    if (query?.offset !== undefined) params.set('offset', String(query.offset));
    const qs = params.toString();
    const data = (await this.getJson(
      `/api/sessions${qs ? `?${qs}` : ''}`,
      'List sessions failed'
    )) as { sessions?: unknown[]; count?: number };
    return {
      sessions: data.sessions ?? [],
      count: data.count ?? data.sessions?.length ?? 0,
    };
  }

  async getSession(id: string): Promise<unknown> {
    const data = (await this.getJson(
      `/api/sessions/${encodeURIComponent(id)}`,
      'Get session failed'
    )) as { session?: unknown };
    return data.session ?? data;
  }

  async sendSessionMessage(
    id: string,
    content: string,
    steer: boolean
  ): Promise<unknown> {
    return this.mutate(
      'POST',
      `/api/sessions/${encodeURIComponent(id)}/message`,
      { content, steer },
      'Send session message failed',
      true
    );
  }

  async setSessionPersona(
    id: string,
    personaId: string | null
  ): Promise<unknown> {
    return this.mutate(
      'PATCH',
      `/api/sessions/${encodeURIComponent(id)}/persona`,
      { personaId },
      'Set session persona failed',
      true
    );
  }

  async broadcast(input: {
    fromAgentId: string;
    channel: string;
    body: string;
  }): Promise<unknown> {
    return this.mutate(
      'POST',
      '/api/messages/broadcast',
      input,
      'Broadcast failed',
      true
    );
  }

  async listPersonas(): Promise<unknown[]> {
    return this.getArray('/api/personas', 'List personas failed');
  }

  async createPersona(input: {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
  }): Promise<unknown> {
    return this.mutate(
      'POST',
      '/api/personas',
      input,
      'Create persona failed',
      true
    );
  }

  async updatePersona(
    id: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    return this.mutate(
      'PUT',
      `/api/personas/${encodeURIComponent(id)}`,
      input,
      'Update persona failed',
      true
    );
  }

  async deletePersona(id: string): Promise<unknown> {
    return this.mutate(
      'DELETE',
      `/api/personas/${encodeURIComponent(id)}`,
      undefined,
      'Delete persona failed'
    );
  }

  async listSkills(): Promise<unknown[]> {
    return this.getArray('/api/skills', 'List skills failed');
  }

  async createSkill(input: {
    id: string;
    name: string;
    description: string;
    trigger: string;
    body: string;
  }): Promise<unknown> {
    return this.mutate(
      'POST',
      '/api/skills',
      input,
      'Create skill failed',
      true
    );
  }

  async updateSkill(
    id: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    return this.mutate(
      'PUT',
      `/api/skills/${encodeURIComponent(id)}`,
      input,
      'Update skill failed',
      true
    );
  }

  async deleteSkill(id: string): Promise<unknown> {
    return this.mutate(
      'DELETE',
      `/api/skills/${encodeURIComponent(id)}`,
      undefined,
      'Delete skill failed'
    );
  }
}
