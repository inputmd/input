import test from 'ava';
import { toggleNthMarkdownTaskCheckbox } from '../../src/preview_task_list.ts';

test('toggleNthMarkdownTaskCheckbox toggles the requested bullet task marker', (t) => {
  const markdown = ['- [ ] first', '- [x] second', '- [ ] third'].join('\n');

  const first = toggleNthMarkdownTaskCheckbox(markdown, 0);
  t.deepEqual(first, { from: 3, to: 4, insert: 'x', nextChecked: true });

  const second = toggleNthMarkdownTaskCheckbox(markdown, 1);
  t.deepEqual(second, { from: 15, to: 16, insert: ' ', nextChecked: false });
});

test('toggleNthMarkdownTaskCheckbox supports nested ordered and blockquoted tasks', (t) => {
  const markdown = ['> 1. [ ] quoted first', '>    - [x] quoted second'].join('\n');

  const first = toggleNthMarkdownTaskCheckbox(markdown, 0);
  const second = toggleNthMarkdownTaskCheckbox(markdown, 1);

  t.deepEqual(first, { from: 6, to: 7, insert: 'x', nextChecked: true });
  t.deepEqual(second, { from: 30, to: 31, insert: ' ', nextChecked: false });
});

test('toggleNthMarkdownTaskCheckbox returns null when the task index is missing', (t) => {
  t.is(toggleNthMarkdownTaskCheckbox('- [ ] only', 1), null);
  t.is(toggleNthMarkdownTaskCheckbox('plain paragraph', 0), null);
});
