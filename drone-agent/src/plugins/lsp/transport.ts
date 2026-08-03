import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { type Socket } from 'node:net';

const HEADER_SEPARATOR = '\r\n\r\n';

type JsonRpcId = number;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
};

export type RpcTransport = {
  write: (payload: string) => void;
  close: () => void;
  onData: (callback: (chunk: Buffer) => void) => void;
  onClose: (callback: (reason: string) => void) => void;
  onError: (callback: (error: Error) => void) => void;
};

export type JsonRpcClient = {
  request: <T>(method: string, params?: unknown) => Promise<T>;
  notify: (method: string, params?: unknown) => void;
  disconnect: (reason?: string) => void;
};

export function createChildTransport(
  childProcess: ChildProcessWithoutNullStreams
): RpcTransport {
  return {
    write: payload => {
      childProcess.stdin.write(payload);
    },
    close: () => {
      childProcess.stdin.end();
    },
    onData: callback => {
      childProcess.stdout.on('data', callback);
    },
    onClose: callback => {
      childProcess.on('close', (code, signal) => {
        const reason =
          code !== null
            ? `child process exited with code ${code}`
            : `child process exited with signal ${signal ?? 'unknown'}`;
        callback(reason);
      });
    },
    onError: callback => {
      childProcess.on('error', callback);
      // stderr is not treated as a transport error — many LSP servers
      // log diagnostic information to stderr (e.g., taplo prints
      // "registered request handler method=\"initialize\"").
    },
  };
}

export function createSocketTransport(socket: Socket): RpcTransport {
  return {
    write: payload => {
      socket.write(payload);
    },
    close: () => {
      socket.end();
    },
    onData: callback => {
      socket.on('data', callback);
    },
    onClose: callback => {
      socket.on('close', hadError => {
        callback(
          hadError ? 'socket closed after transport error' : 'socket closed'
        );
      });
    },
    onError: callback => {
      socket.on('error', callback);
    },
  };
}

export function createJsonRpcClient(options: {
  transport: RpcTransport;
  requestTimeoutMs: number;
  onNotification: (method: string, params: unknown) => void;
  onTransportIssue: (message: string) => void;
}): JsonRpcClient {
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let closed = false;
  const pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function rejectPending(reason: string): void {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function markClosed(reason: string): void {
    if (closed) {
      return;
    }
    closed = true;
    rejectPending(reason);
    options.onTransportIssue(reason);
  }

  function sendMessage(message: JsonRpcMessage): void {
    if (closed) {
      throw new Error('LSP transport is closed.');
    }

    const payload = JSON.stringify({ jsonrpc: '2.0', ...message });
    options.transport.write(
      `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`
    );
  }

  function tryParseMessages(): void {
    while (true) {
      const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) {
        return;
      }

      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const contentLengthLine = header
        .split('\r\n')
        .find(line => line.toLowerCase().startsWith('content-length:'));
      if (!contentLengthLine) {
        markClosed('LSP transport received a message without Content-Length.');
        options.transport.close();
        return;
      }

      const contentLengthValue = contentLengthLine.split(':')[1]?.trim();
      const contentLength = Number(contentLengthValue);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        markClosed('LSP transport received an invalid Content-Length header.');
        options.transport.close();
        return;
      }

      const messageStart = headerEnd + HEADER_SEPARATOR.length;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) {
        return;
      }

      const payload = buffer
        .subarray(messageStart, messageEnd)
        .toString('utf8');
      buffer = buffer.subarray(messageEnd);

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(payload) as JsonRpcMessage;
      } catch {
        markClosed('LSP transport received invalid JSON.');
        options.transport.close();
        return;
      }

      if (typeof message.method === 'string' && message.id === undefined) {
        options.onNotification(message.method, message.params);
        continue;
      }

      if (typeof message.id === 'number') {
        const entry = pending.get(message.id);
        if (!entry) {
          continue;
        }
        clearTimeout(entry.timer);
        pending.delete(message.id);

        if (message.error) {
          entry.reject(
            new Error(`LSP ${message.error.code}: ${message.error.message}`)
          );
          continue;
        }

        entry.resolve(message.result);
      }
    }
  }

  options.transport.onData(chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    tryParseMessages();
  });
  options.transport.onError(error => {
    markClosed(error.message);
  });
  options.transport.onClose(reason => {
    markClosed(reason);
  });

  return {
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      if (closed) {
        throw new Error('LSP transport is closed.');
      }

      const id = nextId;
      nextId += 1;

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`LSP request timed out: ${method}`));
        }, options.requestTimeoutMs);
        pending.set(id, {
          resolve: value => resolve(value as T),
          reject,
          timer,
        });

        try {
          sendMessage({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify: (method: string, params?: unknown) => {
      if (closed) {
        return;
      }
      sendMessage({ method, params });
    },
    disconnect: (reason = 'transport closed') => {
      markClosed(reason);
      options.transport.close();
    },
  };
}
