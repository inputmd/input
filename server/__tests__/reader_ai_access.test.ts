import test from 'ava';
import {
  canAccessReaderAiModel,
  getReaderAiModelSource,
  readerAiModelAccessScopeForAuthenticated,
} from '../reader_ai_access.ts';

const paidModelIds = new Set(['anthropic/claude-opus-4.6', 'google/gemini-3-pro-preview']);

test('anonymous Reader AI access is limited to free models', (t) => {
  t.true(canAccessReaderAiModel('meta-llama/llama-3.3-70b-instruct:free', false, paidModelIds));
  t.false(canAccessReaderAiModel('anthropic/claude-opus-4.6', false, paidModelIds));
});

test('authenticated Reader AI access allows both free and paid models', (t) => {
  t.true(canAccessReaderAiModel('meta-llama/llama-3.3-70b-instruct:free', true, paidModelIds));
  t.true(canAccessReaderAiModel('anthropic/claude-opus-4.6', true, paidModelIds));
});

test('reader ai model source and cache scope split free-only vs authenticated access', (t) => {
  t.is(getReaderAiModelSource('google/gemini-3-pro-preview', paidModelIds), 'paid');
  t.is(getReaderAiModelSource('meta-llama/llama-3.3-70b-instruct:free', paidModelIds), 'free');
  t.is(readerAiModelAccessScopeForAuthenticated(false), 'free_only');
  t.is(readerAiModelAccessScopeForAuthenticated(true), 'with_paid');
});
