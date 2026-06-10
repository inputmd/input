import type http from 'node:http';
import test from 'ava';
import { serveStatic } from '../static_files.ts';

// serveStatic only writes to the response when it successfully serves a file,
// so a bare stub is enough for the rejection paths under test.
const res = {} as http.ServerResponse;

test('serveStatic returns false for malformed percent-encoding instead of throwing', async (t) => {
  t.false(await serveStatic(res, '/%'));
  t.false(await serveStatic(res, '/%zz/index.html'));
});

test('serveStatic rejects paths that escape the dist directory', async (t) => {
  t.false(await serveStatic(res, '/../package.json'));
  t.false(await serveStatic(res, '/..%2fpackage.json'));
});
