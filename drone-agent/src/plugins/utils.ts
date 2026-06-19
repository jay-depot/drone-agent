import type { DronePlugin } from 'drone-core';

// Text normalization helpers
function tokenizeWords(text: string): string[] {
  const lower = text.toLowerCase();
  return lower.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function extractLetters(text: string): string[] {
  const lower = text.toLowerCase();
  return lower.match(/[\p{L}]/gu) ?? [];
}

function countNonWhitespaceCharacters(text: string): number {
  return Array.from(text).filter(char => !/\s/u.test(char)).length;
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split(/\r?\n/u).length;
}

function countSentences(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed
    .split(/[.!?]+/u)
    .map(segment => segment.trim())
    .filter(segment => /[\p{L}\p{N}]/u.test(segment)).length;
}

function countParagraphs(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed
    .split(/(?:\r?\n\s*){2,}/u)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0).length;
}

// Arithmetic evaluator
type NumberToken = {
  type: 'number';
  value: number;
  text: string;
  position: number;
};

type OperatorToken = {
  type: 'operator';
  value: '+' | '-' | '*' | '/' | '^';
  position: number;
};

type ParenToken = {
  type: 'lparen' | 'rparen';
  position: number;
};

type Token = NumberToken | OperatorToken | ParenToken;

function evaluateArithmeticExpression(expression: string):
  | {
      ok: true;
      expression: string;
      normalizedExpression: string;
      result: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
      position?: number;
    } {
  // Tokenize
  const tokens: Token[] = [];
  let i = 0;

  while (i < expression.length) {
    const char = expression[i];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === '(') {
      tokens.push({ type: 'lparen', position: i });
      i += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ type: 'rparen', position: i });
      i += 1;
      continue;
    }

    if (
      char === '+' ||
      char === '-' ||
      char === '*' ||
      char === '/' ||
      char === '^'
    ) {
      tokens.push({ type: 'operator', value: char, position: i });
      i += 1;
      continue;
    }

    if (/\d|\./.test(char)) {
      const start = i;
      let hasDot = false;
      let sawDigit = false;

      while (i < expression.length) {
        const inner = expression[i];
        if (/\d/.test(inner)) {
          sawDigit = true;
          i += 1;
          continue;
        }

        if (inner === '.') {
          if (hasDot) {
            return {
              ok: false,
              code: 'INVALID_NUMBER',
              message: 'Invalid number literal with multiple decimal points.',
              position: i,
            };
          }
          hasDot = true;
          i += 1;
          continue;
        }

        break;
      }

      if (!sawDigit) {
        return {
          ok: false,
          code: 'INVALID_NUMBER',
          message: 'Invalid number literal.',
          position: start,
        };
      }

      const text = expression.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        return {
          ok: false,
          code: 'INVALID_NUMBER',
          message: 'Number literal is not finite.',
          position: start,
        };
      }

      tokens.push({ type: 'number', value, text, position: start });
      continue;
    }

    return {
      ok: false,
      code: 'INVALID_TOKEN',
      message: `Invalid token "${char}" in expression.`,
      position: i,
    };
  }

  if (tokens.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_EXPRESSION',
      message: 'Expression is empty.',
    };
  }

  // Parse and evaluate with recursive descent
  let cursor = 0;

  function current(): Token | undefined {
    return tokens[cursor];
  }

  function advance(): void {
    cursor += 1;
  }

  function parseExpression(): number {
    let left = parseTerm();

    while (true) {
      const token = current();
      if (!token || token.type !== 'operator') {
        break;
      }
      if (token.value !== '+' && token.value !== '-') {
        break;
      }

      const op = token.value;
      advance();
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }

    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();

    while (true) {
      const token = current();
      if (!token || token.type !== 'operator') {
        break;
      }
      if (token.value !== '*' && token.value !== '/') {
        break;
      }

      const op = token.value;
      advance();
      const right = parseFactor();
      if (op === '/') {
        if (right === 0) {
          throw new Error('DIVISION_BY_ZERO');
        }
        left = left / right;
      } else {
        left = left * right;
      }
    }

    return left;
  }

  function parseFactor(): number {
    const token = current();

    if (
      token?.type === 'operator' &&
      (token.value === '+' || token.value === '-')
    ) {
      const op = token.value;
      advance();
      const value = parseFactor();
      return op === '-' ? -value : value;
    }

    return parsePower();
  }

  function parsePower(): number {
    let left = parsePrimary();

    const token = current();
    if (token?.type === 'operator' && token.value === '^') {
      advance();
      const right = parseFactor();
      left = Math.pow(left, right);
    }

    return left;
  }

  function parsePrimary(): number {
    const token = current();

    if (!token) {
      throw new Error('UNEXPECTED_TOKEN');
    }

    if (token.type === 'number') {
      advance();
      return token.value;
    }

    if (token.type === 'lparen') {
      advance();
      const value = parseExpression();
      const closingToken = current();
      if (!closingToken || closingToken.type !== 'rparen') {
        throw new Error('MISSING_CLOSING_PAREN');
      }
      advance();
      return value;
    }

    throw new Error('UNEXPECTED_TOKEN');
  }

  try {
    const result = parseExpression();
    const trailing = current();
    if (trailing) {
      return {
        ok: false,
        code: 'UNEXPECTED_TOKEN',
        message: 'Unexpected token after valid expression.',
        position: trailing.position,
      };
    }

    if (!Number.isFinite(result)) {
      return {
        ok: false,
        code: 'NON_FINITE_RESULT',
        message: 'Expression result is not finite.',
      };
    }

    return {
      ok: true,
      expression,
      normalizedExpression: expression.replace(/\s/g, ''),
      result,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: msg,
      message: `Evaluation failed: ${msg}`,
    };
  }
}

export const utilsPlugin: DronePlugin = {
  metadata: {
    id: 'utils',
    name: 'Utils',
    version: '0.1.0',
    description: 'Deterministic utility tools for arithmetic and text metrics.',
    defaultEnabled: false,
  },
  register: async registration => {
    registration.registerTool({
      name: 'evaluate_arithmetic',
      description:
        'Evaluates arithmetic expressions deterministically with proper operator precedence.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description:
              'Mathematical expression to evaluate. Supports +, -, *, /, ^, parentheses, decimals.',
          },
        },
        required: ['expression'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.expression !== 'string') {
          throw new Error('expression must be a string.');
        }
        const result = evaluateArithmeticExpression(input.expression);
        return JSON.stringify(result, null, 2);
      },
    });

    registration.registerTool({
      name: 'count_words',
      description: 'Counts words in text with case-insensitive normalization.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to analyze for word count.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.text !== 'string') {
          throw new Error('text must be a string.');
        }
        const words = tokenizeWords(input.text);
        return JSON.stringify(
          { success: true, totalWords: words.length },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'count_letters',
      description: 'Counts letters in text (case-insensitive).',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to analyze for letter count.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.text !== 'string') {
          throw new Error('text must be a string.');
        }
        const letters = extractLetters(input.text);
        return JSON.stringify(
          { success: true, totalLetters: letters.length },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'count_characters',
      description: 'Counts non-whitespace characters in text.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to analyze for character count.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.text !== 'string') {
          throw new Error('text must be a string.');
        }
        const count = countNonWhitespaceCharacters(input.text);
        return JSON.stringify(
          { success: true, totalCharacters: count },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'count_lines',
      description: 'Counts lines in text.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to analyze for line count.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.text !== 'string') {
          throw new Error('text must be a string.');
        }
        const count = countLines(input.text);
        return JSON.stringify({ success: true, totalLines: count }, null, 2);
      },
    });

    registration.registerTool({
      name: 'count_unique_words',
      description: 'Counts unique words in text.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to analyze for unique word count.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.text !== 'string') {
          throw new Error('text must be a string.');
        }
        const words = tokenizeWords(input.text);
        const unique = new Set(words).size;
        return JSON.stringify(
          { success: true, uniqueWords: unique, totalWords: words.length },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'count_sentences_paragraphs',
      description: 'Counts sentences and paragraphs in text.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to analyze for sentence and paragraph counts.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.text !== 'string') {
          throw new Error('text must be a string.');
        }
        const sentences = countSentences(input.text);
        const paragraphs = countParagraphs(input.text);
        return JSON.stringify(
          {
            success: true,
            totalSentences: sentences,
            totalParagraphs: paragraphs,
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'spell',
      description:
        'Returns the character-by-character spelling of an input string.',
      inputSchema: {
        type: 'object',
        properties: {
          word: {
            type: 'string',
            description: 'String to spell out character by character.',
          },
        },
        required: ['word'],
        additionalProperties: false,
      },
      execute: async input => {
        if (typeof input.word !== 'string') {
          throw new Error('word must be a string.');
        }
        const chars = Array.from(input.word);
        return JSON.stringify(chars, null, 2);
      },
    });

    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info('utils tools ready');
    });
  },
};
