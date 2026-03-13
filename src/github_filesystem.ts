import { type GistDetail, getGist, updateGistFiles } from './github';
import {
  deleteRepoFile,
  getRepoContents,
  isRepoFile,
  type PutFileResult,
  putRepoFile,
  type RepoContents,
} from './github_app';
import { encodeUtf8ToBase64 } from './util';

type GistFileUpdate = { content: string } | { filename: string } | null;

export interface GitHubConnection {
  getGist(id: string): Promise<GistDetail>;
  updateGistFiles(id: string, files: Record<string, GistFileUpdate>, description?: string): Promise<GistDetail>;
  getRepoContents(installationId: string, repoFullName: string, path: string, ref?: string): Promise<RepoContents>;
  putRepoFile(
    installationId: string,
    repoFullName: string,
    path: string,
    message: string,
    contentBase64: string,
    sha?: string,
  ): Promise<PutFileResult>;
  deleteRepoFile(
    installationId: string,
    repoFullName: string,
    path: string,
    message: string,
    sha: string,
  ): Promise<void>;
}

export class BrowserGitHubConnection implements GitHubConnection {
  getGist(id: string): Promise<GistDetail> {
    return getGist(id);
  }

  updateGistFiles(id: string, files: Record<string, GistFileUpdate>, description?: string): Promise<GistDetail> {
    return updateGistFiles(id, files, description);
  }

  getRepoContents(installationId: string, repoFullName: string, path: string, ref?: string): Promise<RepoContents> {
    return getRepoContents(installationId, repoFullName, path, ref);
  }

  putRepoFile(
    installationId: string,
    repoFullName: string,
    path: string,
    message: string,
    contentBase64: string,
    sha?: string,
  ): Promise<PutFileResult> {
    return putRepoFile(installationId, repoFullName, path, message, contentBase64, sha);
  }

  deleteRepoFile(
    installationId: string,
    repoFullName: string,
    path: string,
    message: string,
    sha: string,
  ): Promise<void> {
    return deleteRepoFile(installationId, repoFullName, path, message, sha);
  }
}

export interface FsNode {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha?: string;
  size?: number;
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/');
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid file path');
  }
  return parts.join('/');
}

function fileNameFromPath(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

export class GitHubRepoFileSystem {
  private readonly connection: GitHubConnection;
  private readonly installationId: string;
  private readonly repoFullName: string;

  constructor(connection: GitHubConnection, installationId: string, repoFullName: string) {
    this.connection = connection;
    this.installationId = installationId;
    this.repoFullName = repoFullName;
  }

  async list(path = ''): Promise<FsNode[]> {
    const contents = await this.connection.getRepoContents(this.installationId, this.repoFullName, path);
    if (isRepoFile(contents)) {
      return [{ type: 'file', name: contents.name, path: contents.path, sha: contents.sha, size: contents.size }];
    }
    return contents.map((entry) => ({
      type: entry.type === 'dir' ? 'dir' : 'file',
      name: entry.name,
      path: entry.path,
      sha: entry.sha,
      size: entry.size,
    }));
  }

  writeFile(path: string, contentBase64: string, message: string, sha?: string): Promise<PutFileResult> {
    const normalized = normalizeRelativePath(path);
    return this.connection.putRepoFile(this.installationId, this.repoFullName, normalized, message, contentBase64, sha);
  }

  createFile(path: string, message = `Create ${path}`): Promise<PutFileResult> {
    return this.writeFile(path, encodeUtf8ToBase64(''), message);
  }

  deleteFile(path: string, sha: string, message = `Delete ${fileNameFromPath(path)}`): Promise<void> {
    const normalized = normalizeRelativePath(path);
    return this.connection.deleteRepoFile(this.installationId, this.repoFullName, normalized, message, sha);
  }
}

export class GitHubGistFileSystem {
  private readonly connection: GitHubConnection;
  private readonly gistId: string;

  constructor(connection: GitHubConnection, gistId: string) {
    this.connection = connection;
    this.gistId = gistId;
  }

  async list(): Promise<FsNode[]> {
    const gist = await this.connection.getGist(this.gistId);
    return Object.entries(gist.files).map(([path, file]) => ({
      type: 'file',
      name: file.filename,
      path,
      size: file.size,
    }));
  }

  async readFile(path: string): Promise<{ path: string; content: string; size: number }> {
    const gist = await this.connection.getGist(this.gistId);
    const file = gist.files[path];
    if (!file) throw new Error(`File not found: ${path}`);
    return {
      path,
      content: file.content,
      size: file.size,
    };
  }

  createFile(path: string, content = '\u200B'): Promise<GistDetail> {
    return this.connection.updateGistFiles(this.gistId, { [path]: { content } });
  }

  writeFile(path: string, content: string): Promise<GistDetail> {
    return this.connection.updateGistFiles(this.gistId, { [path]: { content } });
  }

  deleteFile(path: string): Promise<GistDetail> {
    return this.connection.updateGistFiles(this.gistId, { [path]: null });
  }

  renameFile(path: string, newPath: string): Promise<GistDetail> {
    return this.connection.updateGistFiles(this.gistId, { [path]: { filename: newPath } });
  }
}
