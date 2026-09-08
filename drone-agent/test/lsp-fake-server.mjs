#!/usr/bin/env node
/**
 * Minimal wire-level fake LSP server for tests. Speaks Content-Length
 * framed JSON-RPC on stdio. Behavior is driven by a scenario JSON file
 * passed as argv[2] (written by the test):
 *
 * {
 *   respondToInitialize: true,   // reply to `initialize` with capabilities
 *   exitAfterInitialize: bool,   // exit(0) right after the initialize reply
 *   exitOnMethod: string,        // exit(7) when this method arrives (before replying)
 *   hangOnMethod: string,        // never reply to this method (keeps running)
 *   results: { [method]: unknown } // canned results; unknown methods get []
 * }
 *
 * Emits a raw `READY\n` line on stdout before entering the framing loop
 * (the parent harness uses it as the spawn barrier).
 */

const scenarioPath = process.argv[2];
const scenario = JSON.parse(
  await import('node:fs/promises').then(fs => fs.readFile(scenarioPath, 'utf8'))
);

if (Array.isArray(scenario.stderrLines)) {
  for (const line of scenario.stderrLines) {
    process.stderr.write(`${line}\n`);
  }
}
process.stderr.write('READY\n');

let buffer = Buffer.alloc(0);

function frame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  process.stdout.write(
    `Content-Length: ${body.length}\r\n\r\n${body.toString('utf8')}`
  );
}

function handle(message) {
  if (message.id === undefined || message.method === undefined) {
    return;
  }
  if (message.method === 'initialize') {
    if (scenario.respondToInitialize) {
      frame({
        jsonrpc: '2.0',
        id: message.id,
        result: { capabilities: { textDocumentSync: 1 } },
      });
      if (scenario.exitAfterInitialize) {
        process.exit(0);
      }
      return;
    }
    process.exit(6);
  }
  if (scenario.exitOnMethod === message.method) {
    process.exit(7);
  }
  if (scenario.hangOnMethod === message.method) {
    return;
  }
  frame({
    jsonrpc: '2.0',
    id: message.id,
    result: scenario.results?.[message.method] ?? [],
  });
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      break;
    }
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const lengthLine = header
      .split('\r\n')
      .find(line => line.toLowerCase().startsWith('content-length:'));
    const length = Number(lengthLine?.split(':')[1]?.trim());
    if (!Number.isFinite(length)) {
      process.exit(5);
    }
    const start = headerEnd + 4;
    if (buffer.length < start + length) {
      break;
    }
    const body = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    try {
      handle(JSON.parse(body));
    } catch {
      process.exit(4);
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
