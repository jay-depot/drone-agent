import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { type Socket } from 'node:net';
import type { ChildProcessTransport, JsonRpcClient } from '../transport.js';

export type DocumentState = {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  mtimeMs: number;
  size: number;
};

export type ServerRuntime = {
  id: string;
  language: string;
  transport: 'stdio' | 'tcp';
  ownership: 'spawned' | 'external';
  detail: string;
  fileExtensions: string[];
  client: JsonRpcClient;
  documents: Map<string, DocumentState>;
  childProcess?: ChildProcessWithoutNullStreams;
  childTransport?: ChildProcessTransport;
  socket?: Socket;
};
