// ── Reference tokenizer ─────────────────────────────────────────────
//
// Splits a user message into text runs and `@`-reference tokens. The grammar:
//   - `@` starts a reference only at start-of-text or after whitespace, so
//     mid-word `@` (`user@host`) is left untouched.
//   - The token body is the maximal non-whitespace run, or the braced form
//     `@{path with spaces.md}`.
//   - `\@` escapes a literal `@` (the backslash is removed from emitted text).
//   - An empty body (`@` or `@{}`) is not a reference.
//   - A non-empty body carries a `kind` only when it has a `:` whose prefix is
//     a syntactically valid kind name (lowercase, dashes); otherwise it is a
//     plain file path (`kind: null`). Whether a syntactically valid kind is a
//     *known* kind is decided later by the expander.

export type ReferenceToken = {
  type: 'reference';
  raw: string;
  body: string;
  kind: string | null;
  value: string;
  start: number;
  end: number;
};

export type TextToken = { type: 'text'; text: string } | ReferenceToken;

const KIND_RE = /^[a-z][a-z0-9-]*$/;

/** `@` starts a reference only at start-of-text or after whitespace. */
function isBoundary(text: string, i: number): boolean {
  return i === 0 || /\s/.test(text[i - 1]);
}

function splitKind(body: string): { kind: string | null; value: string } {
  const colon = body.indexOf(':');
  if (colon > 0) {
    const prefix = body.slice(0, colon);
    if (KIND_RE.test(prefix)) {
      return { kind: prefix, value: body.slice(colon + 1) };
    }
  }
  return { kind: null, value: body };
}

/** Read a reference at `i` (which points at `@`). Returns null when not one. */
function readReference(text: string, i: number): ReferenceToken | null {
  let body: string | null = null;
  let end = i + 1;

  if (text[i + 1] === '{') {
    const close = text.indexOf('}', i + 2);
    if (close !== -1) {
      body = text.slice(i + 2, close);
      end = close + 1;
    }
  }

  if (body === null) {
    let j = i + 1;
    while (j < text.length && !/\s/.test(text[j])) {
      j += 1;
    }
    body = text.slice(i + 1, j);
    end = j;
  }

  if (body.length === 0) {
    return null;
  }

  const { kind, value } = splitKind(body);
  return {
    type: 'reference',
    raw: text.slice(i, end),
    body,
    kind,
    value,
    start: i,
    end,
  };
}

export function tokenizeText(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let textBuf = '';
  let i = 0;

  const flushText = (): void => {
    if (textBuf.length > 0) {
      tokens.push({ type: 'text', text: textBuf });
      textBuf = '';
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\' && text[i + 1] === '@') {
      textBuf += '@';
      i += 2;
      continue;
    }

    if (ch === '@' && isBoundary(text, i)) {
      const ref = readReference(text, i);
      if (ref) {
        flushText();
        tokens.push(ref);
        i = ref.end;
        continue;
      }
    }

    textBuf += ch;
    i += 1;
  }

  flushText();
  return tokens;
}
