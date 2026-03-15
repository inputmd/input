import { css } from '@codemirror/lang-css';
import { html as htmlLanguage } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import type { Extension } from '@codemirror/state';
import { markdownCodeLanguageSupport } from './codemirror_markdown';

function extensionForFileName(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const match = /\.([^.]+)$/i.exec(fileName);
  return match ? match[1].toLowerCase() : null;
}

export interface DetectedLanguage {
  label: string;
  extensions: Extension[];
}

export function detectedLanguageForFileName(
  fileName: string | null | undefined,
  options?: { includeMarkdown?: boolean },
): DetectedLanguage | null {
  const extension = extensionForFileName(fileName);
  switch (extension) {
    case 'js':
    case 'jsonc':
    case 'json':
      return { label: 'JavaScript', extensions: [javascript()] };
    case 'ts':
      return { label: 'TypeScript', extensions: [javascript({ typescript: true })] };
    case 'jsx':
      return { label: 'JSX', extensions: [javascript({ jsx: true })] };
    case 'tsx':
      return { label: 'TSX', extensions: [javascript({ typescript: true, jsx: true })] };
    case 'py':
      return { label: 'Python', extensions: [python()] };
    case 'css':
    case 'scss':
      return { label: 'CSS', extensions: [css()] };
    case 'html':
      return { label: 'HTML', extensions: [htmlLanguage()] };
    case 'yml':
    case 'yaml':
      return { label: 'YAML', extensions: [yaml()] };
    case 'md':
    case 'mdown':
    case 'mdwn':
    case 'markdown':
    case 'mdx':
      if (options?.includeMarkdown === false) return null;
      return {
        label: 'Markdown',
        extensions: [markdownCodeLanguageSupport()],
      };
    default:
      return null;
  }
}
