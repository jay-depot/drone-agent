export const MAX_SYSTEM_REMINDERS = 8;

/**
 * Bounded FIFO queue of one-shot, non-persisted system reminders. Plugins
 * queue advisory text (e.g. "context is approaching compaction") via the
 * `_runtime` capability; the conversation service drains the queue into the
 * next LLM call as non-persisted `role: 'system'` messages, so reminders
 * never enter session history.
 */
export class SystemReminderQueue {
  private items: string[] = [];

  queue(content: string): void {
    if (this.items.length < MAX_SYSTEM_REMINDERS) {
      this.items.push(content);
    }
  }

  drainAll(): string[] {
    const drained = this.items;
    this.items = [];
    return drained;
  }

  clear(): void {
    this.items = [];
  }
}
