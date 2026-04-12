import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import { ClientError } from './errors.ts';

const REPO_TARBALL_MAX_FILES = 2000;
const REPO_TARBALL_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

interface TarballFile {
  path: string;
  content: string;
  size: number;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function tarballErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export async function extractTarball(stream: ReadableStream<Uint8Array>): Promise<TarballFile[]> {
  const files: TarballFile[] = [];
  const extract = tar.extract();
  const source = Readable.fromWeb(stream);
  let sourceStreamError: unknown = null;
  const onSourceError = (err: unknown) => {
    sourceStreamError ??= err;
  };
  source.on('error', onSourceError);

  extract.on('entry', (header, entryStream, next) => {
    if (header.type !== 'file') {
      entryStream.resume();
      next();
      return;
    }

    // Tarball paths are prefixed with <owner>-<repo>-<sha>/.
    const rawPath = header.name;
    const slashIndex = rawPath.indexOf('/');
    const path = slashIndex >= 0 ? rawPath.slice(slashIndex + 1) : rawPath;
    if (!path) {
      entryStream.resume();
      next();
      return;
    }

    const size = header.size ?? 0;
    if (size > REPO_TARBALL_MAX_FILE_SIZE) {
      entryStream.resume();
      next();
      return;
    }

    const chunks: Buffer[] = [];
    entryStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    entryStream.on('end', () => {
      const buf = Buffer.concat(chunks);
      const preview = buf.subarray(0, 8192);
      if (preview.includes(0)) {
        next();
        return;
      }
      files.push({ path, content: buf.toString('utf8'), size: buf.length });
      if (files.length > REPO_TARBALL_MAX_FILES) {
        extract.destroy(new Error('too_many_files'));
        return;
      }
      next();
    });
    entryStream.on('error', next);
  });

  try {
    await pipeline(source, createGunzip(), extract);
  } catch (err) {
    const pipelineError = sourceStreamError ?? err;
    if (pipelineError instanceof Error && pipelineError.message === 'too_many_files') {
      throw new ClientError(`Repository has more than ${REPO_TARBALL_MAX_FILES} text files`, 400);
    }
    if (isAbortError(pipelineError)) {
      throw new ClientError('Repository tarball download timed out', 504);
    }
    throw new ClientError(`Failed to extract tarball: ${tarballErrorMessage(pipelineError)}`, 502);
  } finally {
    source.off('error', onSourceError);
  }

  return files;
}
