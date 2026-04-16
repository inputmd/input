import { gzipSync } from 'node:zlib';
import test from 'ava';
import tar from 'tar-stream';
import { ClientError } from '../errors.ts';
import { extractTarball } from '../repo_tarball.ts';

async function buildTarArchive(
  entries: Array<{ name: string; contents?: Uint8Array; type?: 'file' | 'directory' }>,
): Promise<Uint8Array> {
  const pack = tar.pack();
  const chunks: Uint8Array[] = [];
  const archive = new Promise<Uint8Array>((resolve, reject) => {
    pack.on('data', (chunk: Buffer) => {
      chunks.push(new Uint8Array(chunk));
    });
    pack.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    pack.on('error', reject);
  });

  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      const header = { name: entry.name, type: entry.type ?? 'file' } as const;
      const contents = entry.type === 'directory' ? undefined : Buffer.from(entry.contents ?? new Uint8Array());
      pack.entry(header, contents, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  pack.finalize();
  return archive;
}

function buildWebStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

test('extractTarball strips the archive root and skips binary files', async (t) => {
  const archive = await buildTarArchive([
    {
      name: 'input-main/docs/readme.md',
      contents: new TextEncoder().encode('# hello\n'),
    },
    {
      name: 'input-main/assets/logo.bin',
      contents: new Uint8Array([0, 1, 2, 3]),
    },
  ]);

  const files = await extractTarball(buildWebStream(gzipSync(Buffer.from(archive))));

  t.deepEqual(files, [{ path: 'docs/readme.md', content: '# hello\n', size: 8 }]);
});

test('extractTarball turns upstream stream timeouts into client errors', async (t) => {
  const archive = await buildTarArchive([
    {
      name: 'input-main/docs/readme.md',
      contents: new TextEncoder().encode('# hello\n'),
    },
  ]);
  const gzipped = new Uint8Array(gzipSync(Buffer.from(archive)));
  const splitIndex = Math.max(1, Math.floor(gzipped.length / 2));
  let sentFirstChunk = false;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentFirstChunk) {
        sentFirstChunk = true;
        controller.enqueue(gzipped.subarray(0, splitIndex));
        return;
      }
      controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    },
  });

  const err = await t.throwsAsync(() => extractTarball(stream), { instanceOf: ClientError });

  t.is(err?.message, 'Repository tarball download timed out');
  t.is(err?.statusCode, 504);
});

test('extractTarball turns upstream stream timeouts into client errors after directory entries', async (t) => {
  const archive = await buildTarArchive([
    {
      name: 'input-main/docs',
      type: 'directory',
    },
    {
      name: 'input-main/docs/readme.md',
      contents: new TextEncoder().encode('# hello\n'),
    },
  ]);
  const gzipped = new Uint8Array(gzipSync(Buffer.from(archive)));
  const splitIndex = Math.max(1, Math.floor(gzipped.length / 2));
  let sentFirstChunk = false;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentFirstChunk) {
        sentFirstChunk = true;
        controller.enqueue(gzipped.subarray(0, splitIndex));
        return;
      }
      controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    },
  });

  const err = await t.throwsAsync(() => extractTarball(stream), { instanceOf: ClientError });

  t.is(err?.message, 'Repository tarball download timed out');
  t.is(err?.statusCode, 504);
});

test('extractTarball rejects archives whose extracted text exceeds the total byte cap', async (t) => {
  const archive = await buildTarArchive([
    {
      name: 'input-main/docs/a.md',
      contents: new TextEncoder().encode('123456'),
    },
    {
      name: 'input-main/docs/b.md',
      contents: new TextEncoder().encode('abcdef'),
    },
  ]);

  const err = await t.throwsAsync(
    () => extractTarball(buildWebStream(gzipSync(Buffer.from(archive))), { maxTotalBytes: 10 }),
    {
      instanceOf: ClientError,
    },
  );

  t.is(err?.message, 'Repository text content exceeds 10 bytes');
  t.is(err?.statusCode, 400);
});
