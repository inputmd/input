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
  createFile: (filename: string) => Promise<PutFileResult>;
  deleteFile: (file: RepoDocFile) => Promise<void>;
  renameFile: (file: RepoDocFile, newName: string) => Promise<PutFileResult>;
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
    createFile(filename: string) {
      const path = `${docsDir}/${filename}`;
      return putRepoFile(installationId, repoFullName, path, `Create ${filename}`, encodeUtf8ToBase64(''));
    },
    deleteFile(file: RepoDocFile) {
      return deleteRepoFile(installationId, repoFullName, file.path, `Delete ${file.name}`, file.sha);
    },
    async renameFile(file: RepoDocFile, newName: string) {
      const contents = await getRepoContents(installationId, repoFullName, file.path);
      if (!isRepoFile(contents)) throw new Error('Expected a file');
      const newPath = `${docsDir}/${newName}`;
      const created = await putRepoFile(
        installationId,
        repoFullName,
        newPath,
        `Rename ${file.name} to ${newName}`,
        contents.content ?? '',
      );
      await deleteRepoFile(installationId, repoFullName, file.path, `Delete ${file.name} (renamed)`, file.sha);
      return created;
    },
  };
}

export function findRepoDocFile(files: RepoDocFile[], name: string): RepoDocFile | undefined {
  return files.find((file) => file.name === name);
}

export function toRepoDocPath(docsDir: string, filename: string): string {
  return `${docsDir}/${filename}`;
}
