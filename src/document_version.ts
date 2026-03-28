/**
 * Lightweight document version tracking for detecting content drift
 * between when the AI reads the document and when changes are applied.
 */

export interface DocumentVersion {
  hash: string;
  length: number;
  timestamp: number;
}

/**
 * FNV-1a 32-bit hash — fast, non-cryptographic, good collision resistance
 * for content-equality checks.
 */
export function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function captureDocumentVersion(content: string): DocumentVersion {
  return {
    hash: fnv1aHash(content),
    length: content.length,
    timestamp: Date.now(),
  };
}

export function documentVersionsMatch(a: DocumentVersion, b: DocumentVersion): boolean {
  return a.hash === b.hash && a.length === b.length;
}
