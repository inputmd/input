import { useState } from 'preact/hooks';
import {
  clearInstallationId,
  clearSelectedRepo,
  clearSessionToken,
  type InstallationRepoList,
  listInstallationRepos,
  SessionExpiredError,
  setSelectedRepo,
} from '../github_app';
import { routePath } from '../routing';

interface GitHubAppViewProps {
  installationId: string;
  selectedRepo: string | null;
  onSelectRepo: (fullName: string, id: number) => void;
  onDisconnect: () => void;
  navigate: (route: string) => void;
}

export function GitHubAppView({
  installationId,
  selectedRepo,
  onSelectRepo,
  onDisconnect,
  navigate,
}: GitHubAppViewProps) {
  const [repoList, setRepoList] = useState<InstallationRepoList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusText = `Connected (installation_id=${installationId})${selectedRepo ? `, repo=${selectedRepo}` : ''}.`;

  const loadRepos = async () => {
    setLoading(true);
    setError(null);
    try {
      const repos = await listInstallationRepos(installationId);
      setRepoList(repos);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        onDisconnect();
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to load repositories');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = () => {
    clearInstallationId();
    clearSelectedRepo();
    clearSessionToken();
    onDisconnect();
  };

  const handleSelect = (repo: { full_name: string; id: number }) => {
    onSelectRepo(repo.full_name, repo.id);
    setSelectedRepo({ full_name: repo.full_name, id: repo.id });
    navigate(routePath.repoDocuments());
  };

  return (
    <div class="githubapp-view">
      <h1>GitHub App</h1>
      <p class="hint">{statusText}</p>
      <div class="githubapp-actions">
        <button type="button" onClick={loadRepos}>
          {loading ? 'Loading...' : 'Load Accessible Repos'}
        </button>
        <button type="button" onClick={handleDisconnect}>
          Disconnect
        </button>
      </div>
      {error && <p class="error-message">{error}</p>}
      {repoList && (
        <div class="githubapp-repos">
          <div class="hint">
            {repoList.total_count} repo{repoList.total_count === 1 ? '' : 's'} accessible via this installation:
          </div>
          <ul>
            {repoList.repositories.map((repo) => (
              <li key={repo.id}>
                <button
                  type="button"
                  style={{ marginRight: '8px' }}
                  disabled={selectedRepo === repo.full_name}
                  onClick={() => handleSelect(repo)}
                >
                  {selectedRepo === repo.full_name ? 'Selected' : 'Select'}
                </button>
                <a href={repo.html_url} target="_blank" rel="noopener noreferrer">
                  {repo.full_name}
                  {repo.private ? ' (private)' : ''}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
