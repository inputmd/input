import test from 'ava';
import {
  emojiCompletionsForQuery,
  findEmojiCompletionMatch,
} from '../../src/components/codemirror_emoji_completion.ts';

test('findEmojiCompletionMatch detects shortcode queries after valid boundaries', (t) => {
  const text = 'Hello :gri';
  const match = findEmojiCompletionMatch(text, text.length);

  t.deepEqual(match, {
    from: 6,
    to: 10,
    query: 'gri',
  });
});

test('findEmojiCompletionMatch ignores colons inside URLs and words', (t) => {
  t.is(findEmojiCompletionMatch('https://example.com', 'https://'.length), null);
  t.is(findEmojiCompletionMatch('word:smile', 'word:smile'.length), null);
});

test('emojiCompletionsForQuery returns matching emoji options', (t) => {
  const options = emojiCompletionsForQuery('grin', 10);
  const labels = options.map((option) => option.label);

  t.true(labels.includes(':grinning:'));
  t.true(options.every((option) => typeof option.apply === 'string' && option.apply.length > 0));
});

test('emojiCompletionsForQuery matches emoji tags and descriptions', (t) => {
  const options = emojiCompletionsForQuery('happy', 20);

  t.true(options.length > 0);
  t.true(options.some((option) => option.label === ':grinning:'));
});
