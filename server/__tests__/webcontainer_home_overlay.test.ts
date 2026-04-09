import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
  buildWebContainerHomeOverlayBootstrapScript,
  WEBCONTAINER_HOME_OVERLAY_MANIFEST_PATH,
  type WebContainerHomeOverlayFile,
} from '../../src/webcontainer_home_overlay.ts';

async function runNodeScript(script: string, env: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        ...env,
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

test('buildWebContainerHomeOverlayBootstrapScript provisions managed files and removes stale paths', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'input-home-overlay-'));
  t.teardown(async () => {
    await rm(homeDir, { force: true, recursive: true });
  });

  await mkdir(path.join(homeDir, '.local/bin'), { recursive: true });
  await writeFile(path.join(homeDir, '.local/bin/stale'), 'stale\n', 'utf8');
  await writeFile(
    path.join(homeDir, WEBCONTAINER_HOME_OVERLAY_MANIFEST_PATH),
    JSON.stringify(['.local/bin/stale'], null, 2),
    'utf8',
  );

  const files: readonly WebContainerHomeOverlayFile[] = [
    {
      path: '.jshrc',
      contents: 'export PATH="$HOME/.local/bin:$PATH"\n',
    },
    {
      path: '.local/bin/.keep',
      contents: '',
    },
  ];

  await runNodeScript(buildWebContainerHomeOverlayBootstrapScript(files), { HOME: homeDir });

  t.is(await readFile(path.join(homeDir, '.jshrc'), 'utf8'), 'export PATH="$HOME/.local/bin:$PATH"\n');
  t.is(await readFile(path.join(homeDir, '.local/bin/.keep'), 'utf8'), '');
  await t.throwsAsync(() => stat(path.join(homeDir, '.local/bin/stale')) as Promise<unknown>);

  const keepMode = (await stat(path.join(homeDir, '.local/bin/.keep'))).mode & 0o777;
  const jshrcMode = (await stat(path.join(homeDir, '.jshrc'))).mode & 0o777;
  const expectedManifest = `${JSON.stringify(
    files.map((file) => file.path),
    null,
    2,
  )}\n`;
  t.is(keepMode, 0o644);
  t.is(jshrcMode, 0o644);
  t.is(await readFile(path.join(homeDir, WEBCONTAINER_HOME_OVERLAY_MANIFEST_PATH), 'utf8'), expectedManifest);
});

test('buildWebContainerHomeOverlayBootstrapScript rejects paths outside the home directory', (t) => {
  const error = t.throws(() =>
    buildWebContainerHomeOverlayBootstrapScript([{ path: '../outside', contents: 'nope\n' }]),
  );

  t.regex(error?.message ?? '', /must stay inside \$HOME/);
});
