/**
 * Hybrid key-sequence encoder for terminal input.
 *
 * Parses an input string containing both raw text and named sequences
 * delimited by angle brackets (e.g. `<Enter>`, `<Ctrl-C>`, `<Escape>`).
 * Named sequences are translated to the corresponding byte sequences;
 * raw text passes through as-is. Use `<<` for a literal `<`.
 *
 * Examples:
 *   `echo hello<Enter>`        → `echo hello\n`
 *   `<Ctrl-C>`                 → `\x03`
 *   `ls<Enter>grep foo<Enter>` → `ls\ngrep foo\n`
 *   `<Up><Enter>`              → `\x1b[A\n`
 *   `<<raw>>`                  → `<raw>`
 */

// ---------------------------------------------------------------------------
// Named sequence mapping
// ---------------------------------------------------------------------------

const NAMED_SEQUENCES: Record<string, number[]> = {
  // Control characters
  'Enter': [0x0a],           // \n
  'Return': [0x0d],          // \r
  'Ctrl-C': [0x03],          // ^C
  'Ctrl-D': [0x04],          // ^D
  'Ctrl-Z': [0x1a],          // ^Z
  'Ctrl-A': [0x01],          // ^A
  'Ctrl-B': [0x02],          // ^B
  'Ctrl-E': [0x05],          // ^E
  'Ctrl-F': [0x06],          // ^F
  'Ctrl-G': [0x07],          // ^G
  'Ctrl-H': [0x08],          // ^H
  'Ctrl-I': [0x09],          // ^I
  'Ctrl-J': [0x0a],          // ^J
  'Ctrl-K': [0x0b],          // ^K
  'Ctrl-L': [0x0c],          // ^L
  'Ctrl-M': [0x0d],          // ^M
  'Ctrl-N': [0x0e],          // ^N
  'Ctrl-O': [0x0f],          // ^O
  'Ctrl-P': [0x10],          // ^P
  'Ctrl-Q': [0x11],          // ^Q
  'Ctrl-R': [0x12],          // ^R
  'Ctrl-S': [0x13],          // ^S
  'Ctrl-T': [0x14],          // ^T
  'Ctrl-U': [0x15],          // ^U
  'Ctrl-V': [0x16],          // ^V
  'Ctrl-W': [0x17],          // ^W
  'Ctrl-X': [0x18],          // ^X
  'Ctrl-Y': [0x19],          // ^Y
  'Escape': [0x1b],
  'Esc': [0x1b],
  'Tab': [0x09],             // \t
  'Backspace': [0x7f],       // DEL
  'Space': [0x20],           // ' '

  // Cursor / navigation
  'Up': [0x1b, 0x5b, 0x41],        // \x1b[A
  'Down': [0x1b, 0x5b, 0x42],      // \x1b[B
  'Right': [0x1b, 0x5b, 0x43],     // \x1b[C
  'Left': [0x1b, 0x5b, 0x44],      // \x1b[D

  // Editing
  'Delete': [0x1b, 0x5b, 0x33, 0x7e],   // \x1b[3~
  'Home': [0x1b, 0x5b, 0x48],           // \x1b[H
  'End': [0x1b, 0x5b, 0x46],            // \x1b[F
  'PageUp': [0x1b, 0x5b, 0x35, 0x7e],   // \x1b[5~
  'PageDown': [0x1b, 0x5b, 0x36, 0x7e], // \x1b[6~
  'Insert': [0x1b, 0x5b, 0x32, 0x7e],   // \x1b[2~

  // Function keys F1-F12
  'F1': [0x1b, 0x5b, 0x50],           // \x1b[P
  'F2': [0x1b, 0x5b, 0x51],           // \x1b[Q
  'F3': [0x1b, 0x5b, 0x52],           // \x1b[R
  'F4': [0x1b, 0x5b, 0x53],           // \x1b[S
  'F5': [0x1b, 0x5b, 0x31, 0x35, 0x7e],     // \x1b[15~
  'F6': [0x1b, 0x5b, 0x31, 0x37, 0x7e],     // \x1b[17~
  'F7': [0x1b, 0x5b, 0x31, 0x38, 0x7e],     // \x1b[18~
  'F8': [0x1b, 0x5b, 0x31, 0x39, 0x7e],     // \x1b[19~
  'F9': [0x1b, 0x5b, 0x32, 0x30, 0x7e],     // \x1b[20~
  'F10': [0x1b, 0x5b, 0x32, 0x31, 0x7e],    // \x1b[21~
  'F11': [0x1b, 0x5b, 0x32, 0x33, 0x7e],    // \x1b[23~
  'F12': [0x1b, 0x5b, 0x32, 0x34, 0x7e],    // \x1b[24~
};

// ---------------------------------------------------------------------------
// Alt-prefix sequences: <Alt-X> → \x1b X
// ---------------------------------------------------------------------------

const ALT_PREFIX_RE = /^Alt-([a-zA-Z0-9])$/;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Encode a string of raw text and named sequences into a Buffer of bytes.
 *
 * The parser tokenizes the input by scanning for `<` delimiters:
 *   - `<<` → literal `<`
 *   - `<Name>` → looked up in NAMED_SEQUENCES or parsed as `<Alt-X>`
 *   - Anything else passes through as raw UTF-8 text
 *   - Unrecognized named sequences pass through as raw text (including brackets)
 *
 * @param input - Hybrid input string (e.g. `"echo hello<Enter>"`)
 * @returns Buffer of bytes ready to write to a PTY
 */
export function encodeKeys(input: string): Buffer {
  const parts: number[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === '<') {
      // Check for escaped literal `<<`
      if (i + 1 < input.length && input[i + 1] === '<') {
        parts.push(0x3c); // '<'
        i += 2;
        continue;
      }

      // Find closing `>`
      const closeIdx = input.indexOf('>', i + 1);
      if (closeIdx === -1) {
        // No closing bracket — treat as raw text
        parts.push(0x3c);
        i += 1;
        continue;
      }

      const name = input.slice(i + 1, closeIdx);

      // Look up named sequence
      const seq = NAMED_SEQUENCES[name];
      if (seq) {
        parts.push(...seq);
        i = closeIdx + 1;
        continue;
      }

      // Check for Alt-<char> pattern
      const altMatch = name.match(ALT_PREFIX_RE);
      if (altMatch) {
        const charCode = altMatch[1].charCodeAt(0);
        parts.push(0x1b, charCode); // \x1b <char>
        i = closeIdx + 1;
        continue;
      }

      // Unrecognized name — pass through as raw text including brackets
      parts.push(0x3c);
      for (let j = i + 1; j <= closeIdx; j++) {
        const code = input.charCodeAt(j);
        // Encode as UTF-8 bytes for safety
        if (code < 0x80) {
          parts.push(code);
        } else if (code < 0x800) {
          parts.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else {
          parts.push(
            0xe0 | (code >> 12),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f)
          );
        }
      }
      i = closeIdx + 1;
      continue;
    }

    // Raw character — encode as UTF-8
    const code = input.charCodeAt(i);
    if (code < 0x80) {
      parts.push(code);
    } else if (code < 0x800) {
      parts.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      parts.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
    i += 1;
  }

  return Buffer.from(parts);
}