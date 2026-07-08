/**
 * Conversation ID ↔ filename conversion utilities.
 *
 * Conversation IDs can contain characters that are problematic in filenames
 * (:, @, !, /). These helpers provide a lossless, reversible mapping.
 *
 * The canonical conversationId is always read from the in-file field,
 * not derived from the filename — the filename is just a lookup key.
 */

const SAFE_SEPARATOR = '_';
const UNSAFE_CHARS: Record<string, string> = {
  '!': 'EXCL',
  '@': 'AT',
  ':': 'COLON',
  '/': 'SLASH',
  '#': 'HASH',
  '\\': 'BSLASH',
  '?': 'QMARK',
  '&': 'AMP',
  '%': 'PCT',
  '*': 'STAR',
  '|': 'PIPE',
  '<': 'LT',
  '>': 'GT',
  '"': 'QUOT',
};

const REVERSE_MAP: Record<string, string> = {};
for (const [char, code] of Object.entries(UNSAFE_CHARS)) {
  REVERSE_MAP[code] = char;
}

/**
 * Convert a conversationId to a safe filename (without .json extension).
 *
 * Examples:
 *   "!abc:matrix.org" → "EXCLabcCOLONmatrix.org"
 *   "dm:@alice:matrix.org" → "dmATaliceCOLONmatrix.org"
 *   "*" → "_default_"
 */
export function convIdToFilename(convId: string): string {
  if (convId === '*') {
    return '_default_';
  }

  let result = '';
  for (const char of convId) {
    if (UNSAFE_CHARS[char]) {
      result += SAFE_SEPARATOR + UNSAFE_CHARS[char] + SAFE_SEPARATOR;
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Attempt to reverse a filename back to a conversationId.
 * This is best-effort — the canonical convId is always read from the file.
 * Returns null if the filename doesn't look like a valid encoded convId.
 */
export function filenameToConvId(filename: string): string | null {
  if (filename === '_default_') {
    return '*';
  }

  // Reconstruct by replacing _CODE_ patterns
  let result = filename;
  for (const [code, char] of Object.entries(REVERSE_MAP)) {
    result = result.replace(
      new RegExp(`${SAFE_SEPARATOR}${code}${SAFE_SEPARATOR}`, 'g'),
      char
    );
  }
  return result;
}

/**
 * Validate that a conversationId is well-formed.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateConversationId(convId: string): string | null {
  if (!convId || convId.trim() === '') {
    return 'conversationId must not be empty';
  }
  if (convId.length > 512) {
    return 'conversationId must not exceed 512 characters';
  }
  return null;
}
