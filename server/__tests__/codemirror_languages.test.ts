import test from 'ava';
import { detectedLanguageForFileName } from '../../src/components/codemirror_languages.ts';

test('detectedLanguageForFileName treats .mjs and .cjs as JavaScript when editor support is enabled', (t) => {
  const mjsLanguage = detectedLanguageForFileName('scripts/build.mjs', { includeJavaScriptModules: true });
  const cjsLanguage = detectedLanguageForFileName('scripts/build.cjs', { includeJavaScriptModules: true });

  t.is(mjsLanguage?.label, 'JavaScript');
  t.true((mjsLanguage?.extensions.length ?? 0) > 0);
  t.is(cjsLanguage?.label, 'JavaScript');
  t.true((cjsLanguage?.extensions.length ?? 0) > 0);
});

test('detectedLanguageForFileName leaves .mjs and .cjs disabled by default for non-editor callers', (t) => {
  t.is(detectedLanguageForFileName('scripts/build.mjs'), null);
  t.is(detectedLanguageForFileName('scripts/build.cjs'), null);
});
