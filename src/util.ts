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

export function decodeBase64ToUtf8(b64: string): string {
  const binary = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
