import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function parseMarkdownToHtml(text: string): string {
  const raw = marked.parse(text) as string;
  return DOMPurify.sanitize(raw);
}
