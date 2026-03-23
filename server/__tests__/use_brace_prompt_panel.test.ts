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
    },
    options: Array.from({ length: optionCount }, (_, index) => `option ${index + 1}`),
    draftOption: '',
    selectedIndex: 0,
    loading,
    error: null,
    top: 0,
    left: 0,
    maxWidth: 320,
  };
}

test('canBracePromptGenerateMore waits until the five candidates and extra overflow slot are filled', (t) => {
  t.false(canBracePromptGenerateMore(makePanel(5)));
  t.true(canBracePromptGenerateMore(makePanel(6)));
  t.false(canBracePromptGenerateMore(makePanel(6, true)));
});
