import type { DroneSlashCommandSessionManager } from 'drone-core';

export type SyntheticToolExchange = {
  toolName: string;
  toolCallId: string;
  arguments?: Record<string, unknown>;
  content: string;
};

/**
 * Append a synthetic assistant tool-call and its matching tool result as one
 * pair. Both halves carry the SAME toolCallId, so OpenAI-family providers
 * (strict about tool_call_id) always accept the exchange. Use this instead of
 * a bare appendToolResult whenever the result stands alone (no real LLM tool
 * call precedes it).
 */
export function appendSyntheticToolExchange(
  sessionManager: DroneSlashCommandSessionManager,
  exchange: SyntheticToolExchange
): void {
  const { toolName, toolCallId, content } = exchange;
  sessionManager.appendAssistantMessage('', [
    {
      id: toolCallId,
      name: toolName,
      arguments: exchange.arguments ?? {},
    },
  ]);
  sessionManager.appendToolResult(toolName, content, toolCallId);
}
