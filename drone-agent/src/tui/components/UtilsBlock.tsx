import { Text } from 'ink';
import type { ReactNode } from 'react';
import type { DroneColorScheme } from '../theme.js';
import type { ToolRenderState } from 'drone-core';
import { tryParseJson } from '../shared/format.js';

/** Parse a JSON string that may be an array (tryParseJson rejects arrays). */
function tryParseAny(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function UtilsBlock({ state }: { state: ToolRenderState }): ReactNode {
  const scheme = state.scheme as DroneColorScheme;

  if (state.status === 'running') {
    const args = state.arguments;
    const op =
      typeof args.operation === 'string'
        ? args.operation
        : typeof args.expression === 'string'
          ? args.expression
          : '';
    return (
      <Text color={scheme.toolCall} wrap="wrap">
        {`… ${state.name}(${op})`}
      </Text>
    );
  }

  if (state.status === 'error') {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ ${state.name}: ${state.result ?? ''}`}
      </Text>
    );
  }

  const result = state.result ?? '';

  // Handle spell operation: returns a JSON array like ["s","t","r"]
  if (state.arguments.operation === 'spell') {
    const parsed: unknown = tryParseAny(result);
    if (Array.isArray(parsed)) {
      const spelled = (parsed as string[]).join(' ');
      return (
        <Text color={scheme.toolResult} wrap="wrap">
          {`✓ string: spell → ${spelled}`}
        </Text>
      );
    }
    return (
      <Text color={scheme.toolResult} wrap="wrap">
        {`✓ ${result}`}
      </Text>
    );
  }

  const parsed = tryParseJson(result);
  if (!parsed) {
    return (
      <Text color={scheme.toolResult} wrap="wrap">
        {`✓ ${result}`}
      </Text>
    );
  }

  // calculator result
  if (parsed.ok === true && typeof parsed.expression === 'string') {
    const expr = parsed.expression as string;
    const res = parsed.result as number;
    return (
      <Text color={scheme.toolResult} wrap="wrap">
        {`✓ calculator: "${expr}" = ${res}`}
      </Text>
    );
  }

  if (parsed.ok === false) {
    return (
      <Text color={scheme.error} wrap="wrap">
        {`✗ calculator: ${(parsed.message as string) ?? 'error'}`}
      </Text>
    );
  }

  // string result
  if (parsed.success === true) {
    const op = state.arguments.operation as string | undefined;
    switch (op) {
      case 'count_words':
        return (
          <Text color={scheme.toolResult} wrap="wrap">
            {`✓ string: count_words → ${parsed.totalWords as number} words`}
          </Text>
        );
      case 'count_letters':
        return (
          <Text color={scheme.toolResult} wrap="wrap">
            {`✓ string: count_letters → ${parsed.totalLetters as number} letters`}
          </Text>
        );
      case 'count_characters':
        return (
          <Text color={scheme.toolResult} wrap="wrap">
            {`✓ string: count_characters → ${parsed.totalCharacters as number} characters`}
          </Text>
        );
      case 'count_lines':
        return (
          <Text color={scheme.toolResult} wrap="wrap">
            {`✓ string: count_lines → ${parsed.totalLines as number} lines`}
          </Text>
        );
      case 'count_unique_words':
        return (
          <Text color={scheme.toolResult} wrap="wrap">
            {`✓ string: count_unique_words → ${parsed.uniqueWords as number} unique (${parsed.totalWords as number} total)`}
          </Text>
        );
      case 'count_sentences_paragraphs':
        return (
          <Text color={scheme.toolResult} wrap="wrap">
            {`✓ string: count_sentences_paragraphs → ${parsed.totalSentences as number} sentences, ${parsed.totalParagraphs as number} paragraphs`}
          </Text>
        );
      default:
        return (
          <Text color={scheme.toolResult} wrap="wrap">
            {`✓ string: ${op ?? 'ok'}`}
          </Text>
        );
    }
  }

  return (
    <Text color={scheme.toolResult} wrap="wrap">
      {`✓ ${result}`}
    </Text>
  );
}
