import { useState } from 'preact/hooks';
import { createInstallState, getInstallUrl, rememberInstallState } from '../github_app';
import { routePath } from '../routing';

export function AuthView() {
  const [error, setError] = useState<string | null>(null);

  const onSignIn = () => {
    window.location.assign(`/api/auth/github/start?return_to=${encodeURIComponent('/' + routePath.documents())}`);
  };

  const onConnectApp = async () => {
    try {
      const state = createInstallState();
      rememberInstallState(state);
      const url = await getInstallUrl(state);
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start GitHub App install');
    }
  };

  return (
    <div class="auth-view">
      <h2>Sign in</h2>
      <p class="hint">Use your GitHub account to continue.</p>
      <button type="button" class="github-signin-btn" onClick={onSignIn}>
        Sign in with GitHub
      </button>

      <hr />

      <h2>Connect to a repo</h2>
      <p class="hint">Install the application once to enable repo access.</p>
      <button type="button" class="github-signin-btn" onClick={() => void onConnectApp()}>
        Install GitHub App
      </button>
      {error && <p class="hint">{error}</p>}
    </div>
  );
}
