import test from 'ava';
import { buildTerminalWorkdirName } from '../../src/repo_workspace/terminal_workdir.ts';

test('buildTerminalWorkdirName uses gist for gist sessions', (t) => {
  t.is(
    buildTerminalWorkdirName({
      currentGistId: 'abc123',
      repoAccessMode: null,
      selectedRepo: null,
      publicRepoRef: null,
    }),
    'gist',
  );
});

test('buildTerminalWorkdirName uses the repo name for installed repos', (t) => {
  t.is(
    buildTerminalWorkdirName({
      currentGistId: null,
      repoAccessMode: 'installed',
      selectedRepo: 'openai/input',
      publicRepoRef: null,
    }),
    'input',
  );
});

test('buildTerminalWorkdirName uses the repo name for public repos', (t) => {
  t.is(
    buildTerminalWorkdirName({
      currentGistId: null,
      repoAccessMode: 'public',
      selectedRepo: null,
      publicRepoRef: { owner: 'openai', repo: 'input-public' },
    }),
    'input-public',
  );
});

test('buildTerminalWorkdirName sanitizes invalid folder characters', (t) => {
  t.is(
    buildTerminalWorkdirName({
      currentGistId: null,
      repoAccessMode: 'installed',
      selectedRepo: 'openai/repo name/with/slashes',
      publicRepoRef: null,
    }),
    'slashes',
  );
  t.is(
    buildTerminalWorkdirName({
      currentGistId: null,
      repoAccessMode: 'public',
      selectedRepo: null,
      publicRepoRef: { owner: 'openai', repo: 'repo name with spaces' },
    }),
    'repo-name-with-spaces',
  );
});

test('buildTerminalWorkdirName falls back to workspace outside repo and gist contexts', (t) => {
  t.is(
    buildTerminalWorkdirName({
      currentGistId: null,
      repoAccessMode: null,
      selectedRepo: null,
      publicRepoRef: null,
    }),
    'workspace',
  );
});
