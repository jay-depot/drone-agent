import type { ConsoleCommand } from './types.js';

export class ConsoleCommandRegistry {
  private commands = new Map<string, ConsoleCommand>();

  register(command: ConsoleCommand): void {
    if (this.commands.has(command.name)) {
      throw new Error(`Duplicate console command: ${command.name}`);
    }
    this.commands.set(command.name, command);
  }

  get(name: string): ConsoleCommand | undefined {
    return this.commands.get(name);
  }

  list(): ConsoleCommand[] {
    return [...this.commands.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }
}
