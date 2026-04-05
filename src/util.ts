export function isExternalHttpHref(href: string): boolean {
  const protocolMatch = href.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!protocolMatch) return false;
  const protocol = protocolMatch[1].toLowerCase();
  return protocol === 'http' || protocol === 'https';
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function encodeUtf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  return encodeBytesToBase64(bytes);
}

export function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeBase64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\n/g, ''));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function decodeBase64ToUtf8(b64: string): string {
  return new TextDecoder().decode(decodeBase64ToBytes(b64));
}

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export function readCacheTtlMs(envVar: string, fallback: number): number {
  const raw = import.meta.env[envVar];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export const MARKDOWN_EXT_RE = /\.(?:md(?:own|wn)?|markdown)$/i;

export function isMarkdownFileName(name: string | null | undefined): boolean {
  if (!name) return false;
  return MARKDOWN_EXT_RE.test(name);
}

export function encodePathForHref(path: string): string {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

export function reusableImageSrc(image: Pick<HTMLImageElement, 'src' | 'currentSrc' | 'getAttribute'>): string {
  return image.src.trim() || image.currentSrc.trim() || (image.getAttribute('src') ?? '').trim();
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

export function buildToolCallJson(options: { id?: string; name: string; argumentsJson?: string }): string {
  return JSON.stringify(
    {
      name: options.name,
      arguments: options.argumentsJson ?? '{}',
    },
    null,
    2,
  );
}
