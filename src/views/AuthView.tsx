import { useRef, useState } from 'preact/hooks';
import {
  setToken, clearToken, getUser,
  type GitHubUser,
} from '../github';
import {
  createInstallState, getInstallUrl,
} from '../github_app';

interface AuthViewProps {
  onUserChange: (user: GitHubUser | null) => void;
  navigate: (route: string) => void;
}

export function AuthView({ onUserChange, navigate }: AuthViewProps) {
  const patRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    const token = patRef.current?.value.trim() ?? '';
    if (!token) return;
    setToken(token);
    try {
      const user = await getUser();
      onUserChange(user);
      setError(null);
      navigate('documents');
    } catch (err) {
      clearToken();
      onUserChange(null);
      setError(err instanceof Error ? err.message : 'Invalid token');
    }
  };

  const onConnectApp = async () => {
    try {
      const state = createInstallState();
      sessionStorage.setItem('github_app_install_state', state);
      const url = await getInstallUrl(state);
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect GitHub App');
    }
  };

  return (
    <div class="auth-view">
      <h1>Sign In</h1>
      <p>Enter a GitHub Personal Access Token with the <code>gist</code> scope</p>
      <form class="auth-form" onSubmit={onSubmit}>
        <input
          type="password"
          class="pat-input"
          ref={patRef}
          placeholder="ghp_xxxxxxxxxxxx"
          autocomplete="off"
        />
        <button type="submit">Sign In</button>
      </form>
      {error && <p class="auth-error">{error}</p>}
      <p class="hint">
        Create a token at{' '}
        <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">
          github.com/settings/tokens
        </a>{' '}
        with the <code>gist</code> scope.
      </p>
      <hr />
      <h2>GitHub App (repo-scoped)</h2>
      <p class="hint">Connect via a GitHub App installation (repo-scoped). Requires the local auth server.</p>
      <button type="button" onClick={onConnectApp}>Install / Connect GitHub App</button>
    </div>
  );
}
