import type { AdapterMessage } from './types.js';

/**
 * Buffers inbound messages for one conversation and flushes them as a single
 * batch after a quiet period. The flush callback is expected to serialize on the
 * conversation's dispatch tail, so a flush that arrives during an in-flight turn
 * simply queues behind it.
 */
export class MessageBatcher {
  private buffer: AdapterMessage[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly debounceMs: number,
    private readonly flush: (batch: AdapterMessage[]) => void
  ) {}

  /** Append a message and (re)arm the debounce timer. */
  push(msg: AdapterMessage): void {
    this.buffer.push(msg);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.debounceMs);
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = null;
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.flush(batch);
  }

  /** Cancel any pending flush and drop buffered messages (shutdown). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = [];
  }
}
