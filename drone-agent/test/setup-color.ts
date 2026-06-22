/**
 * Setup file that forces chalk to emit ANSI color codes.
 *
 * Must run before any test file is imported, because chalk reads
 * `process.env.FORCE_COLOR` at import time and caches the result.
 * Setting it in a `beforeAll` hook is too late — chalk is already
 * loaded by then via static imports (ink, ink-testing-library, etc.).
 */
process.env.FORCE_COLOR = '1';
