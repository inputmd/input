import { isExternalHttpHref } from './util.ts';

function safeCssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function queryRoot(root: ParentNode | null | undefined): ParentNode {
  return root ?? document;
}

function findNamedAnchorTarget(root: ParentNode, targetId: string): HTMLElement | null {
  if (!('querySelectorAll' in root) || typeof root.querySelectorAll !== 'function') return null;
  const namedAnchors = root.querySelectorAll('a[name]');
  for (const anchor of namedAnchors) {
    if (!(anchor instanceof HTMLElement)) continue;
    if ((anchor.getAttribute('name') ?? '').trim() === targetId) return anchor;
  }
  return null;
}

export function decodeHashTargetId(hash: string): string | null {
  const trimmed = hash.trim();
  if (!trimmed || !trimmed.startsWith('#')) return null;
  const raw = trimmed.slice(1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function findPreviewHashTarget(root: ParentNode | null | undefined, hash: string): HTMLElement | null {
  const targetId = decodeHashTargetId(hash);
  if (!targetId) return null;

  const searchRoot = queryRoot(root);
  const selector = `#${safeCssEscape(targetId)}`;
  const idTarget = 'querySelector' in searchRoot ? searchRoot.querySelector(selector) : null;
  if (idTarget instanceof HTMLElement) return idTarget;

  const namedTarget = findNamedAnchorTarget(searchRoot, targetId);
  if (namedTarget) return namedTarget;

  if (searchRoot === document) return null;

  const documentIdTarget = document.getElementById(targetId);
  if (documentIdTarget instanceof HTMLElement) return documentIdTarget;
  return findNamedAnchorTarget(document, targetId);
}

export function previewRouteHistoryPath(rawRoute: string): string {
  return rawRoute.startsWith('/') ? rawRoute : `/${rawRoute}`;
}

export function previewRoutePathname(rawRoute: string): string {
  return rawRoute.replace(/^\/+/, '').split(/[?#]/, 1)[0] ?? '';
}

export function previewRouteHasFragment(rawRoute: string): boolean {
  const hashIndex = rawRoute.indexOf('#');
  return hashIndex >= 0 && hashIndex < rawRoute.length - 1;
}

export function resolveInternalPreviewRoute(anchor: HTMLAnchorElement): string | null {
  if (anchor.hasAttribute('download')) return null;
  const href = (anchor.getAttribute('href') || '').trim();
  if (!href || href.startsWith('#') || href.startsWith('?')) return null;
  if (isExternalHttpHref(href)) return null;
  const resolved = new URL(href, window.location.href);
  if (resolved.origin !== window.location.origin) return null;
  return resolved.pathname.replace(/^\//, '');
}

export function resolveInternalNavigationRoute(anchor: HTMLAnchorElement): string | null {
  if (anchor.hasAttribute('download')) return null;
  const href = (anchor.getAttribute('href') || '').trim();
  if (!href || href.startsWith('?')) return null;
  if (href.startsWith('#')) return href;
  if (isExternalHttpHref(href)) return null;
  const resolved = new URL(href, window.location.href);
  if (resolved.origin !== window.location.origin) return null;
  return `${resolved.pathname.replace(/^\//, '')}${resolved.search}${resolved.hash}`;
}
