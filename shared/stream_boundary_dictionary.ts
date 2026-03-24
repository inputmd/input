/**
 * Bloom filter dictionary for stream boundary space detection.
 *
 * Generated from /usr/share/dict/words + inflections (~2M entries, k=7).
 * False positive rate: ~1% (measured ~3% on random strings).
 *
 * Regenerate: node scripts/generate_dictionary_bloom.mjs
 */

const BLOOM_BITS = 18831720;
const BLOOM_K = 7;

let bloomFilter: Uint8Array | null = null;
let bloomFilterPromise: Promise<void> | null = null;

/**
 * Initialise the bloom filter. Call once at startup.
 * Tries Node fs first, falls back to browser fetch.
 */
export async function initDictionary(): Promise<void> {
  if (bloomFilter) return;
  if (bloomFilterPromise) return bloomFilterPromise;

  bloomFilterPromise = (async () => {
    try {
      // Dynamic imports — these fail in the browser and fall through to fetch.
      // @ts-ignore: node:fs may not have type declarations in browser tsconfig
      const fs = await import('node:fs');
      // @ts-ignore: node:url may not have type declarations in browser tsconfig
      const url = await import('node:url');
      // @ts-ignore: node:path may not have type declarations in browser tsconfig
      const path = await import('node:path');
      const dir = path.dirname(url.fileURLToPath(import.meta.url));
      bloomFilter = new Uint8Array(fs.readFileSync(path.join(dir, 'dictionary.bloom')));
    } catch {
      const res = await fetch(new URL('./dictionary.bloom', import.meta.url).href);
      bloomFilter = new Uint8Array(await res.arrayBuffer());
    }
  })();

  try {
    await bloomFilterPromise;
  } catch (error) {
    bloomFilterPromise = null;
    throw error;
  }
}

/** Initialise from a pre-loaded buffer (tests / custom loaders). */
export function initDictionaryFromBuffer(data: Uint8Array): void {
  bloomFilter = data;
  bloomFilterPromise = Promise.resolve();
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function fnv1aVariant(str: string): number {
  let h = 0x050c5d1f;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Tests whether a lowercase word is likely in the English dictionary.
 * Returns false if the bloom filter hasn't been initialised yet (safe fallback:
 * the existing heuristic rules still apply).
 */
export function isKnownWord(word: string): boolean {
  if (!bloomFilter) return false;
  const h1 = fnv1a(word);
  const h2 = fnv1aVariant(word);
  for (let i = 0; i < BLOOM_K; i++) {
    const pos = ((h1 + Math.imul(i, h2)) >>> 0) % BLOOM_BITS;
    if (!(bloomFilter[pos >> 3] & (1 << (pos & 7)))) return false;
  }
  return true;
}

// ── Stream boundary heuristic (shared between client and server) ──

const STREAM_BOUNDARY_JOINER_WORDS = new Set([
  'a',
  'about',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'after',
  'all',
  'also',
  'back',
  'be',
  'before',
  'being',
  'between',
  'both',
  'but',
  'by',
  'can',
  'because',
  'could',
  'down',
  'did',
  'do',
  'does',
  'each',
  'even',
  'every',
  'first',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'more',
  'most',
  'much',
  'my',
  'not',
  'now',
  'of',
  'only',
  'on',
  'other',
  'or',
  'over',
  'our',
  'she',
  'some',
  'such',
  'same',
  'that',
  'than',
  'then',
  'there',
  'the',
  'their',
  'them',
  'they',
  'these',
  'those',
  'this',
  'to',
  'through',
  'under',
  'up',
  'us',
  'very',
  'was',
  'well',
  'we',
  'were',
  'what',
  'when',
  'where',
  'who',
  'which',
  'while',
  'why',
  'will',
  'with',
  'would',
  'yet',
  'you',
  'your',
]);

const STREAM_CONTINUATION_SUFFIXES = new Set([
  's',
  'd',
  'r',
  'n',
  't',
  'ed',
  'er',
  'es',
  'ing',
  'ion',
  'ions',
  'ist',
  'ists',
  'ly',
  'ment',
  'ments',
  'ness',
  'ship',
  'tion',
  'tions',
]);

export function shouldInsertStreamBoundarySpace(previous: string, next: string): boolean {
  const previousChar = previous.at(-1);
  const nextChar = next[0];
  if (!previousChar || !nextChar) return false;
  if (/\s/.test(previousChar) || /\s/.test(nextChar)) return false;
  if (/[''.,;:!?)\]%}]/.test(nextChar)) return false;
  if (/[[({$]/.test(previousChar)) return false;
  if (/[.!?]/.test(previousChar) && /[A-Z]/.test(nextChar)) return true;
  if (!/[A-Za-z]/.test(previousChar) || !/[A-Za-z]/.test(nextChar)) return false;
  const previousWord = previous.match(/([A-Za-z]+)$/)?.[1];
  const nextWord = next.match(/^([A-Za-z]+)/)?.[1];
  if (!previousWord || !nextWord) return false;
  const previousWordStart = previous.length - previousWord.length;
  const previousBoundaryChar = previousWordStart > 0 ? previous[previousWordStart - 1] : '';
  const previousStartsAtWordBoundary = previousWordStart === 0 || /[\s([{"'`-]/.test(previousBoundaryChar);
  if (/[-‑–—][A-Za-z]{1,3}$/u.test(previousWord)) return false;
  if (/[-‑–—][A-Za-z]{1,3}$/u.test(previous)) return false;
  // Dictionary guard: if both fragments are substantial and joining them forms
  // a known word, it is likely a mid-word split — keep them joined.
  // Require both sides >= 3 chars, or prev >= 4 and next >= 2, to avoid false
  // matches on short function words (e.g. "in" + "Earth" → "inearth").
  if ((previousWord.length >= 3 && nextWord.length >= 3) || (previousWord.length >= 4 && nextWord.length >= 2)) {
    if (isKnownWord((previousWord + nextWord).toLowerCase())) return false;
  }
  if (previousWord.length === 1) {
    if (previousWord === 'I' && previousStartsAtWordBoundary && previous.length > previousWord.length) {
      return true;
    }
    return false;
  }
  if (/^[A-Z]/.test(nextWord)) return true;
  const nextLower = nextWord.toLowerCase();
  if (STREAM_BOUNDARY_JOINER_WORDS.has(nextLower)) return true;
  if (STREAM_CONTINUATION_SUFFIXES.has(nextLower)) return false;
  if (previousWord.length >= 3 && nextWord.length >= 3 && /^[a-z]/.test(nextWord)) return true;
  return false;
}

export function appendStreamText(previous: string, next: string): string {
  if (!next) return previous;
  if (previous && shouldInsertStreamBoundarySpace(previous, next)) return `${previous} ${next}`;
  return previous + next;
}
