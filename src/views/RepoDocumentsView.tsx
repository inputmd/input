import { useState, useEffect } from 'preact/hooks';
import {
  getRepoContents, deleteRepoFile, SessionExpiredError,
} from '../github_app';
import { DocumentCard } from '../components/DocumentCard';
import { REPO_DOCS_DIR } from '../constants';

interface RepoDocumentsViewProps {
  installationId: string;
  selectedRepo: string;
  navigate: (route: string) => void;
  onSessionExpired: () => void;
}

interface RepoFile {
  name: string;
  path: string;
  sha: string;
  size: number;
}

export function RepoDocumentsView({ installationId, selectedRepo, navigate, onSessionExpired }: RepoDocumentsViewProps) {
  const [files, setFiles] = useState<RepoFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metaText, setMetaText] = useState(`${selectedRepo}:${REPO_DOCS_DIR}`);

  useEffect(() => {
    loadDocuments();
  }, [installationId, selectedRepo]);

  const loadDocuments = async () => {
    setLoading(true);
    setError(null);
    try {
      const contents = await getRepoContents(installationId, selectedRepo, REPO_DOCS_DIR);
      if (Array.isArray(contents)) {
        const mdFiles = contents
          .filter(c => c.type === 'file' && c.name.toLowerCase().endsWith('.md'))
          .sort((a, b) => a.name.localeCompare(b.name));
        setFiles(mdFiles);
        setMetaText(`${selectedRepo}:${REPO_DOCS_DIR}`);
      } else {
        setError(`${REPO_DOCS_DIR} is a file; expected a directory.`);
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) { onSessionExpired(); return; }
      const msg = err instanceof Error ? err.message : 'Failed to load repo documents';
      if (String(msg).includes('404')) {
        setFiles([]);
        setMetaText(`${selectedRepo}:${REPO_DOCS_DIR} (does not exist yet)`);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const onDelete = async (file: RepoFile) => {
    if (!confirm(`Delete "${file.name}" from ${selectedRepo}?`)) return;
    try {
      await deleteRepoFile(installationId, selectedRepo, file.path, `Delete ${file.name}`, file.sha);
      setFiles(prev => prev.filter(f => f.path !== file.path));
    } catch (err) {
      if (err instanceof SessionExpiredError) { onSessionExpired(); return; }
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  if (error) {
    return (
      <div class="error-view">
        <p class="error-message">{error}</p>
        <button type="button" onClick={loadDocuments}>Try Again</button>
      </div>
    );
  }

  if (loading) {
    return <div class="loading-view"><p>Loading...</p></div>;
  }

  if (files.length === 0) {
    return (
      <div class="repodocuments-view">
        <div class="repodocuments-header">
          <h1>Repo Documents</h1>
          <div class="repodocuments-meta hint">{metaText}</div>
        </div>
        <div class="empty-state">
          <p>No documents yet.</p>
          <p>Create your first document to get started.</p>
          <button type="button" onClick={() => navigate('reponew')}>New Document</button>
        </div>
      </div>
    );
  }

  return (
    <div class="repodocuments-view">
      <div class="repodocuments-header">
        <h1>Repo Documents</h1>
        <div class="repodocuments-meta hint">{metaText}</div>
        <button type="button" onClick={() => navigate('reponew')}>New Document</button>
      </div>
      <div class="repodocuments-list">
        {files.map(file => (
          <DocumentCard
            key={file.path}
            title={file.name}
            meta={`${file.size} bytes`}
            onOpen={() => navigate(`repofile/${encodeURIComponent(file.path)}`)}
            onDelete={() => onDelete(file)}
          />
        ))}
      </div>
    </div>
  );
}
