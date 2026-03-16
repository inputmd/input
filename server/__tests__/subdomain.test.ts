import test from 'ava';
import { extractSubdomain, stripManagedSubdomain } from '../../server/subdomain.ts';

test('extractSubdomain returns owner for managed subdomains', (t) => {
  t.is(extractSubdomain('selkie.input.md'), 'selkie');
  t.is(extractSubdomain('selkie.localhost:5173'), 'selkie');
});

test('stripManagedSubdomain returns root host for managed subdomains', (t) => {
  t.is(stripManagedSubdomain('selkie.input.md'), 'input.md');
  t.is(stripManagedSubdomain('selkie.localhost:5173'), 'localhost:5173');
});

test('stripManagedSubdomain ignores root and protected hosts', (t) => {
  t.is(stripManagedSubdomain('input.md'), null);
  t.is(stripManagedSubdomain('localhost:5173'), null);
  t.is(stripManagedSubdomain('docs.input.md'), null);
});
