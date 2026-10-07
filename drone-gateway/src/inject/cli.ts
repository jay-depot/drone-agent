import { runInjectCli } from './commands.js';

export async function main(): Promise<void> {
  await runInjectCli(process.argv.slice(2));
}

main().catch(err => {
  process.stderr.write(
    `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  );
  process.exitCode = 1;
});
