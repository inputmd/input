import type { GistDetail } from './github';
import type { PutFileResult } from './github_app';
import { BrowserGitHubConnection, GitHubGistFileSystem, GitHubRepoFileSystem } from './github_filesystem';

export interface RepoDocFile {
  name: string;
  path: string;
  sha: string;
  size?: number;
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
  const fs = new GitHubGistFileSystem(new BrowserGitHubConnection(), gistId);
  return {
    kind: 'gist',
    createFile(filename: string) {
      return fs.createFile(filename);
    },
    deleteFile(file: { name: string }) {
      return fs.deleteFile(file.name);
    },
    renameFile(file: { name: string }, newName: string) {
      return fs.renameFile(file.name, newName);
    },
  };
}

export function createRepoDocumentStore(installationId: string, repoFullName: string): RepoStore {
  const fs = new GitHubRepoFileSystem(new BrowserGitHubConnection(), installationId, repoFullName);
  return {
    kind: 'repo',
    createFile(path: string) {
      return fs.createFile(path);
    },
    deleteFile(file: RepoDocFile) {
      return fs.deleteFile(file.path, file.sha, `Delete ${file.name}`);
    },
    renameFile(file: RepoDocFile, newPath: string) {
      return fs.renameFile(file, newPath);
    },
  };
}

export function findRepoDocFile(files: RepoDocFile[], path: string): RepoDocFile | undefined {
  return files.find((file) => file.path === path);
}
