#!/usr/bin/env node
/**
 * Generates a bloom filter from the system dictionary for use in
 * stream boundary space detection. Outputs a TypeScript module.
 *
 * Augments the base dictionary with:
 * - Common English inflections (-s, -ed, -ing, -er, -est, -ly, etc.)
 * - Known proper nouns and brand names from LLM output
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Hash functions (FNV-1a double hashing) ──
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function fnv1aVariant(str) {
  let h = 0x050c5d1f;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ── Read and filter system dictionary ──
const raw = readFileSync('/usr/share/dict/words', 'utf8');
const baseWords = new Set();
for (const line of raw.split('\n')) {
  const trimmed = line.trim();
  if (trimmed.length < 3) continue;
  if (!/^[A-Za-z]+$/.test(trimmed)) continue;
  baseWords.add(trimmed.toLowerCase());
}
console.log(`Base dictionary words: ${baseWords.size}`);

// ── Generate inflected forms ──
const words = new Set(baseWords);

function addIfLong(word) {
  if (word.length >= 4) words.add(word);
}

for (const word of baseWords) {
  if (word.length < 3) continue;

  const lastChar = word.at(-1);
  const last2 = word.slice(-2);
  const endsConsonantY = /[bcdfghjklmnpqrstvwxyz]y$/.test(word);
  const endsE = lastChar === 'e';
  const endsSibilant = /(?:s|sh|ch|x|z)$/.test(word);
  const endsDoubleConsonant = /([bcdfghjklmnpqrstvwxyz])\1$/.test(word);
  const shortCVC = word.length <= 6 && /[bcdfghjklmnpqrstvwxyz][aeiou][bcdfghjklmnpqrstvwxyz]$/.test(word) && !endsDoubleConsonant;

  // Plural / third-person -s
  if (endsConsonantY) {
    addIfLong(word.slice(0, -1) + 'ies');
  } else if (endsSibilant) {
    addIfLong(word + 'es');
  } else {
    addIfLong(word + 's');
  }

  // Past tense / past participle -ed
  if (endsE) {
    addIfLong(word + 'd');
  } else if (endsConsonantY) {
    addIfLong(word.slice(0, -1) + 'ied');
  } else if (shortCVC) {
    addIfLong(word + lastChar + 'ed');
  } else {
    addIfLong(word + 'ed');
  }

  // Present participle -ing
  if (endsE && word.length > 3) {
    addIfLong(word.slice(0, -1) + 'ing');
  } else if (shortCVC) {
    addIfLong(word + lastChar + 'ing');
  } else {
    addIfLong(word + 'ing');
  }

  // Comparative -er / superlative -est (for adjectives, but we apply broadly)
  if (word.length <= 8) {
    if (endsE) {
      addIfLong(word + 'r');
      addIfLong(word + 'st');
    } else if (endsConsonantY) {
      addIfLong(word.slice(0, -1) + 'ier');
      addIfLong(word.slice(0, -1) + 'iest');
    } else {
      addIfLong(word + 'er');
      addIfLong(word + 'est');
    }
  }

  // Adverb -ly
  if (endsConsonantY) {
    addIfLong(word.slice(0, -1) + 'ily');
  } else if (last2 === 'le') {
    addIfLong(word.slice(0, -1) + 'y');
  } else if (last2 === 'ic') {
    addIfLong(word + 'ally');
  } else {
    addIfLong(word + 'ly');
  }

  // Agent noun -er (already covered above for short words, add for longer)
  if (word.length > 8) {
    if (endsE) addIfLong(word + 'r');
    else addIfLong(word + 'er');
  }

  // Noun -ment, -ness, -tion, -ation
  if (endsE) {
    addIfLong(word.slice(0, -1) + 'ation');
  }
  addIfLong(word + 'ness');
  addIfLong(word + 'ment');
}

// ── Add known proper nouns and brand names from LLM output ──
const extraWords = [
  // AI/tech
  'nvidia', 'nemotron', 'openai', 'chatgpt', 'llama', 'mistral', 'gemini',
  'openrouter', 'tensorflow', 'pytorch', 'github', 'stackoverflow',
  // Literary names that appear in LLM output
  'queequeg', 'ishmael', 'ahab', 'starbuck',
  // Scientific terms often in LLM output
  'rayleigh', 'tyndall', 'raman', 'doppler', 'planck', 'boltzmann',
  'photosynthesis', 'bioluminescence', 'electromagnetic',
  // Common compound words that may not be in the base dictionary
  'smartphone', 'healthcare', 'worldwide', 'screenshot', 'username',
  'timestamp', 'workflow', 'dataset', 'codebase', 'runtime',
  'middleware', 'frontend', 'backend', 'fullstack', 'localhost',
  'chatbot', 'webpage', 'website', 'blockchain', 'cryptocurrency',
  'rainstorm', 'thunderstorm', 'earthquake', 'wavelength', 'bandwidth',
  'checkpoint', 'benchmark', 'workaround', 'namespace', 'filename',
  'pathname', 'hostname', 'substring', 'superclass', 'subclass',
  'metadata', 'datatype', 'datastore', 'database', 'tablespace',
];

for (const word of extraWords) {
  words.add(word.toLowerCase());
}

console.log(`Total words after inflections + extras: ${words.size}`);

// ── Build bloom filter ──
const TARGET_FPR = 0.01;
const N = words.size;
const M = Math.ceil((-N * Math.log(TARGET_FPR)) / (Math.LN2 ** 2) / 8) * 8;
const K = Math.round((M / N) * Math.LN2);

console.log(`Bloom filter: ${M} bits (${(M / 8 / 1024).toFixed(1)} KB), k=${K}, target FPR=${TARGET_FPR}`);

const bits = new Uint8Array(M / 8);

function addToBloom(word) {
  const h1 = fnv1a(word);
  const h2 = fnv1aVariant(word);
  for (let i = 0; i < K; i++) {
    const pos = ((h1 + Math.imul(i, h2)) >>> 0) % M;
    bits[pos >> 3] |= 1 << (pos & 7);
  }
}

function testBloom(word) {
  const h1 = fnv1a(word);
  const h2 = fnv1aVariant(word);
  for (let i = 0; i < K; i++) {
    const pos = ((h1 + Math.imul(i, h2)) >>> 0) % M;
    if (!(bits[pos >> 3] & (1 << (pos & 7)))) return false;
  }
  return true;
}

for (const word of words) {
  addToBloom(word);
}

// ── Verify ──
let misses = 0;
for (const word of words) {
  if (!testBloom(word)) misses++;
}
console.log(`Verification: ${misses} false negatives out of ${words.size} (should be 0)`);

// Test FPR with random non-words
let fpCount = 0;
const fpTrials = 100_000;
for (let i = 0; i < fpTrials; i++) {
  const len = 6 + Math.floor(Math.random() * 10);
  let w = '';
  for (let j = 0; j < len; j++) w += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  if (!words.has(w) && testBloom(w)) fpCount++;
}
console.log(`Estimated FPR: ${(fpCount / fpTrials * 100).toFixed(2)}% (${fpCount}/${fpTrials})`);

// Test against known cases from our stream data
const knownWords = [
  'photosynthesis', 'conversational', 'refraction', 'deviated', 'bounces',
  'indigo', 'antisolar', 'standardize', 'misremembering', 'misquotation',
  'nvidia', 'queequeg', 'rayleigh', 'nemotron',
];
const knownNonWords = [
  'largelanguage', 'skylooks', 'isthe', 'internetbegan', 'occurswhen',
  'howcan', 'modeldeveloped', 'phenomenonthat', 'surewhich', 'thesky',
  'becausemolecules',
];

console.log('\nKnown word tests (should all be true):');
for (const w of knownWords) {
  const result = testBloom(w);
  console.log(`  ${w}: ${result}${!result ? ' ← MISS' : ''}`);
}

console.log('\nKnown non-word tests (should all be false):');
for (const w of knownNonWords) {
  const result = testBloom(w);
  console.log(`  ${w}: ${result}${result ? ' ← FALSE POSITIVE' : ''}`);
}

// ── Output binary bloom filter + TypeScript module ──
const binaryPath = join(__dirname, '..', 'shared', 'dictionary.bloom');
writeFileSync(binaryPath, bits);
console.log(`\nBinary bloom filter: ${(bits.byteLength / 1024).toFixed(1)} KB → ${binaryPath}`);

const tsModule = `/**
 * Bloom filter dictionary for stream boundary space detection.
 *
 * Generated from /usr/share/dict/words + inflections (${words.size} entries, k=${K}).
 * False positive rate: ~${TARGET_FPR * 100}%
 *
 * DO NOT EDIT — regenerate with: node scripts/generate_dictionary_bloom.mjs
 */

const BLOOM_BITS = ${M};
const BLOOM_K = ${K};
const BLOOM_BYTES = ${M / 8};

let bloomFilter: Uint8Array | null = null;

async function loadBloomBrowser(): Promise<Uint8Array> {
  const res = await fetch(new URL('./dictionary.bloom', import.meta.url).href);
  return new Uint8Array(await res.arrayBuffer());
}

function loadBloomNode(): Uint8Array {
  // Dynamic import to avoid bundler pulling in 'fs' for browser builds
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = typeof require !== 'undefined' ? require('fs') : null;
  if (fs) {
    const path = typeof require !== 'undefined' ? require('path') : null;
    const filePath = path
      ? path.resolve(path.dirname(new URL(import.meta.url).pathname), 'dictionary.bloom')
      : '';
    return new Uint8Array(fs.readFileSync(filePath));
  }
  throw new Error('Cannot load bloom filter: no fs module available');
}

function getBloomSync(): Uint8Array | null {
  return bloomFilter;
}

/**
 * Eagerly initialise the bloom filter. Call this once at startup.
 * In Node the load is synchronous; in the browser it fetches the binary asset.
 */
export async function initDictionary(): Promise<void> {
  if (bloomFilter) return;
  try {
    bloomFilter = loadBloomNode();
  } catch {
    bloomFilter = await loadBloomBrowser();
  }
}

/**
 * Synchronous init for Node environments (server / tests).
 */
export function initDictionarySync(): void {
  if (bloomFilter) return;
  bloomFilter = loadBloomNode();
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
 * Returns false if the bloom filter hasn't been initialised yet (safe fallback).
 * Uses a bloom filter — false positives are possible (~${TARGET_FPR * 100}%),
 * but false negatives never occur.
 */
export function isKnownWord(word: string): boolean {
  const bloom = getBloomSync();
  if (!bloom) return false;
  const h1 = fnv1a(word);
  const h2 = fnv1aVariant(word);
  for (let i = 0; i < BLOOM_K; i++) {
    const pos = ((h1 + Math.imul(i, h2)) >>> 0) % BLOOM_BITS;
    if (!(bloom[pos >> 3] & (1 << (pos & 7)))) return false;
  }
  return true;
}
`;

const tsPath = join(__dirname, '..', 'shared', 'stream_boundary_dictionary.ts');
writeFileSync(tsPath, tsModule);
console.log(`TypeScript module → ${tsPath}`);
