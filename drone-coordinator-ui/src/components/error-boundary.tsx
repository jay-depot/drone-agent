import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: unknown;
}

/**
 * Catches a render error in its subtree and shows a visible fallback panel
 * instead of unmounting the whole app. `console.error` keeps the error and the
 * component stack in the browser console for diagnosis.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    const message = error instanceof Error ? error.message : String(error);
    return (
      <div className="p-6">
        <div className="mx-auto max-w-lg rounded-md border border-destructive/30 bg-destructive/10 p-4 text-destructive">
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="mt-1 text-sm break-words">{message}</p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="mt-3 rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium hover:bg-destructive/20"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
