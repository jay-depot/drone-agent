/**
 * Hard limits for PTY session buffers (not user-configurable).
 */

/** Maximum accumulated output to keep for scrollback (64 KB). */
export const MAX_READ_BUFFER_BYTES = 64 * 1024;

/** Maximum accumulated output to keep for screenshot (256 KB). */
export const MAX_SCREENSHOT_BUFFER_BYTES = 256 * 1024;

/** Default PTY dimensions — 80x24 (standard terminal size). */
export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;