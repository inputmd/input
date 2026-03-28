import test from 'ava';
import { type BracePromptPanelState, canBracePromptGenerateMore } from '../../src/components/use_brace_prompt_panel.ts';

function makePanel(optionCount: number, loading = false): BracePromptPanelState {
  return {
    request: {
      prompt: 'finish this',
      from: 0,
      to: 13,
      documentContent: 'today {finish this}',
      paragraphTail: '',
      mode: 'replace',
      candidateCount: 5,
      excludeOptions: [],
      chatMessages: [],
    },
    options: Array.from({ length: optionCount }, (_, index) => `option ${index + 1}`),
    draftOption: '',
    selectedIndex: 0,
    loading,
    error: null,
    top: 0,
    left: 0,
    maxWidth: 320,
    flipped: false,
    cursorTop: 0,
    chatMessages: [],
    chatInputValue: '',
  };
}

test('canBracePromptGenerateMore becomes available after the first five and stops at ten total', (t) => {
  t.false(canBracePromptGenerateMore(makePanel(4)));
  t.true(canBracePromptGenerateMore(makePanel(5)));
  t.true(canBracePromptGenerateMore(makePanel(9)));
  t.false(canBracePromptGenerateMore(makePanel(10)));
  t.false(canBracePromptGenerateMore(makePanel(5, true)));
});
