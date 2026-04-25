import test from 'ava';
import type { TarballFile } from '../repo_tarball.ts';
import {
  clearAllRepoTarballCache,
  clearInstalledRepoTarballCache,
  repoTarballCacheTestUtils,
} from '../repo_tarball_cache.ts';

function file(content: string): TarballFile {
  return { path: 'README.md', content, size: content.length };
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (err: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

test.beforeEach(() => {
  clearAllRepoTarballCache();
});

test.serial('repo tarball cache returns hits within the ttl and clones cached files', async (t) => {
  const key = repoTarballCacheTestUtils.installedRepoTarballCacheKey('inst1', 'Owner', 'Repo', 'HEAD');
  let loads = 0;

  const first = await repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(key, async () => {
    loads += 1;
    return [file('original')];
  });
  first.files[0]!.content = 'mutated';

  const second = await repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(key, async () => {
    loads += 1;
    return [file('unexpected')];
  });

  t.is(first.status, 'miss');
  t.is(second.status, 'hit');
  t.is(loads, 1);
  t.deepEqual(second.files, [file('original')]);
});

test.serial('repo tarball cache expires entries after 30 seconds', async (t) => {
  const key = repoTarballCacheTestUtils.publicRepoTarballCacheKey('Owner', 'Repo', 'HEAD');
  let loads = 0;

  await repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(key, async () => {
    loads += 1;
    return [file('first')];
  });
  const afterExpiry = await repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(
    key,
    async () => {
      loads += 1;
      return [file('second')];
    },
    Date.now() + 31_000,
  );

  t.is(afterExpiry.status, 'miss');
  t.is(loads, 2);
  t.deepEqual(afterExpiry.files, [file('second')]);
});

test.serial('installed repo tarball invalidation clears all refs for one repo', async (t) => {
  const mainKey = repoTarballCacheTestUtils.installedRepoTarballCacheKey('inst1', 'Owner', 'Repo', 'HEAD');
  const branchKey = repoTarballCacheTestUtils.installedRepoTarballCacheKey('inst1', 'Owner', 'Repo', 'feature');
  const otherKey = repoTarballCacheTestUtils.installedRepoTarballCacheKey('inst1', 'Owner', 'Other', 'HEAD');

  await repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(mainKey, async () => [file('main')]);
  await repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(branchKey, async () => [file('branch')]);
  await repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(otherKey, async () => [file('other')]);

  clearInstalledRepoTarballCache('inst1', 'Owner', 'Repo');

  let mainLoads = 0;
  let branchLoads = 0;
  let otherLoads = 0;
  const main = await repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(mainKey, async () => {
    mainLoads += 1;
    return [file('main reloaded')];
  });
  const branch = await repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(branchKey, async () => {
    branchLoads += 1;
    return [file('branch reloaded')];
  });
  const other = await repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(otherKey, async () => {
    otherLoads += 1;
    return [file('other reloaded')];
  });

  t.is(main.status, 'miss');
  t.is(branch.status, 'miss');
  t.is(other.status, 'hit');
  t.is(mainLoads, 1);
  t.is(branchLoads, 1);
  t.is(otherLoads, 0);
});

test.serial('repo tarball cache dedupes inflight loads but does not repopulate after invalidation', async (t) => {
  const key = repoTarballCacheTestUtils.installedRepoTarballCacheKey('inst1', 'Owner', 'Repo', 'HEAD');
  const pending = deferred<TarballFile[]>();
  let loads = 0;

  const first = repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(key, async () => {
    loads += 1;
    return pending.promise;
  });
  const second = repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(key, async () => {
    loads += 1;
    return [file('unexpected')];
  });

  clearInstalledRepoTarballCache('inst1', 'Owner', 'Repo');
  pending.resolve([file('stale')]);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  const afterInvalidation = await repoTarballCacheTestUtils.getOrLoadRepoTarballFiles(key, async () => {
    loads += 1;
    return [file('fresh')];
  });

  t.is(firstResult.status, 'miss');
  t.is(secondResult.status, 'deduped');
  t.is(afterInvalidation.status, 'miss');
  t.is(loads, 2);
  t.deepEqual(afterInvalidation.files, [file('fresh')]);
});
