export const SHUTDOWN_RESIDUAL_MS = 5000;

export function armShutdownWatchdog(deadlineMs: number): () => void {
  const watchdog = setTimeout(() => process.exit(1), deadlineMs);
  watchdog.unref();

  let residual: ReturnType<typeof setTimeout> | undefined;

  return function disarm(): void {
    clearTimeout(watchdog);
    if (residual) return;
    residual = setTimeout(
      () => process.exit(process.exitCode ?? 0),
      SHUTDOWN_RESIDUAL_MS
    );
    residual.unref();
  };
}
