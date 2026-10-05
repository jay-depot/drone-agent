/**
 * The abstract coordinator surface the swarm-console command handlers depend
 * on. Handlers never touch a concrete HTTP client, so a future promotion of the
 * command layer to a coordinator-side "command bus" is a move, not a rewrite.
 */
export interface SwarmApi {
  listBeacons(): Promise<unknown[]>;
  listSpawns(beaconId: string): Promise<unknown[]>;
  terminateSpawn(beaconId: string, spawnId: string): Promise<unknown>;
  spawnAgent(input: {
    targetBeaconId: string;
    personaId?: string;
    task?: string;
    spawnId?: string;
  }): Promise<unknown>;
  listSessions(query?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ sessions: unknown[]; count: number }>;
  getSession(id: string): Promise<unknown>;
  sendSessionMessage(
    id: string,
    content: string,
    steer: boolean
  ): Promise<unknown>;
  setSessionPersona(id: string, personaId: string | null): Promise<unknown>;
  broadcast(input: {
    fromAgentId: string;
    channel: string;
    body: string;
  }): Promise<unknown>;
  listPersonas(): Promise<unknown[]>;
  createPersona(input: {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
  }): Promise<unknown>;
  updatePersona(id: string, input: Record<string, unknown>): Promise<unknown>;
  deletePersona(id: string): Promise<unknown>;
  listSkills(): Promise<unknown[]>;
  createSkill(input: {
    id: string;
    name: string;
    description: string;
    trigger: string;
    body: string;
  }): Promise<unknown>;
  updateSkill(id: string, input: Record<string, unknown>): Promise<unknown>;
  deleteSkill(id: string): Promise<unknown>;
}
