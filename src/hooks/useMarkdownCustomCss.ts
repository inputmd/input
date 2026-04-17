import { useEffect, useMemo, useState } from 'preact/hooks';

interface MarkdownCustomCssResources {
  inlineCss: string | null;
  googleFontImportHrefs: string[];
}

const GOOGLE_FONT_STYLESHEET_TIMEOUT_MS = 1500;
const GOOGLE_FONT_STYLESHEET_LOADS = new Map<string, Promise<void>>();
const GOOGLE_FONT_STYLESHEET_READY = new Set<string>();

function readLeadingImportStatement(source: string): { statement: string; rest: string } | null {
  let index = 0;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (!source.slice(index).toLowerCase().startsWith('@import')) return null;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let parenDepth = 0;

  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    const previous = cursor > 0 ? source[cursor - 1] : '';

    if (char === "'" && !inDoubleQuote && previous !== '\\') {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote && previous !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')' && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (char === ';' && parenDepth === 0) {
      return {
        statement: source.slice(index, cursor + 1).trim(),
        rest: source.slice(cursor + 1),
      };
    }
  }

  return null;
}

function extractGoogleFontsImportHref(statement: string): string | null {
  const match =
    /^@import\s+(?:url\(\s*(['"]?)(https:\/\/fonts\.googleapis\.com\/[^'")\s]+)\1\s*\)|(['"])(https:\/\/fonts\.googleapis\.com\/[^'"\s]+)\3)(?:\s+[a-z0-9\s(),.-]+)?\s*;$/i.exec(
      statement.trim(),
    );
  const href = match?.[2] ?? match?.[4] ?? '';
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.hostname !== 'fonts.googleapis.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function splitMarkdownCustomCss(customCss: string | null): MarkdownCustomCssResources {
  if (!customCss) return { inlineCss: null, googleFontImportHrefs: [] };

  const googleFontImportHrefs: string[] = [];
  let remaining = customCss;

  while (true) {
    const match = readLeadingImportStatement(remaining);
    if (!match) break;
    const href = extractGoogleFontsImportHref(match.statement);
    if (!href) break;
    googleFontImportHrefs.push(href);
    remaining = match.rest;
  }

  const inlineCss = remaining.trim();
  return {
    inlineCss: inlineCss.length > 0 ? inlineCss : null,
    googleFontImportHrefs: Array.from(new Set(googleFontImportHrefs)),
  };
}

function ensureGoogleFontStylesheet(href: string): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();

  const cached = GOOGLE_FONT_STYLESHEET_LOADS.get(href);
  if (cached) return cached;

  const existing = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).find(
    (link) => link.href === href,
  );
  const link = existing ?? document.createElement('link');
  if (!existing) {
    link.rel = 'stylesheet';
    link.href = href;
    link.crossOrigin = 'anonymous';
  }

  const promise = new Promise<void>((resolve) => {
    let settled = false;
    let timeoutId = 0;

    const finalize = () => {
      if (settled) return;
      settled = true;
      link.dataset.markdownFontReady = 'true';
      GOOGLE_FONT_STYLESHEET_READY.add(href);
      if (timeoutId) window.clearTimeout(timeoutId);
      link.removeEventListener('load', finalize);
      link.removeEventListener('error', finalize);
      resolve();
    };

    if (link.dataset.markdownFontReady === 'true' || link.sheet != null) {
      finalize();
      return;
    }

    link.addEventListener('load', finalize);
    link.addEventListener('error', finalize);
    timeoutId = window.setTimeout(finalize, GOOGLE_FONT_STYLESHEET_TIMEOUT_MS);
    if (!existing) {
      document.head.appendChild(link);
    }
  });

  GOOGLE_FONT_STYLESHEET_LOADS.set(href, promise);
  return promise;
}

async function waitForDocumentFonts(timeoutMs = GOOGLE_FONT_STYLESHEET_TIMEOUT_MS): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;

  await Promise.race([
    document.fonts.ready.then(() => undefined),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, timeoutMs);
    }),
  ]);
}

function haveReadyGoogleFontStylesheets(hrefs: string[]): boolean {
  return hrefs.every((href) => GOOGLE_FONT_STYLESHEET_READY.has(href));
}

export function useMarkdownCustomCss(customCss: string | null): {
  inlineCss: string | null;
  pendingExternalFonts: boolean;
} {
  const resources = useMemo(() => splitMarkdownCustomCss(customCss), [customCss]);
  const importKey = resources.googleFontImportHrefs.join('\n');
  const [readyImportKey, setReadyImportKey] = useState(() =>
    resources.googleFontImportHrefs.length === 0 || haveReadyGoogleFontStylesheets(resources.googleFontImportHrefs)
      ? importKey
      : '',
  );
  const pendingExternalFonts = resources.googleFontImportHrefs.length > 0 && readyImportKey !== importKey;

  useEffect(() => {
    if (resources.googleFontImportHrefs.length === 0) {
      setReadyImportKey(importKey);
      return;
    }
    if (readyImportKey === importKey) return;
    if (
      haveReadyGoogleFontStylesheets(resources.googleFontImportHrefs) &&
      (typeof document === 'undefined' || !('fonts' in document) || document.fonts.status !== 'loading')
    ) {
      setReadyImportKey(importKey);
      return;
    }

    let cancelled = false;
    let frameId = 0;

    frameId = window.requestAnimationFrame(() => {
      void (async () => {
        await Promise.all(resources.googleFontImportHrefs.map((href) => ensureGoogleFontStylesheet(href)));
        await waitForDocumentFonts();
        if (!cancelled) setReadyImportKey(importKey);
      })();
    });

    return () => {
      cancelled = true;
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, [importKey, readyImportKey, resources.googleFontImportHrefs]);

  return {
    inlineCss: resources.inlineCss,
    pendingExternalFonts,
  };
}
