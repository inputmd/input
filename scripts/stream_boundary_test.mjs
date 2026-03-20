#!/usr/bin/env node
/**
 * Queries OpenRouter Nemotron 30B with streaming, captures raw chunk boundaries,
 * and evaluates the boundary-space heuristic against actual output.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Load API key from .env
const envContent = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const apiKey = envContent.match(/^OPENROUTER_API_KEY=(.+)$/m)?.[1]?.trim();
if (!apiKey) { console.error('No OPENROUTER_API_KEY in .env'); process.exit(1); }

const MODEL = 'nvidia/nemotron-3-nano-30b-a3b:free';

// ── Load bloom filter dictionary ──
const BLOOM_BITS = 18831720;
const BLOOM_K = 7;
const bloomPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'dictionary.bloom');
let bloomFilter;
try {
  bloomFilter = new Uint8Array(readFileSync(bloomPath));
  console.log(`Loaded bloom filter: ${(bloomFilter.byteLength / 1024).toFixed(0)} KB`);
} catch {
  console.warn('No bloom filter found — dictionary guard disabled');
  bloomFilter = null;
}

function fnv1aBloom(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
function fnv1aVariantBloom(str) {
  let h = 0x050c5d1f;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
function isKnownWord(word) {
  if (!bloomFilter) return false;
  const h1 = fnv1aBloom(word);
  const h2 = fnv1aVariantBloom(word);
  for (let i = 0; i < BLOOM_K; i++) {
    const pos = ((h1 + Math.imul(i, h2)) >>> 0) % BLOOM_BITS;
    if (!(bloomFilter[pos >> 3] & (1 << (pos & 7)))) return false;
  }
  return true;
}

// ── Heuristic (copied from reader_ai_tools.ts) ──

const STREAM_BOUNDARY_JOINER_WORDS = new Set([
  'a','about','am','an','and','any','are','as','at','after','all','also','back',
  'be','before','being','between','both','but','by','can','because','could','down',
  'did','do','does','each','even','every','first','for','from','had','has','have',
  'he','her','here','him','how','i','if','in','into','is','it','its','just','me',
  'more','most','much','my','not','now','of','only','on','other','or','over','our',
  'she','some','such','same','that','than','then','there','the','their','them',
  'they','these','those','this','to','through','under','up','us','very','was',
  'well','we','were','what','when','where','who','which','while','why','will',
  'with','would','yet','you','your',
]);

const STREAM_CONTINUATION_SUFFIXES = new Set([
  's','d','r','n','t','ed','er','es','ing','ion','ions','ist','ists',
  'ly','ment','ments','ness','ship','tion','tions',
]);

function shouldInsertStreamBoundarySpace(previous, next) {
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
  if (/[-‑–—][A-Za-z]{1,3}$/u.test(previousWord)) return false;
  if (/[-‑–—][A-Za-z]{1,3}$/u.test(previous)) return false;
  // Dictionary guard
  if (previousWord.length >= 3 && nextWord.length >= 3 && isKnownWord((previousWord + nextWord).toLowerCase())) return false;
  if (previousWord.length === 1) return false;
  if (/^[A-Z]/.test(nextWord)) return true;
  const nextLower = nextWord.toLowerCase();
  if (STREAM_BOUNDARY_JOINER_WORDS.has(nextLower)) return true;
  if (STREAM_CONTINUATION_SUFFIXES.has(nextLower)) return false;
  if (previousWord.length >= 3 && nextWord.length >= 3 && /^[a-z]/.test(nextWord)) return true;
  return false;
}

// ── Stream query ──

async function queryStream(prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const rawChunks = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = event.split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => { let v = l.slice(5); if (v.startsWith(' ')) v = v.slice(1); return v; });
      const data = dataLines.join('\n');
      if (!data || data === '[DONE]') { boundary = buffer.indexOf('\n\n'); continue; }
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          rawChunks.push(content);
        }
      } catch {}
      boundary = buffer.indexOf('\n\n');
    }
  }

  return rawChunks;
}

// ── Analysis ──

function analyzeBoundaries(chunks) {
  const naiveJoined = chunks.join('');
  const boundaries = [];

  for (let i = 0; i < chunks.length - 1; i++) {
    const prev = chunks[i];
    const next = chunks[i + 1];
    const prevChar = prev.at(-1);
    const nextChar = next[0];

    // Only look at boundaries where both sides are non-whitespace alpha chars
    const isAlphaAlpha = /[A-Za-z]/.test(prevChar) && /[A-Za-z]/.test(nextChar);
    if (!isAlphaAlpha) continue;

    // Check if there's already whitespace
    if (/\s/.test(prevChar) || /\s/.test(nextChar)) continue;

    const heuristicSays = shouldInsertStreamBoundarySpace(prev, next);
    const prevTail = prev.slice(-20);
    const nextHead = next.slice(0, 20);

    boundaries.push({
      index: i,
      prevTail,
      nextHead,
      heuristicInserts: heuristicSays,
      prevWord: prev.match(/([A-Za-z]+)$/)?.[1] || '',
      nextWord: next.match(/^([A-Za-z]+)/)?.[1] || '',
    });
  }

  // Build repaired text
  let repaired = '';
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) { repaired = chunks[i]; continue; }
    if (shouldInsertStreamBoundarySpace(chunks.slice(0, i).join(''), chunks[i])) {
      // Simpler: use chunk-by-chunk buffered approach like the real code
    }
    repaired += chunks[i];
  }

  // Buffered approach (matches actual implementation)
  let bufferedResult = '';
  let pending = '';
  for (const chunk of chunks) {
    if (!pending) { pending = chunk; continue; }
    const emitted = shouldInsertStreamBoundarySpace(pending, chunk)
      ? pending + ' '
      : pending;
    bufferedResult += emitted;
    pending = chunk;
  }
  if (pending) bufferedResult += pending;

  return { naiveJoined, bufferedResult, boundaries };
}

// ── Main ──

const prompts = [
  'hi. what vendor and version of model are you?',
  'Hi. In 2-3 sentences, explain why the sky appears blue.',
  'hi',
  'can you read me the first few pages of moby dick',
  'what model are you',
  'Explain photosynthesis in 3-4 sentences.',
  'Write a short paragraph about the history of the internet.',
  'What causes rainbows to appear after a rainstorm?',
];

// Run each prompt twice for more data
const allPrompts = [...prompts, ...prompts];

let totalBoundaries = 0;
let totalInsertions = 0;
let dictionaryBlocks = []; // dictionary guard prevented a space insertion
let suspiciousMerges = []; // alpha+alpha with no space, heuristic says no
let insertions = []; // heuristic says yes

console.log(`Querying ${MODEL} with ${allPrompts.length} prompts...\n`);

for (let i = 0; i < allPrompts.length; i++) {
  const prompt = allPrompts[i];
  const runLabel = i < prompts.length ? `Run 1` : `Run 2`;
  process.stdout.write(`[${i + 1}/${allPrompts.length}] "${prompt.slice(0, 50)}..." (${runLabel}) `);

  try {
    const chunks = await queryStream(prompt);
    const { naiveJoined, bufferedResult, boundaries } = analyzeBoundaries(chunks);

    console.log(`- ${chunks.length} chunks, ${boundaries.length} alpha-alpha boundaries`);

    totalBoundaries += boundaries.length;

    for (const b of boundaries) {
      // Check if dictionary would block this
      const dictBlocked = b.prevWord.length >= 3 && b.nextWord.length >= 3 &&
        isKnownWord((b.prevWord + b.nextWord).toLowerCase());

      if (b.heuristicInserts) {
        totalInsertions++;
        insertions.push({
          prompt: prompt.slice(0, 40),
          prev: b.prevTail,
          next: b.nextHead,
          prevWord: b.prevWord,
          nextWord: b.nextWord,
        });
      } else {
        if (dictBlocked) {
          dictionaryBlocks.push({
            prompt: prompt.slice(0, 40),
            prev: b.prevTail,
            next: b.nextHead,
            prevWord: b.prevWord,
            nextWord: b.nextWord,
            concat: (b.prevWord + b.nextWord).toLowerCase(),
          });
        }
        // Flag if both words are >= 3 chars (likely separate words that got merged)
        if (b.prevWord.length >= 3 && b.nextWord.length >= 3 &&
            !STREAM_CONTINUATION_SUFFIXES.has(b.nextWord.toLowerCase()) && !dictBlocked) {
          suspiciousMerges.push({
            prompt: prompt.slice(0, 40),
            prev: b.prevTail,
            next: b.nextHead,
            prevWord: b.prevWord,
            nextWord: b.nextWord,
          });
        }
      }
    }

    // Show naive vs repaired for this prompt
    const naivePreview = naiveJoined.slice(0, 120).replace(/\n/g, '\\n');
    const repairedPreview = bufferedResult.slice(0, 120).replace(/\n/g, '\\n');
    if (naivePreview !== repairedPreview) {
      console.log(`  NAIVE:    ${naivePreview}`);
      console.log(`  REPAIRED: ${repairedPreview}`);
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }

  // Delay to avoid rate limiting (free tier: 16/min)
  await new Promise(r => setTimeout(r, 4000));
}

console.log('\n' + '='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log(`Total alpha-alpha boundaries examined: ${totalBoundaries}`);
console.log(`Heuristic inserted space: ${totalInsertions}`);
console.log(`Dictionary blocks (concat is a known word → kept joined): ${dictionaryBlocks.length}`);
console.log(`Suspicious merges (heuristic said no, but words >=3 chars): ${suspiciousMerges.length}`);

if (insertions.length > 0) {
  console.log('\n── SPACE INSERTIONS (heuristic says: insert space) ──');
  for (const ins of insertions) {
    console.log(`  "${ins.prevWord}" + "${ins.nextWord}"  ← [${ins.prev}] + [${ins.next}]`);
  }
}

if (dictionaryBlocks.length > 0) {
  console.log('\n── DICTIONARY BLOCKS (concat recognized as word → no space) ──');
  for (const d of dictionaryBlocks) {
    console.log(`  "${d.prevWord}" + "${d.nextWord}" = "${d.concat}"  ← [${d.prev}] + [${d.next}]`);
  }
}

if (suspiciousMerges.length > 0) {
  console.log('\n── SUSPICIOUS MERGES (heuristic says: no space, but both words >=3 chars) ──');
  for (const m of suspiciousMerges) {
    console.log(`  "${m.prevWord}" + "${m.nextWord}"  ← [${m.prev}] + [${m.next}]`);
  }
}

// Classify outcomes
console.log('\n── HEURISTIC PERFORMANCE ──');
console.log(`True positives (correct insertions): manually review SPACE INSERTIONS above`);
console.log(`False negatives (missed spaces): manually review SUSPICIOUS MERGES above`);
console.log(`False positives (wrong insertions): check SPACE INSERTIONS for compound words / suffixes`);
