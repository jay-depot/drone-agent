import { runInjectCli } from './commands.js';

export async function main(): Promise<void> {
  await runInjectCli(process.argv.slice(2));
}
