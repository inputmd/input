interface ErrorViewProps {
  message: string;
  onRetry: () => void;
}

export function ErrorView({ message, onRetry }: ErrorViewProps) {
  return (
    <div class="error-view">
      <p class="error-message">{message}</p>
      <div class="error-actions">
        <button type="button" onClick={onRetry}>Try Again</button>
        <button type="button" onClick={() => window.history.back()}>Go Back</button>
      </div>
    </div>
  );
}
