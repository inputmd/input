import { useEffect, useRef, useState } from 'preact/hooks';
import { clearToken, type GitHubUser, getUser, setOAuthToken, setToken } from '../github';
import { createInstallState, getInstallUrl } from '../github_app';
import { useDeviceFlow } from '../hooks/useDeviceFlow';
import { routePath } from '../routing';

interface AuthViewProps {
  onUserChange: (user: GitHubUser | null) => void;
  navigate: (route: string) => void;
}

export function AuthView({ onUserChange, navigate }: AuthViewProps) {
  const patRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPat, setShowPat] = useState(false);
  const { phase, start, cancel } = useDeviceFlow();

  // Handle Device Flow success
  useEffect(() => {
    if (phase.status !== 'success') return;
    setOAuthToken(phase.token);
    getUser()
      .then((user) => {
        onUserChange(user);
        navigate(routePath.documents());
      })
      .catch((err) => {
        clearToken();
        onUserChange(null);
        setError(err instanceof Error ? err.message : 'Failed to verify token');
      });
  }, [phase, navigate, onUserChange]);

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    const token = patRef.current?.value.trim() ?? '';
    if (!token) return;
    setToken(token);
    try {
      const user = await getUser();
      onUserChange(user);
      setError(null);
      navigate(routePath.documents());
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
      {/* GitHub App */}
      <h2>Connect to a repo</h2>
      <p class="hint">Install the application on a public GitHub repo.</p>
      <button type="button" class="github-signin-btn" onClick={onConnectApp}>
        Install GitHub App
      </button>

      <hr />

      <h2>Connect to GitHub Gists</h2>
      {phase.status !== 'pending' && <p class="hint">Use GitHub OAuth to save notes as individual gists.</p>}

      {/* Device Flow */}
      <div class="device-flow-section">
        {(phase.status === 'idle' || phase.status === 'error') && (
          <>
            <button type="button" class="github-signin-btn" onClick={start}>
              Sign in with GitHub
            </button>
            {phase.status === 'error' && <p class="auth-error">{phase.message}</p>}
          </>
        )}

        {phase.status === 'requesting' && <p class="hint">Contacting GitHub...</p>}

        {phase.status === 'pending' && (
          <div class="device-flow-pending hint">
            <div>
              Go to{' '}
              <a href={phase.verificationUri} target="_blank" rel="noopener noreferrer">
                {phase.verificationUri}
              </a>{' '}
              and enter the code:
            </div>
            <code class="device-flow-code">{phase.userCode}</code>
            <div class="hint">Waiting for authorization...</div>
            <button type="button" onClick={cancel}>
              Cancel
            </button>
            <br />
          </div>
        )}

        {phase.status === 'success' && <p class="hint">Authorized! Signing you in...</p>}
      </div>

      {phase.status !== 'pending' && (
        <>
          <a class="pat-toggle" onClick={() => setShowPat(!showPat)}>
            Advanced ▾
          </a>

          {showPat && (
            <>
              <form class="auth-form" onSubmit={onSubmit}>
                <input
                  type="password"
                  class="pat-input"
                  ref={patRef}
                  placeholder="ghp_xxxxxxxxxxxx"
                  autocomplete="off"
                />
                <button type="submit">Sign in</button>
              </form>
              {error && <p class="auth-error">{error}</p>}
              <p class="hint">
                Create a personal access token at{' '}
                <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">
                  github.com/settings/tokens
                </a>{' '}
                with the <strong>gist</strong> scope.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
