interface ErrorViewProps {
  message: string;
  onRetry: () => void;
  tone?: 'error' | 'neutral';
}

export function ErrorView({ message, onRetry, tone = 'error' }: ErrorViewProps) {
  return (
    <div class="error-view">
      <p class={`error-message${tone === 'neutral' ? ' error-message--neutral' : ''}`}>{message}</p>
      <div class="error-actions">
        <button type="button" onClick={onRetry}>
          Try Again
        </button>
        <button type="button" onClick={() => window.history.back()}>
          Go Back
        </button>
      </div>
    </div>
  );
}
