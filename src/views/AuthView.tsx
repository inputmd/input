import { routePath } from '../routing';

export function AuthView() {
  const onSignIn = () => {
    window.location.assign(`/api/auth/github/start?return_to=${encodeURIComponent(`/${routePath.workspaces()}`)}`);
  };

  return (
    <div class="auth-view">
      <h2>Sign in</h2>
      <p class="hint">Use your GitHub account to continue.</p>
      <button type="button" class="github-signin-btn" onClick={onSignIn}>
        Sign in with GitHub
      </button>
    </div>
  );
}
