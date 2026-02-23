import { useEffect } from 'preact/hooks';
import type { InstallationRepo } from '../github_app';
import { routePath } from '../routing';

interface GitHubAppViewProps {
  installationId: string;
  selectedRepo: string | null;
  availableRepos: InstallationRepo[];
  repoListLoading: boolean;
  onSelectRepo: (fullName: string, id: number, isPrivate: boolean) => void;
  onLoadRepos: () => void;
  onDisconnect: () => void;
  navigate: (route: string) => void;
}

export function GitHubAppView({
  installationId,
  selectedRepo,
  availableRepos,
  repoListLoading,
  onSelectRepo,
  onLoadRepos,
  onDisconnect,
  navigate,
}: GitHubAppViewProps) {
  const statusText = `Connected (installation_id=${installationId})${selectedRepo ? `, repo=${selectedRepo}` : ''}.`;

  useEffect(() => {
    onLoadRepos();
  }, [onLoadRepos]);

  const handleSelect = (repo: { full_name: string; id: number; private: boolean }) => {
    onSelectRepo(repo.full_name, repo.id, repo.private);
    navigate(routePath.repoDocuments());
  };

  return (
    <div class="githubapp-view">
      <h1>GitHub App</h1>
      <p class="hint">{statusText}</p>
      <div class="githubapp-actions">
        <button type="button" onClick={() => void onDisconnect()}>
          Disconnect
        </button>
      </div>
      {repoListLoading ? (
        <div class="githubapp-repos">
          <div class="hint">Loading repos...</div>
        </div>
      ) : availableRepos.length > 0 ? (
        <div class="githubapp-repos">
          <div class="hint">
            {availableRepos.length} repo{availableRepos.length === 1 ? '' : 's'} accessible via this installation:
          </div>
          <ul>
            {availableRepos.map((repo) => (
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
      ) : (
        <div class="githubapp-repos">
          <div class="hint">No repos available</div>
        </div>
      )}
    </div>
  );
}
