/**
 * Sanitize one segment of an LLM-facing tool name.
 *
 * drone-agent's canonical tool names use `__` as the structural separator
 * between the plugin id and the tool name (ADR 028). A dot *inside* a tool
 * name is unsafe: the Kimi K2 tool-call parser treats the dot as structural
 * (`functions.{name}:{idx}`) and hallucinates a truncated tool name. Every
 * character outside `[a-zA-Z0-9_-]` — notably `.` — is replaced with `_`, so a
 * capability named `card.move` becomes the tool segment `card_move`.
 *
 * When two segments sanitize to the same string, a numeric suffix keeps them
 * distinct instead of letting one silently overwrite the other.
 */
export function sanitizeToolSegment(
  name: string,
  usedNames: Set<string>
): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!usedNames.has(sanitized)) {
    usedNames.add(sanitized);
    return sanitized;
  }
  let counter = 1;
  while (usedNames.has(`${sanitized}_${counter}`)) {
    counter++;
  }
  const result = `${sanitized}_${counter}`;
  usedNames.add(result);
  return result;
}
