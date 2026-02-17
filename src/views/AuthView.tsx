import { useRef, useState, useEffect } from 'preact/hooks';
import {
  setToken, setOAuthToken, clearToken, getUser,
  type GitHubUser,
} from '../github';
import {
  createInstallState, getInstallUrl,
} from '../github_app';
import { useDeviceFlow } from '../hooks/useDeviceFlow';

interface AuthViewProps {
  onUserChange: (user: GitHubUser | null) => void;
  navigate: (route: string) => void;
}

export function AuthView({ onUserChange, navigate }: AuthViewProps) {
  const patRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { phase, start, cancel } = useDeviceFlow();

  // Handle Device Flow success
  useEffect(() => {
    if (phase.status !== 'success') return;
    setOAuthToken(phase.token);
    getUser()
      .then(user => { onUserChange(user); navigate('documents'); })
      .catch(err => {
        clearToken();
        onUserChange(null);
        setError(err instanceof Error ? err.message : 'Failed to verify token');
      });
  }, [phase]);

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
      <h2>Sign In</h2>

      {/* Device Flow — primary */}
      <div class="device-flow-section">
        {(phase.status === 'idle' || phase.status === 'error') && (
          <>
            <button type="button" class="github-signin-btn" onClick={start}>
              Sign in with GitHub
            </button>
            {phase.status === 'error' && <p class="auth-error">{phase.message}</p>}
          </>
        )}

        {phase.status === 'requesting' && (
          <p class="hint">Contacting GitHub...</p>
        )}

        {phase.status === 'pending' && (
          <div class="device-flow-pending">
            <p>
              Go to{' '}
              <a href={phase.verificationUri} target="_blank" rel="noopener noreferrer">
                {phase.verificationUri}
              </a>{' '}
              and enter the code:
            </p>
            <code class="device-flow-code">{phase.userCode}</code>
            <p class="hint">Waiting for authorization...</p>
            <button type="button" onClick={cancel}>Cancel</button>
          </div>
        )}

        {phase.status === 'success' && (
          <p class="hint">Authorized! Signing you in...</p>
        )}
      </div>

      <hr />

      {/* PAT — secondary/advanced */}
      <h2>Personal Access Token</h2>
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
        with the <strong>gist</strong> scope.
      </p>

      <hr />

      {/* GitHub App — tertiary */}
      <h2>GitHub App (repo-scoped)</h2>
      <p class="hint">Connect via a GitHub App installation (repo-scoped). Requires the local auth server.</p>
      <button type="button" onClick={onConnectApp}>Install / Connect GitHub App</button>
    </div>
  );
}
