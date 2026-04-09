import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import tar from 'tar-stream';
import {
  buildWebContainerHomeOverlayProvisionScript,
  WEBCONTAINER_HOME_OVERLAY_MANIFEST_PATH,
} from '../../src/webcontainer_home_overlay.ts';
import { buildWebContainerHomeOverlayArchive } from '../webcontainer_home_overlay_archive.ts';

interface TestTarFileEntry {
  contents: Uint8Array;
  mode?: number;
  name: string;
  type?: 'file';
}

interface TestTarSymlinkEntry {
  linkname: string;
  mode?: number;
  name: string;
  type: 'symlink';
}

type TestTarEntry = TestTarFileEntry | TestTarSymlinkEntry;

async function runNodeScript(
  script: string,
  options: {
    cwd?: string;
    env: Record<string, string>;
  },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`node exited with code ${code}: ${stderr}`));
    });
  });
}

async function buildTarArchive(entries: readonly TestTarEntry[]): Promise<Uint8Array> {
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
      if (entry.type === 'symlink') {
        pack.entry(
          {
            linkname: entry.linkname,
            mode: entry.mode ?? 0o777,
            name: entry.name,
            type: 'symlink',
          },
          (err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          },
        );
        return;
      }
      pack.entry(
        {
          name: entry.name,
          mode: entry.mode ?? 0o644,
          type: 'file',
        },
        Buffer.from(entry.contents),
        (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        },
      );
    });
  }

  pack.finalize();
  return archive;
}

async function listTarEntries(
  archive: Uint8Array,
): Promise<Map<string, { contents: Uint8Array; linkname: string | null; mode: number; type: string }>> {
  const extract = tar.extract();
  const entries = new Map<string, { contents: Uint8Array; linkname: string | null; mode: number; type: string }>();

  await new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const chunks: Uint8Array[] = [];
      stream.on('data', (chunk: Buffer) => {
        chunks.push(new Uint8Array(chunk));
      });
      stream.on('end', () => {
        entries.set(header.name, {
          contents: new Uint8Array(Buffer.concat(chunks)),
          linkname: header.linkname ?? null,
          mode: header.mode ?? 0,
          type: header.type,
        });
        next();
      });
      stream.on('error', reject);
      stream.resume();
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
    extract.end(Buffer.from(archive));
  });

  return entries;
}

test('buildWebContainerHomeOverlayArchive packages overlay files and preserves executable bits', async (t) => {
  const overlayDir = await mkdtemp(path.join(os.tmpdir(), 'input-overlay-'));
  t.teardown(async () => {
    await rm(overlayDir, { force: true, recursive: true });
  });

  const longPath =
    '.local/lib/node_modules/@scope/example-package/with-a-very-long-subdirectory-name/with-an-even-longer-file-name-to-force-pax-handling.js';
  await mkdir(path.join(overlayDir, '.local/bin'), { recursive: true });
  await mkdir(path.join(overlayDir, path.dirname(longPath)), { recursive: true });
  await writeFile(path.join(overlayDir, '.jshrc'), 'export PATH="$HOME/.local/bin:$PATH"\n', 'utf8');
  await writeFile(path.join(overlayDir, 'cors.mjs'), 'export {};\n', 'utf8');
  await writeFile(path.join(overlayDir, 'host_bridge_daemon.mjs'), 'export {};\n', 'utf8');
  await writeFile(path.join(overlayDir, '.local/bin/tool'), '#!/usr/bin/env node\n', 'utf8');
  await chmod(path.join(overlayDir, '.local/bin/tool'), 0o755);
  await symlink('../lib/tool', path.join(overlayDir, '.local/bin/tool-link'));
  await writeFile(path.join(overlayDir, longPath), 'console.log("long");\n', 'utf8');
  await writeFile(path.join(overlayDir, '.DS_Store'), 'ignore me\n', 'utf8');

  const archive = await buildWebContainerHomeOverlayArchive(overlayDir);
  const entries = await listTarEntries(archive);

  t.true(entries.has('.jshrc'));
  t.true(entries.has('cors.mjs'));
  t.true(entries.has('host_bridge_daemon.mjs'));
  t.true(entries.has('.local/bin/tool'));
  t.true(entries.has('.local/bin/tool-link'));
  t.true(entries.has(longPath));
  t.false(entries.has('.DS_Store'));
  t.is(entries.get('.local/bin/tool')?.mode ?? 0, 0o755);
  t.is(entries.get('.jshrc')?.mode ?? 0, 0o644);
  t.is(entries.get('.local/bin/tool-link')?.type, 'symlink');
  t.is(entries.get('.local/bin/tool-link')?.linkname, '../lib/tool');
  t.is(new TextDecoder().decode(entries.get(longPath)?.contents), 'console.log("long");\n');
});

test('buildWebContainerHomeOverlayProvisionScript provisions files, symlinks, modes, and stale cleanup', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'input-home-overlay-home-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'input-home-overlay-work-'));
  t.teardown(async () => {
    await rm(homeDir, { force: true, recursive: true });
    await rm(workDir, { force: true, recursive: true });
  });

  await mkdir(path.join(homeDir, '.local/bin'), { recursive: true });
  await writeFile(path.join(homeDir, '.jshrc'), 'old\n', 'utf8');
  await writeFile(path.join(homeDir, '.local/bin/tool'), 'old\n', 'utf8');
  await writeFile(path.join(homeDir, '.local/bin/stale'), 'stale\n', 'utf8');
  await symlink('../stale', path.join(homeDir, '.local/bin/old-link'));
  await chmod(path.join(homeDir, '.jshrc'), 0o755);
  await chmod(path.join(homeDir, '.local/bin/tool'), 0o644);
  await writeFile(
    path.join(homeDir, WEBCONTAINER_HOME_OVERLAY_MANIFEST_PATH),
    `${JSON.stringify(['.jshrc', '.local/bin/tool', '.local/bin/stale', '.local/bin/old-link'], null, 2)}\n`,
    'utf8',
  );

  const archive = await buildTarArchive([
    {
      name: '.jshrc',
      contents: new TextEncoder().encode('export PATH="$HOME/.local/bin:$PATH"\n'),
      mode: 0o644,
    },
    {
      name: '.local/bin/tool',
      contents: new TextEncoder().encode('#!/usr/bin/env node\n'),
      mode: 0o755,
    },
    {
      linkname: '../tool',
      name: '.local/bin/tool-link',
      type: 'symlink',
    },
  ]);
  await writeFile(path.join(workDir, 'overlay.tar'), archive);

  await runNodeScript(buildWebContainerHomeOverlayProvisionScript('overlay.tar'), {
    cwd: workDir,
    env: { HOME: homeDir },
  });

  t.is(await readFile(path.join(homeDir, '.jshrc'), 'utf8'), 'export PATH="$HOME/.local/bin:$PATH"\n');
  t.is(await readFile(path.join(homeDir, '.local/bin/tool'), 'utf8'), '#!/usr/bin/env node\n');
  await t.throwsAsync(readFile(path.join(homeDir, '.local/bin/stale'), 'utf8'));
  await t.throwsAsync(lstat(path.join(homeDir, '.local/bin/old-link')));
  t.is((await stat(path.join(homeDir, '.jshrc'))).mode & 0o777, 0o644);
  t.is((await stat(path.join(homeDir, '.local/bin/tool'))).mode & 0o777, 0o755);
  t.true((await lstat(path.join(homeDir, '.local/bin/tool-link'))).isSymbolicLink());
  t.is(await readlink(path.join(homeDir, '.local/bin/tool-link')), '../tool');
  t.is(
    await readFile(path.join(homeDir, WEBCONTAINER_HOME_OVERLAY_MANIFEST_PATH), 'utf8'),
    `${JSON.stringify(['.jshrc', '.local/bin/tool', '.local/bin/tool-link'], null, 2)}\n`,
  );
});

test('buildWebContainerHomeOverlayProvisionScript rejects paths outside the home directory', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'input-home-overlay-home-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'input-home-overlay-work-'));
  t.teardown(async () => {
    await rm(homeDir, { force: true, recursive: true });
    await rm(workDir, { force: true, recursive: true });
  });

  const archive = await buildTarArchive([
    {
      name: '../outside',
      contents: new TextEncoder().encode('nope\n'),
    },
  ]);
  await writeFile(path.join(workDir, 'overlay.tar'), archive);

  const error = await t.throwsAsync(
    runNodeScript(buildWebContainerHomeOverlayProvisionScript('overlay.tar'), {
      cwd: workDir,
      env: { HOME: homeDir },
    }),
  );
  t.regex(error?.message ?? '', /must stay inside \$HOME/);
});

test('buildWebContainerHomeOverlayProvisionScript rejects symlink targets that escape the home directory', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'input-home-overlay-home-'));
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'input-home-overlay-work-'));
  t.teardown(async () => {
    await rm(homeDir, { force: true, recursive: true });
    await rm(workDir, { force: true, recursive: true });
  });

  const archive = await buildTarArchive([
    {
      linkname: '../../../outside',
      name: '.local/bin/tool-link',
      type: 'symlink',
    },
  ]);
  await writeFile(path.join(workDir, 'overlay.tar'), archive);

  const error = await t.throwsAsync(
    runNodeScript(buildWebContainerHomeOverlayProvisionScript('overlay.tar'), {
      cwd: workDir,
      env: { HOME: homeDir },
    }),
  );
  t.regex(error?.message ?? '', /symlink target must stay inside \$HOME/);
});
