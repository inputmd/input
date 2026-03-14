import { Globe, Link2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { DocumentCard } from '../components/DocumentCard';
import { getRecentlyCreatedGists, getRecentlyDeletedGistIds, reconcileRecentGists } from '../gist_consistency';
import type { GistSummary } from '../github';
import { routePath } from '../routing';

interface DocumentsViewProps {
  navigate: (route: string) => void;
  userLogin: string | null;
  gists: GistSummary[];
  loading: boolean;
  allLoaded: boolean;
  error: string | null;
  embedded?: boolean;
  onRetry: () => void | Promise<void>;
  onLoadMore: () => void;
  onRename: (gist: GistSummary) => void | Promise<void>;
  onDelete: (gist: GistSummary) => void | Promise<void>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function DocumentsView({
  navigate,
  userLogin,
  gists,
  loading,
  allLoaded,
  error,
  embedded = false,
  onRetry,
  onLoadMore,
  onRename,
  onDelete,
}: DocumentsViewProps) {
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    reconcileRecentGists(userLogin, gists);
  }, [userLogin, gists]);

  const visibleGists = useMemo(() => {
    const deleted = new Set(getRecentlyDeletedGistIds(userLogin));
    const created = getRecentlyCreatedGists(userLogin);
    const apiIds = new Set(gists.map((gist) => gist.id));

    const pendingCreated = created
      .filter((gist) => !apiIds.has(gist.id) && !deleted.has(gist.id))
      .map((gist) => ({ gist, pending: true }));

    const apiVisible = gists.filter((gist) => !deleted.has(gist.id)).map((gist) => ({ gist, pending: false }));

    return [...pendingCreated, ...apiVisible];
  }, [gists, userLogin]);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  if (error) {
    return (
      <div class="empty-state workspaces-empty-state">
        <p>Failed to load gists</p>
        <p class="hint">{error}</p>
        <button type="button" onClick={() => void handleRetry()} disabled={retrying} aria-busy={retrying}>
          {retrying ? <span class="documents-button-spinner" aria-hidden="true" /> : null}
          {retrying ? 'Retrying...' : 'Try Again'}
        </button>
      </div>
    );
  }

  return (
    <div class={`documents-view${embedded ? ' documents-view--embedded' : ''}`}>
      <div class="documents-header">
        <div class="documents-header-copy">
          <h2 class="documents-title">My Gists</h2>
          <p class="hint documents-subtitle">Workspaces stored as multi-file gists on GitHub</p>
        </div>
        <button type="button" class="documents-new-btn" onClick={() => navigate(routePath.freshDraft())}>
          New Gist
        </button>
      </div>
      {!loading && visibleGists.length === 0 ? (
        <div class="empty-state">
          <p>No gists yet.</p>
          <p>Create a new gist to get started.</p>
          {!embedded ? (
            <button type="button" class="documents-new-btn" onClick={() => navigate(routePath.freshDraft())}>
              New Gist
            </button>
          ) : null}
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
                title={
                  <span class="doc-title-main">
                    {gist.public ? (
                      <Globe size={14} class="doc-visibility-icon" aria-hidden="true" />
                    ) : (
                      <Link2 size={14} class="doc-visibility-icon" aria-hidden="true" />
                    )}
                    <span>{title}</span>
                  </span>
                }
                pending={pending}
                meta={
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
                }
                onOpen={() => navigate(routePath.gistView(gist.id))}
                onRename={() => void onRename(gist)}
                onDelete={() => void onDelete(gist)}
              />
            );
          })}
        </div>
      )}
      {loading ? <p class="loading-hint">Loading...</p> : null}
      {!allLoaded && !loading ? (
        <button type="button" class="load-more-btn" onClick={() => onLoadMore()}>
          Load More
        </button>
      ) : null}
    </div>
  );
}
