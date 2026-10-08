// ── MCP Prompt Fragments ─────────────────────────────────────────────
//
// Two rendered sections that teach the LLM which MCP servers exist and
// how to reach their tools:
//
//   - renderServerSection  → header fragment (`# MCP Servers`)
//   - renderStatusSection  → footer fragment (non-connected servers only)
//
// The split is deliberate: the header carries stable content so it stays
// in the cached prompt prefix, while connection status is volatile and
// rides the footer (which is re-rendered per turn).
//
// -----------------------------------------------------------------------

import type { DroneMcpServerState } from 'drone-core';

export type McpServerSummary = {
  id: string;
  state: DroneMcpServerState;
  description?: string;
  availableToolCount: number;
};

const LIST_TOOLS_REMINDER =
  'MCP tools must be mounted before use. Call `runtime__list_tools` with ' +
  '`{"plugin":"mcp"}` to see a server\'s tools. If a tool you expect from a ' +
  'server below is missing, list it again — the list may be stale, or the ' +
  'tool may be named differently.';

export function renderServerSection(
  summaries: McpServerSummary[]
): string | false {
  if (summaries.length === 0) return false;
  const lines = summaries.map(s => {
    const n = s.availableToolCount;
    const count = `(${n} tool${n === 1 ? '' : 's'})`;
    const prose = s.description ? `: ${s.description}` : '';
    return `- ${s.id} ${count}${prose}`;
  });
  return `# MCP Servers\n\n${LIST_TOOLS_REMINDER}\n\n${lines.join('\n')}`;
}

export function renderStatusSection(
  summaries: McpServerSummary[]
): string | false {
  const unhealthy = summaries.filter(s => s.state.status !== 'connected');
  if (unhealthy.length === 0) return false;
  const lines = unhealthy.map(s => {
    const detail = s.state.lastError ? ` — ${s.state.lastError}` : '';
    return `- ${s.id}: ${s.state.status}${detail}`;
  });
  return `# MCP Servers (not connected)\n\n${lines.join('\n')}`;
}
