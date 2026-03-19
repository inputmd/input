import type { ReaderAiFileEntry } from './reader_ai_tools';

interface BuildCodexBridgePromptOptions {
  source: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  mode?: 'default' | 'prompt_list';
  summary?: string;
  currentDocPath?: string | null;
  projectFiles?: ReaderAiFileEntry[] | null;
  editModeCurrentDocOnly?: boolean;
}

export function buildCodexBridgeDeveloperInstructions(options: BuildCodexBridgePromptOptions): string {
  if (options.editModeCurrentDocOnly) {
    return [
      'You are Editor AI inside Input.',
      'You must only use the text supplied in the user input.',
      'Do not use filesystem, shell, network, MCP, or any external tools.',
      'Return only the replacement text for the requested inline edit.',
      'Do not wrap the answer in markdown fences.',
      'Do not add commentary before or after the replacement text.',
    ].join('\n');
  }

  if (options.mode === 'prompt_list') {
    return [
      'You are Reader AI inside Input.',
      'You are continuing an inline AI conversation embedded inside a document.',
      'You must only use the text supplied in the user input.',
      'Do not use filesystem, shell, MCP, or any external tools other than the built-in web search tool when needed.',
      'Prioritize coherence with the inline conversation over broad document analysis.',
      'You do not have document context for this turn.',
      'If the user asks about current events, recent changes, live facts, or other time-sensitive information, you may use built-in web search.',
      'Respond in plain text. Keep the answer concise, but short paragraphs are allowed.',
      'Do not output tables.',
      'Avoid markdown-heavy formatting unless the user explicitly asks for it.',
    ].join('\n');
  }

  return [
    'You are Reader AI inside Input.',
    'You must only use the text supplied in the user input.',
    'Do not use filesystem, shell, network, MCP, or any external tools.',
    'For questions, answer clearly in markdown.',
    'If the user is asking for edits, rewrites, or code/document changes, append one machine-readable block at the very end using exactly this format:',
    '<input-staged-changes>{"assistant_message":"...","suggested_commit_message":"...","changes":[{"path":"...","type":"edit|create|delete","content":"..."}]}</input-staged-changes>',
    'Rules for that block:',
    '- assistant_message must contain the user-facing explanation.',
    '- suggested_commit_message should be a concise conventional commit message when possible.',
    '- For edit and create changes, content must be the full final file content.',
    '- For delete changes, omit content.',
    '- Do not include diff hunks; provide complete file contents.',
    '- Do not emit the block unless the user is asking for concrete file or document changes.',
  ].join('\n');
}

function formatConversation(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  summary?: string,
): string {
  const lines: string[] = [];
  if (summary?.trim()) {
    lines.push('Conversation summary:');
    lines.push(summary.trim());
    lines.push('');
  }
  lines.push('Conversation transcript:');
  for (const message of messages) {
    lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}:`);
    lines.push(message.content.trim());
    lines.push('');
  }
  return lines.join('\n').trim();
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n[truncated ${content.length - maxChars} chars]`;
}

export function buildCodexBridgeInput(options: BuildCodexBridgePromptOptions): string {
  const sections: string[] = [];
  sections.push('Input context for this turn.');

  if (options.projectFiles && options.projectFiles.length > 0) {
    sections.push('');
    sections.push(`Project mode is enabled. ${options.projectFiles.length} file(s) are available.`);
    if (options.currentDocPath) sections.push(`Current document path: ${options.currentDocPath}`);
    for (const file of options.projectFiles) {
      sections.push('');
      sections.push(`File: ${file.path}`);
      sections.push('```');
      sections.push(truncateContent(file.content, 60_000));
      sections.push('```');
    }
  } else if (options.mode === 'prompt_list') {
    sections.push('');
    sections.push('Prompt-list mode is enabled.');
  } else {
    sections.push('');
    sections.push(`Current document path: ${options.currentDocPath || 'current-document.md'}`);
    sections.push('Document content:');
    sections.push('```');
    sections.push(truncateContent(options.source, 80_000));
    sections.push('```');
  }

  sections.push('');
  sections.push(formatConversation(options.messages, options.summary));
  return sections.join('\n');
}

interface ParsedCodexBridgeChange {
  path: string;
  type: 'edit' | 'create' | 'delete';
  content?: string;
}

export interface ParsedCodexBridgeStructuredOutput {
  assistantMessage: string;
  suggestedCommitMessage?: string;
  changes: ParsedCodexBridgeChange[];
}

const STAGED_CHANGES_RE = /<input-staged-changes>\s*([\s\S]*?)\s*<\/input-staged-changes>\s*$/i;

export function parseCodexBridgeStructuredOutput(raw: string): ParsedCodexBridgeStructuredOutput | null {
  const match = raw.match(STAGED_CHANGES_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as {
      assistant_message?: unknown;
      suggested_commit_message?: unknown;
      changes?: Array<{ path?: unknown; type?: unknown; content?: unknown }>;
    };
    if (!Array.isArray(parsed.changes)) return null;
    const changes = parsed.changes
      .map((change) => {
        const path = typeof change.path === 'string' ? change.path.trim() : '';
        const type = typeof change.type === 'string' ? change.type : '';
        const content = typeof change.content === 'string' ? change.content : undefined;
        if (!path) return null;
        if (type !== 'edit' && type !== 'create' && type !== 'delete') return null;
        if (type !== 'delete' && typeof content !== 'string') return null;
        return { path, type, ...(content !== undefined ? { content } : {}) } as ParsedCodexBridgeChange;
      })
      .filter((change): change is ParsedCodexBridgeChange => change !== null);
    if (changes.length === 0) return null;

    const assistantMessage =
      typeof parsed.assistant_message === 'string' && parsed.assistant_message.trim()
        ? parsed.assistant_message.trim()
        : raw.replace(STAGED_CHANGES_RE, '').trim();

    return {
      assistantMessage,
      suggestedCommitMessage:
        typeof parsed.suggested_commit_message === 'string' && parsed.suggested_commit_message.trim()
          ? parsed.suggested_commit_message.trim()
          : undefined,
      changes,
    };
  } catch {
    return null;
  }
}
