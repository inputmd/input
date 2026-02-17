import { useRef } from 'preact/hooks';

interface InputViewProps {
  navigate: (route: string) => void;
}

function extractGistId(input: string): string | null {
  input = input.trim();
  if (/^[a-f0-9]+$/i.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname === 'gist.github.com' || url.hostname === 'gist.githubusercontent.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) {
        if (/^[a-f0-9]+$/i.test(parts[i])) return parts[i];
      }
    }
  } catch { /* not a url */ }
  return null;
}

export function InputView({ navigate }: InputViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const onSubmit = (e: Event) => {
    e.preventDefault();
    const val = inputRef.current?.value ?? '';
    const id = extractGistId(val);
    if (id) navigate(`gist/${id}`);
  };

  return (
    <div class="input-view">
      <h1>Gist Viewer</h1>
      <p>Paste a GitHub Gist URL to view its contents</p>
      <form class="gist-form" onSubmit={onSubmit}>
        <input
          type="text"
          class="gist-url"
          ref={inputRef}
          placeholder="https://gist.github.com/user/abc123"
          autofocus
        />
        <button type="submit">Load</button>
      </form>
    </div>
  );
}
