export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface Beacon {
  id: string;
  name: string;
  host: string;
  port: number;
  connectedAt: number;
  lastHeartbeat: number;
}

export interface CreatePersonaRequest {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

export interface CreateSkillRequest {
  id: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
}

export interface RegisterBeaconRequest {
  id: string;
  name: string;
  host: string;
  port: number;
}