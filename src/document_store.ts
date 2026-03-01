import { addFileToGist, deleteFileFromGist, type GistDetail, renameFileInGist } from './github';
import { deleteRepoFile, getRepoContents, isRepoFile, type PutFileResult, putRepoFile } from './github_app';
import { encodeUtf8ToBase64 } from './util';

export interface RepoDocFile {
  name: string;
  path: string;
  sha: string;
}

export interface GistStore {
  kind: 'gist';
  createFile: (filename: string) => Promise<GistDetail>;
  deleteFile: (file: { name: string }) => Promise<GistDetail>;
  renameFile: (file: { name: string }, newName: string) => Promise<GistDetail>;
}

export interface RepoStore {
  kind: 'repo';
  createFile: (path: string) => Promise<PutFileResult>;
  deleteFile: (file: RepoDocFile) => Promise<void>;
  renameFile: (file: RepoDocFile, newPath: string) => Promise<PutFileResult>;
}

export type DocumentStore = GistStore | RepoStore;

export function createGistDocumentStore(gistId: string): GistStore {
  return {
    kind: 'gist',
    createFile(filename: string) {
      return addFileToGist(gistId, filename, '\u200B');
    },
    deleteFile(file: { name: string }) {
      return deleteFileFromGist(gistId, file.name);
    },
    renameFile(file: { name: string }, newName: string) {
      return renameFileInGist(gistId, file.name, newName);
    },
  };
}

export function createRepoDocumentStore(installationId: string, repoFullName: string): RepoStore {
  return {
    kind: 'repo',
    createFile(path: string) {
      const normalized = normalizeRelativePath(path);
      return putRepoFile(installationId, repoFullName, normalized, `Create ${path}`, encodeUtf8ToBase64(''));
    },
    deleteFile(file: RepoDocFile) {
      return deleteRepoFile(installationId, repoFullName, file.path, `Delete ${file.name}`, file.sha);
    },
    async renameFile(file: RepoDocFile, newPath: string) {
      const contents = await getRepoContents(installationId, repoFullName, file.path);
      if (!isRepoFile(contents)) throw new Error('Expected a file');
      const normalizedNewPath = normalizeRelativePath(newPath);
      const created = await putRepoFile(
        installationId,
        repoFullName,
        normalizedNewPath,
        `Rename ${file.path} to ${newPath}`,
        contents.content ?? '',
      );
      await deleteRepoFile(installationId, repoFullName, file.path, `Delete ${file.name} (renamed)`, file.sha);
      return created;
    },
  };
}

export function findRepoDocFile(files: RepoDocFile[], path: string): RepoDocFile | undefined {
  return files.find((file) => file.path === path);
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/');
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid file path');
  }
  return parts.join('/');
}
