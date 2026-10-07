/**
 * Interpret `\n`, `\t` and `\\` in a caller-supplied --prefix. Other escapes
 * are literal.
 */
export function unescapePrefix(raw: string): string {
  return raw.replace(/\\(.)/g, (_m, c: string) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === '\\' ? '\\' : `\\${c}`
  );
}

/**
 * Prepend the prefix to the text (i.e. to its first line, with no separator).
 * The prefix owns no implicit separator; a caller wanting one supplies it.
 */
export function applyPrefix(prefix: string | undefined, text: string): string {
  if (!prefix) return text;
  return prefix + text;
}
