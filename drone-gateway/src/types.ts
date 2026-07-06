// === Service Adapter Interface ===

export interface DroneServiceAdapter {
  id: string;
  type: string; // "matrix", "telegram", "slack"
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  onMessage(handler: (message: AdapterMessage) => void): void;
}

export interface AdapterMessage {
  adapterId: string;
  conversationId: string;
  text: string;
  senderId?: string;
  senderName?: string;
}

// === Control Surface Interface ===

export interface DroneControlSurface {
  id: string;
  type: string; // "persona-assignment", "swarm-console", "mention-router"
  handleMessage(
    message: AdapterMessage
  ): Promise<{ response: string | null; handled: boolean }>;
}

// === Config Types ===

export interface ServiceAdapterConfig {
  id: string;
  type: string;
  config: Record<string, unknown>;
  controlSurfaces: ControlSurfaceConfig[];
}

export interface ControlSurfaceConfig {
  type: string;
  conversationId: string;
  personaId?: string; // for persona-assignment
}

export interface GatewayConfig {
  coordinatorUrl: string;
  coordinatorToken?: string;
  serviceAdapters: ServiceAdapterConfig[];
}
