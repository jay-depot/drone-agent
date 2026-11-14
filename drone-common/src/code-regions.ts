/**
 * One run of markdown text. `code` marks a code region.
 */
type CodeSegment = { code: boolean; text: string };

/** An opening fence: up to 3 spaces, then 3+ backticks or tildes. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** A closing fence: up to 3 spaces, then 3+ backticks or tildes, then only space. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Length of the run of `text[index]` that starts at `index`. */
function runLengthAt(text: string, index: number): number {
  const ch = text[index];
  let n = 0;
  while (text[index + n] === ch) n++;
  return n;
}

/** Index of the next run of exactly `length` copies of `ch`, or -1. */
function findRunOfLength(
  text: string,
  from: number,
  ch: string,
  length: number
): number {
  let i = from;
  while (i < text.length) {
    if (text[i] !== ch) {
      i++;
      continue;
    }
    const n = runLengthAt(text, i);
    if (n === length) return i;
    i += n;
  }
  return -1;
}

/** Split one non-fence run into text and inline-code segments. */
function splitInlineCode(text: string): CodeSegment[] {
  const out: CodeSegment[] = [];
  let plainStart = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    const open = runLengthAt(text, i);
    const close = findRunOfLength(text, i + open, '`', open);
    if (close === -1) {
      i += open;
      continue;
    }
    if (i > plainStart) {
      out.push({ code: false, text: text.slice(plainStart, i) });
    }
    out.push({ code: true, text: text.slice(i, close + open) });
    i = close + open;
    plainStart = i;
  }
  if (plainStart < text.length) {
    out.push({ code: false, text: text.slice(plainStart) });
  }
  return out;
}

/**
 * Split markdown into code and non-code runs.
 *
 * Code runs are fenced blocks (backtick or tilde) and inline code spans.
 * An unterminated fence runs to the end of the document.
 * A backtick run with no matching closer stays literal text.
 */
function segmentCodeRegions(markdown: string): CodeSegment[] {
  const out: CodeSegment[] = [];
  const lines = markdown.split('\n');
  let open: { char: string; length: number } | null = null;
  let text = '';
  let code = '';

  const flushText = () => {
    if (text.length === 0) return;
    out.push(...splitInlineCode(text));
    text = '';
  };
  const flushCode = () => {
    if (code.length === 0) return;
    out.push({ code: true, text: code });
    code = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const eol = i < lines.length - 1 ? '\n' : '';

    if (open) {
      code += raw + eol;
      const close = FENCE_CLOSE.exec(raw);
      if (
        close &&
        close[1][0] === open.char &&
        close[1].length >= open.length
      ) {
        flushCode();
        open = null;
      }
      continue;
    }

    const openMatch = FENCE_OPEN.exec(raw);
    if (openMatch) {
      flushText();
      open = { char: openMatch[1][0], length: openMatch[1].length };
      code += raw + eol;
      continue;
    }

    text += raw + eol;
  }

  flushText();
  flushCode();
  return out;
}

/**
 * Apply `fn` to every non-code run of `markdown`.
 *
 * Code runs are returned unchanged, byte for byte. A caller that renders the
 * result therefore keeps its code blocks intact.
 *
 * The rule lives here and nowhere else, so the node lint and the browser view
 * cannot disagree. If a caller ever needs the raw ranges, add a second export
 * then; there is no such caller today.
 */
export function transformOutsideCodeRegions(
  markdown: string,
  fn: (text: string) => string
): string {
  return segmentCodeRegions(markdown)
    .map(segment => (segment.code ? segment.text : fn(segment.text)))
    .join('');
}
