import { Component } from 'preact';
import type { ComponentChildren, ErrorInfo } from 'preact';

interface ErrorBoundaryProps {
  children: ComponentChildren;
  fallbackMessage?: string;
  onReset?: () => void;
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Unhandled UI error:', error, errorInfo);
  }

  componentDidUpdate(prevProps: Readonly<ErrorBoundaryProps>): void {
    if (this.state.error && this.props.resetKey !== prevProps.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const message = this.props.fallbackMessage ?? 'Something went wrong while rendering this page.';
    const details = this.state.error.message;

    return (
      <div class="error-view">
        <p class="error-message">{message}</p>
        {details ? <p class="hint">{details}</p> : null}
        <div class="error-actions">
          <button type="button" onClick={this.handleReset}>Try Again</button>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
