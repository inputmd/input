import { addFileToGist, deleteFileFromGist, type GistDetail, renameFileInGist } from './github';
import { deleteRepoFile, getRepoContents, isRepoFile, type PutFileResult, putRepoFile } from './github_app';
import { encodeUtf8ToBase64 } from './util';

export interface RepoDocFile {
  name: string;
  relativePath: string;
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
  createFile: (relativePath: string) => Promise<PutFileResult>;
  deleteFile: (file: RepoDocFile) => Promise<void>;
  renameFile: (file: RepoDocFile, newRelativePath: string) => Promise<PutFileResult>;
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

export function createRepoDocumentStore(installationId: string, repoFullName: string, docsDir: string): RepoStore {
  return {
    kind: 'repo',
    createFile(relativePath: string) {
      const path = toRepoDocPath(docsDir, relativePath);
      return putRepoFile(installationId, repoFullName, path, `Create ${relativePath}`, encodeUtf8ToBase64(''));
    },
    deleteFile(file: RepoDocFile) {
      return deleteRepoFile(installationId, repoFullName, file.path, `Delete ${file.name}`, file.sha);
    },
    async renameFile(file: RepoDocFile, newRelativePath: string) {
      const contents = await getRepoContents(installationId, repoFullName, file.path);
      if (!isRepoFile(contents)) throw new Error('Expected a file');
      const newPath = toRepoDocPath(docsDir, newRelativePath);
      const created = await putRepoFile(
        installationId,
        repoFullName,
        newPath,
        `Rename ${file.relativePath} to ${newRelativePath}`,
        contents.content ?? '',
      );
      await deleteRepoFile(installationId, repoFullName, file.path, `Delete ${file.name} (renamed)`, file.sha);
      return created;
    },
  };
}

export function findRepoDocFile(files: RepoDocFile[], relativePath: string): RepoDocFile | undefined {
  return files.find((file) => file.relativePath === relativePath);
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/');
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid file path');
  }
  return parts.join('/');
}

export function toRepoDocPath(docsDir: string, relativePath: string): string {
  return `${docsDir}/${normalizeRelativePath(relativePath)}`;
}

export function repoDocRelativePath(docsDir: string, path: string): string | null {
  if (!path.startsWith(`${docsDir}/`)) return null;
  return path.slice(docsDir.length + 1);
}
