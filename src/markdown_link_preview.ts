import { isExternalHttpHref, MARKDOWN_EXT_RE } from './util';

export interface MarkdownLinkPreview {
  title: string;
  html: string;
}

export interface LinkPreviewState {
  visible: boolean;
  loading: boolean;
  top: number;
  left: number;
  title: string;
  html: string;
  url: string | null;
}

export const INITIAL_LINK_PREVIEW_STATE: LinkPreviewState = {
  visible: false,
  loading: false,
  top: 0,
  left: 0,
  title: '',
  html: '',
  url: null,
};

export function isMarkdownHref(href: string): boolean {
  const withoutSuffix = href.split(/[?#]/, 1)[0] ?? '';
  return MARKDOWN_EXT_RE.test(withoutSuffix);
}

export function lastPathSegment(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? '';
  const parts = withoutQuery.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

export function footnoteTargetIdFromAnchor(anchor: HTMLAnchorElement): string | null {
  const href = (anchor.getAttribute('href') || '').trim();
  if (!href.startsWith('#fn-')) return null;
  return href.slice(1);
}

export function isMissingWikiLink(anchor: HTMLAnchorElement): boolean {
  return anchor.classList.contains('missing-wikilink');
}

export function resolveInternalRoute(anchor: HTMLAnchorElement): string | null {
  if (anchor.hasAttribute('download')) return null;
  const href = (anchor.getAttribute('href') || '').trim();
  if (!href || href.startsWith('#') || href.startsWith('?')) return null;
  if (isExternalHttpHref(href)) return null;
  const resolved = new URL(href, window.location.href);
  if (resolved.origin !== window.location.origin) return null;
  return resolved.pathname.replace(/^\//, '');
}
