import type { DronePlugin } from 'drone-core';

type FetchInput = {
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  limit?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFetchInput(input: Record<string, unknown>): FetchInput {
  if (!isRecord(input)) {
    throw new Error('fetch.request expected an object input.');
  }

  if (typeof input.url !== 'string' || input.url.trim().length === 0) {
    throw new Error('fetch.request requires a non-empty string url.');
  }

  const method = input.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') {
    throw new Error('fetch.request method must be GET or POST.');
  }

  if (input.body !== undefined && typeof input.body !== 'string') {
    throw new Error('fetch.request body must be a string when provided.');
  }

  if (input.headers !== undefined && !isRecord(input.headers)) {
    throw new Error('fetch.request headers must be an object when provided.');
  }

  if (input.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isFinite(input.limit) ||
      input.limit <= 0
    ) {
      throw new Error(
        'fetch.request limit must be a positive number when provided.'
      );
    }
  }

  return {
    url: input.url as string,
    method: method as 'GET' | 'POST',
    body: input.body as string | undefined,
    headers: input.headers as Record<string, string> | undefined,
    limit: input.limit as number | undefined,
  };
}

async function makeRequest(input: FetchInput): Promise<string> {
  const options: RequestInit = {
    method: input.method ?? 'GET',
    headers: input.headers,
  };

  if (input.body) {
    options.body = input.body;
  }

  const response = await fetch(input.url, options);
  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  let text = await response.text();
  if (input.limit && text.length > input.limit) {
    text = text.slice(0, input.limit) + '\n... (truncated)';
  }

  return JSON.stringify(
    {
      status: response.status,
      url: input.url,
      size: text.length,
      data: text,
    },
    null,
    2
  );
}

export const fetchPlugin: DronePlugin = {
  metadata: {
    id: 'fetch',
    name: 'Fetch',
    version: '0.1.0',
    description: 'Fetch data from HTTP endpoints.',
    defaultEnabled: false,
  },
  register: async registration => {
    registration.registerTool({
      name: 'request',
      description: 'HTTP GET/POST. Returns body (truncated to limit chars).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch.' },
          method: { type: 'string', description: 'GET (default) or POST.' },
          body: { type: 'string', description: 'Request body (POST).' },
          headers: { type: 'object', description: 'Custom headers.', additionalProperties: true },
          limit: { type: 'number', description: 'Max response size in chars.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      execute: async input => makeRequest(parseFetchInput(input)),
    });

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('fetch tool ready');
    });
  },
};
