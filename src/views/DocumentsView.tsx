import { useState, useEffect, useMemo } from 'preact/hooks';
import { listGists, deleteGist, updateGistDescription, type GistSummary } from '../github';
import {
  getRecentlyCreatedGists,
  getRecentlyDeletedGistIds,
  markGistRecentlyDeleted,
  reconcileRecentGists,
} from '../gist_consistency';
import { DocumentCard } from '../components/DocumentCard';
import { useDialogs } from '../components/DialogProvider';
import { routePath } from '../routing';

interface DocumentsViewProps {
  navigate: (route: string) => void;
  userLogin: string | null;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function DocumentsView({ navigate, userLogin }: DocumentsViewProps) {
  const { showAlert, showConfirm, showPrompt } = useDialogs();
  const [gists, setGists] = useState<GistSummary[]>([]);
  const [page, setPage] = useState(1);
  const [allLoaded, setAllLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPage = async (p: number, reset: boolean) => {
    setLoading(true);
    if (reset) {
      setAllLoaded(false);
      setPage(1);
    }
    try {
      const result = await listGists(p);
      setGists(prev => reset ? result : [...prev, ...result]);
      const reachedEnd = result.length < 30;
      setAllLoaded(reachedEnd);
      setPage(reachedEnd ? p : p + 1);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPage(1, true);
  }, []);

  useEffect(() => {
    reconcileRecentGists(userLogin, gists);
  }, [userLogin, gists]);

  const visibleGists = useMemo(() => {
    const deleted = new Set(getRecentlyDeletedGistIds(userLogin));
    const created = getRecentlyCreatedGists(userLogin);
    const apiIds = new Set(gists.map(g => g.id));

    const pendingCreated = created
      .filter(g => !apiIds.has(g.id) && !deleted.has(g.id))
      .map(g => ({ gist: g, pending: true }));

    const apiVisible = gists
      .filter(g => !deleted.has(g.id))
      .map(g => ({ gist: g, pending: false }));

    return [...pendingCreated, ...apiVisible];
  }, [gists, userLogin]);

  const onDelete = async (gist: GistSummary) => {
    const title = gist.description || 'Untitled';
    if (!await showConfirm(`Delete "${title}"?`)) return;
    try {
      await deleteGist(gist.id);
      markGistRecentlyDeleted(userLogin, gist.id);
      setGists(prev => prev.filter(g => g.id !== gist.id));
    } catch (err) {
      void showAlert(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const onRename = async (gist: GistSummary) => {
    const currentTitle = gist.description ?? '';
    const input = await showPrompt('New wiki name:', currentTitle);
    if (input === null) return;
    const nextTitle = input.trim();
    if (nextTitle === currentTitle) return;
    try {
      const updated = await updateGistDescription(gist.id, nextTitle);
      setGists(prev => prev.map(g => (
        g.id === gist.id
          ? { ...g, description: updated.description, updated_at: updated.updated_at }
          : g
      )));
    } catch (err) {
      void showAlert(err instanceof Error ? err.message : 'Failed to rename');
    }
  };

  if (error) {
    return (
      <div class="error-view">
        <p class="error-message">{error}</p>
        <button type="button" onClick={() => loadPage(1, true)}>Try Again</button>
      </div>
    );
  }

  return (
    <div class="documents-view">
      <div class="documents-header">
        <div class="documents-header-copy">
          <h1>My Wikis</h1>
          <p class="hint documents-subtitle">Wikis are stored as multi-file Gists on GitHub.</p>
        </div>
        <button type="button" onClick={() => navigate(routePath.home())}>New Wiki</button>
      </div>
      {!loading && visibleGists.length === 0 ? (
        <div class="empty-state">
          <p>No wikis yet.</p>
          <p>Create your first wiki to get started.</p>
          <button type="button" onClick={() => navigate(routePath.home())}>New Wiki</button>
        </div>
      ) : (
      <div class="documents-list">
        {visibleGists.map(({ gist, pending }) => {
          const title = gist.description || 'Untitled';
          const fileCount = Object.keys(gist.files).length;
          const updated = formatDate(gist.updated_at);
          return (
            <DocumentCard
              key={gist.id}
              title={title}
              pending={pending}
              meta={(
                <>
                  {fileCount} file{fileCount !== 1 ? 's' : ''} {'\u00b7'} Updated {updated} {'\u00b7'}{' '}
                  <a
                    href={`https://gist.github.com/${gist.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="doc-meta-link"
                  >
                    {gist.id.slice(0, 8)}
                  </a>
                </>
              )}
              onOpen={() => navigate(routePath.gistView(gist.id))}
              onRename={() => onRename(gist)}
              onDelete={() => onDelete(gist)}
            />
          );
        })}
      </div>
      )}
      {loading && <p class="loading-hint">Loading...</p>}
      {!allLoaded && !loading && (
        <button type="button" class="load-more-btn" onClick={() => loadPage(page, false)}>
          Load More
        </button>
      )}
    </div>
  );
}
