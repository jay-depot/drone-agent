import { cn } from '@/lib/utils';

export function ErrorBanner({
  message,
  className,
}: {
  message: string | null | undefined;
  className?: string;
}) {
  if (!message) {
    return null;
  }
  return (
    <div
      role="alert"
      className={cn(
        'mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm',
        className
      )}
    >
      {message}
    </div>
  );
}
