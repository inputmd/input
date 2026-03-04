export interface ClaudeTraceToolCall {
  tool: string;
  args: string;
  result: string;
  model?: string;
}

export interface ClaudeTraceMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ClaudeTraceToolCall[];
  duration?: string;
}

export interface ClaudeTraceExport {
  metadata: {
    model: string;
    user: string;
    workingDirectory: string;
    exportedAt: string;
  };
  messages: ClaudeTraceMessage[];
}

const TOOL_PATTERNS: { tool: string; regex: RegExp }[] = [
  { tool: 'Bash', regex: /^Bash\((.+)\)$/ },
  { tool: 'Write', regex: /^Write\((.+)\)$/ },
  { tool: 'Read', regex: /^Read (.+)$/ },
  { tool: 'Web Search', regex: /^Web Search\((.+)\)$/ },
  { tool: 'Fetch', regex: /^Fetch\((.+)\)$/ },
  { tool: 'Task Output', regex: /^Task Output (.+)$/ },
  { tool: 'Agent', regex: /^Agent\((.+?)\)\s+(.+)$/ },
];

const PARTIAL_TOOL_PATTERNS: { tool: string; regex: RegExp }[] = [
  { tool: 'Bash', regex: /^Bash\((.+)$/ },
  { tool: 'Web Search', regex: /^Web Search\((.+)$/ },
];

const AGENT_COMPLETED_RE = /^Agent "(.+)" completed$/;
const CLAUDE_EXPORT_HEADER_RE = /(?:^|\n)╭[^\n]*Claude Code[^\n]*\n/;

type ParseState = 'idle' | 'user' | 'assistant' | 'tool_call' | 'tool_args_partial' | 'tool_result';

export function looksLikeClaudeExportTrace(input: string): boolean {
  return CLAUDE_EXPORT_HEADER_RE.test(input);
}

export function parseClaudeExportTrace(input: string, fileName?: string): ClaudeTraceExport {
  const rawLines = input.split('\n');
  const metadata = parseMetadata(rawLines, fileName);
  const messages: ClaudeTraceMessage[] = [];

  let startIdx = 0;
  for (let i = 0; i < rawLines.length; i++) {
    if (isHeaderLine(rawLines[i])) {
      startIdx = i + 1;
    } else if (startIdx > 0 && rawLines[i].trim() === '') {
      startIdx = i + 1;
      break;
    }
  }

  let state: ParseState = 'idle';
  let currentContent: string[] = [];
  let currentToolCalls: ClaudeTraceToolCall[] = [];
  let currentToolCall: ClaudeTraceToolCall | null = null;

  function joinContent(lines: string[]): string {
    const copy = [...lines];
    while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop();
    return copy.join('\n').trim();
  }

  function flushMessage(): void {
    if (state === 'user' && currentContent.length > 0) {
      messages.push({
        role: 'user',
        content: joinContent(currentContent),
      });
    } else if (state !== 'idle') {
      if (currentToolCall) {
        currentToolCalls.push(currentToolCall);
        currentToolCall = null;
      }
      const content = joinContent(currentContent);
      const msg: ClaudeTraceMessage = { role: 'assistant', content };
      if (currentToolCalls.length > 0) msg.toolCalls = currentToolCalls;
      if (content || (msg.toolCalls && msg.toolCalls.length > 0)) {
        messages.push(msg);
      }
    }

    currentContent = [];
    currentToolCalls = [];
    currentToolCall = null;
    state = 'idle';
  }

  for (let i = startIdx; i < rawLines.length; i++) {
    const line = rawLines[i];

    if (line.startsWith('✻')) {
      flushMessage();
      if (messages.length > 0) messages[messages.length - 1].duration = line.slice(1).trim();
      continue;
    }

    if (line.startsWith('❯')) {
      flushMessage();
      state = 'user';
      currentContent.push(stripPrefix(line, '❯'));
      continue;
    }

    if (line.startsWith('  ⎿') || line.startsWith(' ⎿') || line.startsWith('⎿')) {
      if (state === 'tool_args_partial' && currentToolCall) {
        currentToolCall.args = currentToolCall.args.replace(/\)$/, '').replace(/…\)$/, '…');
        state = 'tool_call';
      }
      const resultText = line.replace(/^\s*⎿\s?/, '');
      if (currentToolCall) {
        currentToolCall.result = currentToolCall.result ? `${currentToolCall.result}\n${resultText}` : resultText;
        state = 'tool_result';
      }
      continue;
    }

    if (line.startsWith('⏺')) {
      const text = stripPrefix(line, '⏺');
      const agentCompleted = text.match(AGENT_COMPLETED_RE);
      if (agentCompleted) {
        if (currentToolCall) {
          currentToolCalls.push(currentToolCall);
          currentToolCall = null;
        }
        flushMessage();
        messages.push({
          role: 'system',
          content: `Agent "${agentCompleted[1]}" completed`,
        });
        state = 'idle';
        continue;
      }

      const parsedToolCall = parseToolCall(text);
      if (parsedToolCall) {
        if (state === 'idle') {
          state = 'tool_call';
        } else if (state === 'user') {
          flushMessage();
          state = 'tool_call';
        }
        if (currentToolCall) currentToolCalls.push(currentToolCall);
        currentToolCall = parsedToolCall.call;
        state = parsedToolCall.partial ? 'tool_args_partial' : 'tool_call';
        continue;
      }

      if (state === 'user') flushMessage();
      if (state === 'idle') {
        state = 'assistant';
        currentContent.push(text);
      } else if (state === 'assistant') {
        currentContent.push('');
        currentContent.push(text);
      } else {
        if (currentToolCall) {
          currentToolCalls.push(currentToolCall);
          currentToolCall = null;
        }
        state = 'assistant';
        currentContent.push(text);
      }
      continue;
    }

    if (state === 'user') {
      currentContent.push(line.replace(/^\s{1,2}/, ''));
    } else if (state === 'assistant') {
      currentContent.push(line.replace(/^\s{1,2}/, ''));
    } else if (state === 'tool_result' && currentToolCall) {
      const trimmed = line.replace(/^\s+/, '');
      if (trimmed) {
        currentToolCall.result = currentToolCall.result ? `${currentToolCall.result}\n${trimmed}` : trimmed;
      }
    } else if ((state === 'tool_call' || state === 'tool_args_partial') && currentToolCall) {
      const trimmed = line.replace(/^\s+/, '');
      if (trimmed) {
        if (state === 'tool_args_partial') {
          if (trimmed.endsWith(')')) {
            currentToolCall.args += ` ${trimmed.slice(0, -1)}`;
            state = 'tool_call';
          } else {
            currentToolCall.args += ` ${trimmed}`;
          }
        } else {
          currentToolCall.args += ` ${trimmed}`;
        }
      }
    }
  }

  flushMessage();
  return { metadata, messages };
}

export function renderClaudeTraceMarkdown(trace: ClaudeTraceExport): string {
  const out: string[] = [];

  for (const message of trace.messages) {
    if (message.role === 'system') continue;
    const roleLabel =
      message.role === 'assistant'
        ? trace.metadata.model || 'Assistant'
        : message.role[0].toUpperCase() + message.role.slice(1);
    out.push(`## ${roleLabel}`);
    out.push('');
    if (message.content.trim()) out.push(message.content.trim(), '');
    const activitySummary = summarizeMessageActivity(message);
    if (activitySummary) out.push(`_${activitySummary}_`, '');
  }

  return out.join('\n').trim();
}

function summarizeMessageActivity(message: ClaudeTraceMessage): string {
  const parts: string[] = [];
  let webSearchCount = 0;
  let fetchCount = 0;

  for (const call of message.toolCalls ?? []) {
    if (call.tool === 'Web Search') {
      webSearchCount += 1;
      continue;
    }
    if (call.tool === 'Fetch') {
      fetchCount += 1;
      continue;
    }
    if (call.tool === 'Agent') {
      const name = call.args.trim();
      if (name) parts.push(`Started agent: ${name}.`);
      continue;
    }
    if (call.tool === 'Write') {
      const target = call.args.trim();
      if (target) parts.push(`Wrote to ${target}.`);
      continue;
    }
    if (call.tool === 'Bash') {
      const firstWord = call.args.trim().split(/\s+/)[0] ?? '';
      parts.push(firstWord ? `Ran a shell command: ${firstWord}.` : 'Ran a shell command.');
    }
  }

  if (webSearchCount > 0) {
    parts.push(webSearchCount === 1 ? 'Ran a web search.' : `Ran ${webSearchCount} web searches.`);
  }
  if (fetchCount > 0) {
    parts.push(fetchCount === 1 ? 'Fetched a web page.' : `Fetched ${fetchCount} web pages.`);
  }
  return parts.join(' ');
}

function parseMetadata(lines: string[], fileName?: string): ClaudeTraceExport['metadata'] {
  const metadata: ClaudeTraceExport['metadata'] = {
    model: '',
    user: '',
    workingDirectory: '',
    exportedAt: new Date().toISOString().slice(0, 10),
  };

  for (const line of lines.slice(0, 15)) {
    const infoLineMatch = line.match(/((?:Opus|Sonnet|Haiku)\s+[\d.]+).*·\s*(.+?)\s*│/);
    if (infoLineMatch) {
      metadata.model = infoLineMatch[1];
      const segments = line.split('·');
      if (segments.length >= 3) metadata.user = segments[segments.length - 1].replace(/[│\s]+/g, ' ').trim();
    } else {
      const modelMatch = line.match(/((?:Opus|Sonnet|Haiku)\s+[\d.]+)/);
      if (modelMatch && !metadata.model) metadata.model = modelMatch[1];
    }

    if (!metadata.user) {
      const welcomeMatch = line.match(/Welcome back (.+?)!/);
      if (welcomeMatch) metadata.user = welcomeMatch[1].trim();
    }

    const dirMatch = line.match(/│\s+(~\/[^\s│]+|\/[^\s│]+)\s+│/);
    if (dirMatch) metadata.workingDirectory = dirMatch[1].trim();
  }

  const dateMatch = (fileName ?? '').match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) metadata.exportedAt = dateMatch[1];
  return metadata;
}

function isHeaderLine(line: string): boolean {
  return /[╭╮╰╯│─]/.test(line);
}

function stripPrefix(line: string, prefix: string): string {
  const idx = line.indexOf(prefix);
  if (idx === -1) return line;
  return line.slice(idx + prefix.length).replace(/^\s/, '');
}

function parseToolCall(text: string): { call: ClaudeTraceToolCall; partial: boolean } | null {
  for (const { tool, regex } of TOOL_PATTERNS) {
    const m = text.match(regex);
    if (!m) continue;
    if (tool === 'Agent') {
      return {
        call: { tool, args: m[1], result: '', model: m[2] },
        partial: false,
      };
    }
    return {
      call: { tool, args: m[1], result: '' },
      partial: false,
    };
  }

  for (const { tool, regex } of PARTIAL_TOOL_PATTERNS) {
    const m = text.match(regex);
    if (!m) continue;
    return {
      call: { tool, args: m[1], result: '' },
      partial: true,
    };
  }
  return null;
}
