export interface MarkdownFrontMatterBlock {
  body: string;
  content: string;
  error: string | null;
}

export interface ParsedDocumentEditors {
  editors: string[];
  error: string | null;
}

function countIndent(value: string): number {
  let indent = 0;
  for (const char of value) {
    if (char === ' ') indent += 1;
    else if (char === '\t') indent += 2;
    else break;
  }
  return indent;
}

function stripMatchingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1).trim();
    }
  }
  return value.trim();
}

function splitCommaSeparatedValues(value: string): string[] {
  return value
    .split(',')
    .map((part) => stripMatchingQuotes(part.trim()))
    .filter(Boolean);
}

function parseEditorListValue(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const listSource = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1).trim() : trimmed;
  if (!listSource) return [];
  const values = splitCommaSeparatedValues(listSource);
  if (values.length === 0) return [];
  const editors = values.map(normalizeGitHubHandle);
  return editors.every((editor): editor is string => Boolean(editor)) ? editors : null;
}

function parseIndentedEditorList(
  lines: string[],
  startIndex: number,
  parentIndent: number,
): { values: string[]; nextIndex: number; error: string | null } {
  const values: string[] = [];
  let childIndent: number | null = null;
  let index = startIndex;

  for (; index < lines.length; index += 1) {
    const current = lines[index];
    if (!current.trim()) continue;

    const indent = countIndent(current);
    if (indent <= parentIndent) break;
    if (childIndent == null) childIndent = indent;
    if (indent !== childIndent) {
      return { values: [], nextIndex: index, error: 'Could not parse editors front matter' };
    }

    const trimmed = current.trim();
    if (!trimmed.startsWith('-')) {
      return { values: [], nextIndex: index, error: 'Could not parse editors front matter' };
    }

    const editor = normalizeGitHubHandle(trimmed.slice(1).trim());
    if (!editor) {
      return { values: [], nextIndex: index, error: 'Could not parse editors front matter' };
    }
    values.push(editor);
  }

  if (values.length === 0) {
    return { values: [], nextIndex: index, error: 'Could not parse editors front matter' };
  }

  return { values, nextIndex: index, error: null };
}

export function normalizeGitHubHandle(raw: string): string | null {
  const trimmed = raw.trim();
  const normalized = stripMatchingQuotes(trimmed).replace(/^@+/, '');
  if (!normalized) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalized) && !/^[A-Za-z0-9]$/.test(normalized)) {
    return null;
  }
  return normalized.toLowerCase();
}

export function parseMarkdownFrontMatterBlock(source: string): MarkdownFrontMatterBlock | null {
  const lines = source.split(/\r?\n/);
  if (lines.length < 3) return null;
  if (lines[0].trim() !== '---') return null;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line !== '---' && line !== '...') continue;
    return {
      body: lines.slice(1, index).join('\n'),
      content: lines.slice(index + 1).join('\n'),
      error: null,
    };
  }

  return {
    body: '',
    content: source,
    error: 'Could not parse front matter',
  };
}

export function parseDocumentEditorsFromMarkdown(markdown: string): ParsedDocumentEditors {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/^(?:[ \t]*\r?\n)+/, '');
  const frontMatter = parseMarkdownFrontMatterBlock(normalized);
  if (!frontMatter) return { editors: [], error: null };
  if (frontMatter.error) return { editors: [], error: frontMatter.error };

  const seen = new Set<string>();
  const editors: string[] = [];
  const lines = frontMatter.body.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const match = /^([ \t]*)editors\s*:\s*(.*)$/.exec(current);
    if (!match) continue;

    const parentIndent = countIndent(match[1]);
    const value = match[2].trim();
    let parsedEditors: string[] | null = null;
    if (value) {
      parsedEditors = parseEditorListValue(value);
      if (!parsedEditors) return { editors: [], error: 'Could not parse editors front matter' };
    } else {
      const parsedList = parseIndentedEditorList(lines, index + 1, parentIndent);
      if (parsedList.error) return { editors: [], error: parsedList.error };
      parsedEditors = parsedList.values;
      index = parsedList.nextIndex - 1;
    }

    for (const editor of parsedEditors) {
      if (seen.has(editor)) continue;
      seen.add(editor);
      editors.push(editor);
    }
  }

  return { editors, error: null };
}

export function canGitHubUserEditMarkdownDocument(markdown: string, githubLogin: string): boolean {
  const normalizedLogin = normalizeGitHubHandle(githubLogin);
  if (!normalizedLogin) return false;
  const parsed = parseDocumentEditorsFromMarkdown(markdown);
  if (parsed.error) return false;
  return parsed.editors.includes(normalizedLogin);
}

export function validateEditorsPreserved(originalMarkdown: string, newMarkdown: string): string | null {
  const original = parseDocumentEditorsFromMarkdown(originalMarkdown);
  if (original.error) return original.error;
  const updated = parseDocumentEditorsFromMarkdown(newMarkdown);
  if (updated.error) return 'New content has invalid editors front matter';
  if (updated.editors.length === 0 && original.editors.length > 0) {
    return 'Editors list cannot be removed';
  }
  const origSorted = [...original.editors].sort();
  const newSorted = [...updated.editors].sort();
  if (origSorted.length !== newSorted.length || origSorted.some((e, i) => e !== newSorted[i])) {
    return 'Editors list cannot be modified';
  }
  return null;
}
