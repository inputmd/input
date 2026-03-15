import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { gemoji } from 'gemoji';

interface EmojiEntry {
  emoji: string;
  names: string[];
  tags: string[];
  description: string;
}

interface EmojiCompletionMatch {
  from: number;
  to: number;
  query: string;
}

const emojiEntries = (gemoji as EmojiEntry[])
  .filter((entry) => entry.names.length > 0)
  .slice()
  .sort((left, right) => left.names[0].localeCompare(right.names[0]));

const MAX_EMOJI_COMPLETIONS = 60;

function isEmojiNameCharacter(char: string): boolean {
  return /[a-z0-9_+-]/i.test(char);
}

function isEmojiTriggerBoundary(char: string | undefined): boolean {
  return char == null || /\s|[([{<"'`]/.test(char);
}

function emojiScore(entry: EmojiEntry, query: string): number | null {
  if (query.length === 0) return 3;
  const normalizedDescription = entry.description.toLowerCase();

  for (const name of entry.names) {
    if (name === query) return 0;
    if (name.startsWith(query)) return 1;
    if (name.includes(query)) return 2;
  }

  for (const tag of entry.tags) {
    if (tag === query) return 3;
    if (tag.startsWith(query)) return 4;
    if (tag.includes(query)) return 5;
  }

  if (normalizedDescription.includes(query)) return 6;
  return null;
}

function emojiCompletionForEntry(entry: EmojiEntry): Completion {
  const primaryName = entry.names[0];
  const aliases = entry.names.map((name) => `:${name}:`).join(', ');
  const tagSummary = entry.tags.length > 0 ? `tags: ${entry.tags.join(', ')}` : '';

  return {
    label: `:${primaryName}:`,
    apply: entry.emoji,
    detail: entry.emoji,
    type: 'text',
    info: tagSummary ? `${entry.description}\n${aliases}\n${tagSummary}` : `${entry.description}\n${aliases}`,
  };
}

export function findEmojiCompletionMatch(text: string, position: number): EmojiCompletionMatch | null {
  let cursor = position;
  while (cursor > 0 && isEmojiNameCharacter(text[cursor - 1] ?? '')) {
    cursor -= 1;
  }

  const triggerIndex = cursor - 1;
  if (triggerIndex < 0 || text[triggerIndex] !== ':') return null;

  const boundaryIndex = triggerIndex - 1;
  if (!isEmojiTriggerBoundary(text[boundaryIndex])) return null;

  return {
    from: triggerIndex,
    to: position,
    query: text.slice(cursor, position).toLowerCase(),
  };
}

export function emojiCompletionsForQuery(query: string, limit = MAX_EMOJI_COMPLETIONS): Completion[] {
  const normalizedQuery = query.trim().toLowerCase();

  return emojiEntries
    .map((entry) => ({ entry, score: emojiScore(entry, normalizedQuery) }))
    .filter((candidate): candidate is { entry: EmojiEntry; score: number } => candidate.score != null)
    .slice()
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      return left.entry.names[0].localeCompare(right.entry.names[0]);
    })
    .slice(0, limit)
    .map(({ entry }) => emojiCompletionForEntry(entry));
}

export function emojiCompletionSource(context: CompletionContext): CompletionResult | null {
  const { state, pos, explicit } = context;
  const line = state.doc.lineAt(pos);
  const match = findEmojiCompletionMatch(line.text, pos - line.from);
  if (!match) return null;

  if (!explicit && match.query.length === 0) return null;

  const options = emojiCompletionsForQuery(match.query);
  if (options.length === 0) return null;

  return {
    from: line.from + match.from,
    to: line.from + match.to,
    options,
    validFor: /^:[a-z0-9_+-]*$/i,
  };
}
