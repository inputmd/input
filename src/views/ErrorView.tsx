interface ErrorViewProps {
  message: string;
  onRetry: () => void;
}

export function ErrorView({ message, onRetry }: ErrorViewProps) {
  return (
    <div class="error-view">
      <p class="error-message">{message}</p>
      <button type="button" onClick={onRetry}>Try Again</button>
    </div>
  );
}
