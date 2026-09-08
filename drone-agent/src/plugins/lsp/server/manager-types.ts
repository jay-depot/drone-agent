import type { DroneLspConfig, DroneLogger } from 'drone-core';
import type { ServerRuntime, DocumentState } from './types.js';
import type {
  ReferenceLocation,
  ReferenceResolution,
} from './reference-cache.js';

export type ResolvedPosition = {
  runtime: ServerRuntime;
  document: DocumentState;
  line: number;
  column: number;
};

export type ServerManager = {
  initialize: () => Promise<void>;
  refreshIfNeeded: () => Promise<void>;
  markDirty: () => void;
  getDiagnostics: () => import('drone-core').DroneLspDiagnostic[];
  getServerStates: () => import('drone-core').DroneLspServerState[];
  renderDiagnosticsPrompt: () => string | false;
  getAvailableServers: () => Array<{
    id: string;
    language: string;
    fileExtensions: string[];
    status: 'available';
  }>;
  startServerForFile: (filePath: string) => Promise<boolean>;
  findRuntimeForFile: (filePath: string) => ServerRuntime | undefined;
  requireRuntimeForFile: (filePath: string) => Promise<ServerRuntime>;
  ensureDocumentLoaded: (
    runtime: ServerRuntime,
    filePath: string
  ) => Promise<DocumentState>;
  resolveTargetFilePath: (inputPath: string) => string;
  parsePositionInput: (
    toolName: string,
    input: Record<string, unknown>,
    surroundingText?: string
  ) => Promise<{ filePath: string; line: number; column: number }>;
  resolveAtPosition: (
    toolName: string,
    input: Record<string, unknown>,
    surroundingText?: string
  ) => Promise<ResolvedPosition>;
  readFileSnippet: (
    filePath: string,
    line: number,
    contextLines?: number
  ) => Promise<string>;
  readLineFingerprint: (
    filePath: string,
    line: number
  ) => Promise<string | undefined>;
  storeReferences: (locations: ReferenceLocation[]) => Promise<string[]>;
  resolveReference: (
    referenceId: string
  ) => Promise<ReferenceResolution | undefined>;
  locationToAgentShape: (
    locations: Array<{
      filePath: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
  ) => Array<{
    filePath: string;
    line: number;
    column: number;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  }>;
  shutdown: () => Promise<void>;
};

export type CreateServerManagerOptions = {
  workspaceRoot: string;
  lspConfig: DroneLspConfig;
  logger: DroneLogger;
};
