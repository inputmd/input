import type { SessionTranscriptFilterMode, SessionTranscriptTreeRow } from './components/SessionTranscriptTreeView.tsx';
import { normalizePiSessionMarkdownText, normalizePiSessionText } from './pi_session.ts';

export interface ClaudeSessionParseError {
  lineNumber: number;
  message: string;
}

export interface ClaudeSessionEntry {
  id: string;
  parentId: string | null;
  type: string;
  role: string | null;
  timestamp?: string;
  sessionId?: string;
  raw: Record<string, unknown>;
}

export interface ClaudeSessionParseResult {
  entries: ClaudeSessionEntry[];
  parseErrors: ClaudeSessionParseError[];
  firstUserMessage: string | null;
  sessionId: string | null;
}

interface ClaudeSessionTreeNode {
  entry: ClaudeSessionEntry;
  children: ClaudeSessionTreeNode[];
}

interface VisibleClaudeSessionTreeItem {
  id: string;
  node: ClaudeSessionTreeNode | null;
  children: VisibleClaudeSessionTreeItem[];
  hiddenCount?: number;
}

interface ProjectedClaudeSessionTree {
  items: VisibleClaudeSessionTreeItem[];
  hiddenCount: number;
}

interface ToolCallSummary {
  name: string;
  input: unknown;
}

interface ToolResultSummary {
  isError: boolean;
}

interface CoalescedToolResults {
  byToolUseId: Map<string, ToolResultSummary>;
  entryIds: Set<string>;
}

export interface ClaudeSessionParseOptions {
  light?: boolean;
  maxLines?: number;
}

const LIGHT_PARSE_MAX_LINES = 75;
const DEFAULT_HIDDEN_SYSTEM_DIRECTIVES = new Set(['attachment', 'file-history-snapshot', 'permission-mode']);
const DEFAULT_HIDDEN_ENTRY_TYPES = new Set([
  'attachment',
  'file-history-snapshot',
  'permission-mode',
  'summary',
  'system',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function jsonlLines(content: string, maxLines: number | null): string[] {
  if (maxLines === null) return content.split(/\r?\n/);
  const lines: string[] = [];
  let lineStart = 0;

  for (let index = 0; index <= content.length && lines.length < maxLines; index += 1) {
    const char = content[index];
    if (index !== content.length && char !== '\n') continue;
    let lineEnd = index;
    if (lineEnd > lineStart && content[lineEnd - 1] === '\r') lineEnd -= 1;
    lines.push(content.slice(lineStart, lineEnd));
    lineStart = index + 1;
  }

  return lines;
}

function generatedEntryId(index: number): string {
  return `claude-line-${index}`;
}

function messageFor(entry: ClaudeSessionEntry | Record<string, unknown>): Record<string, unknown> {
  const maybeRaw = (entry as { raw?: unknown }).raw;
  const raw = isRecord(maybeRaw) ? maybeRaw : (entry as unknown as Record<string, unknown>);
  return isRecord(raw.message) ? raw.message : raw;
}

function contentFor(entry: ClaudeSessionEntry): unknown {
  const message = messageFor(entry);
  return message.content ?? entry.raw.content;
}

function extractTextContent(content: unknown, includeToolResults = true): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (includeToolResults && block.type === 'tool_result') {
      parts.push(extractTextContent(block.content, true));
    }
  }
  return parts.join('');
}

function hasToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result');
}

function hasToolUseContent(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_use');
}

function isSystemReminderText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>');
}

function isLocalCommandCaveatText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<local-command-caveat>') && trimmed.endsWith('</local-command-caveat>');
}

function isSystemReminderEntry(entry: ClaudeSessionEntry): boolean {
  if (entry.role !== 'user') return false;
  const text = extractTextContent(contentFor(entry), false);
  return isSystemReminderText(text);
}

function isLocalCommandCaveatEntry(entry: ClaudeSessionEntry): boolean {
  if (entry.role !== 'user') return false;
  const text = extractTextContent(contentFor(entry), false);
  return isLocalCommandCaveatText(text);
}

function isBracketOnlyDirectiveEntry(entry: ClaudeSessionEntry): boolean {
  if (entry.role !== 'user') return false;
  const text = extractTextContent(contentFor(entry), false).trim();
  return /^\[[A-Za-z0-9][A-Za-z0-9-]*\]$/.test(text);
}

function isXmlLikeWrapperEntry(entry: ClaudeSessionEntry): boolean {
  if (entry.role !== 'user') return false;
  const text = extractTextContent(contentFor(entry), false).trim();
  if (!text) return false;

  let remaining = text;
  while (remaining.length > 0) {
    const match = /^<([A-Za-z][A-Za-z0-9-]*)>[\s\S]*?<\/\1>\s*/.exec(remaining);
    if (!match) return false;
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return true;
}

function bracketedDirectiveName(text: string): string | null {
  const match = /^\[([^\]\s:]+)(?:\]|\s*:)/.exec(text.trim());
  return match?.[1] ?? null;
}

function isDefaultHiddenSystemDirectiveEntry(entry: ClaudeSessionEntry): boolean {
  if (entry.role !== 'user') return false;
  const name = bracketedDirectiveName(extractTextContent(contentFor(entry), false));
  return Boolean(name && DEFAULT_HIDDEN_SYSTEM_DIRECTIVES.has(name.toLowerCase()));
}

function isClaudeTextToolCallEntry(entry: ClaudeSessionEntry): boolean {
  if (entry.role !== 'user') return false;
  const text = extractTextContent(contentFor(entry), false).trim();
  return /^\[(?:ToolSearch|WebSearch|[A-Z][A-Za-z0-9]*):\s*[[{]/.test(text);
}

function isEmptyAssistantEntry(entry: ClaudeSessionEntry): boolean {
  if (entry.role !== 'assistant') return false;
  const content = contentFor(entry);
  return !normalizePiSessionText(extractTextContent(content, false)) && !hasToolUseContent(content);
}

function isAuthErrorAssistantEntry(entry: ClaudeSessionEntry): boolean {
  if (entry.role !== 'assistant') return false;
  if (entry.raw.isApiErrorMessage === true && entry.raw.apiErrorStatus === 401) return true;
  const text = normalizePiSessionText(extractTextContent(contentFor(entry), false));
  return text.startsWith('Please run /login') && text.includes('authentication_error');
}

function findFirstUserMessage(entries: ClaudeSessionEntry[]): string | null {
  for (const entry of entries) {
    if (entryRole(entry) !== 'user') continue;
    if (isMetadataEntry(entry) || isClaudeTextToolCallEntry(entry)) continue;
    const content = contentFor(entry);
    if (hasToolResultContent(content)) continue;
    const text = normalizePiSessionText(extractTextContent(content, false));
    if (text) return text;
  }
  return null;
}

function entryRole(entry: ClaudeSessionEntry): string | null {
  const content = contentFor(entry);
  if (isSystemReminderEntry(entry)) return 'systemReminder';
  if (isDefaultHiddenSystemDirectiveEntry(entry)) return 'systemDirective';
  if (isClaudeTextToolCallEntry(entry)) return 'textToolCall';
  if (entry.role === 'user' && hasToolResultContent(content)) return 'toolResult';
  if (
    entry.role === 'assistant' &&
    !normalizePiSessionText(extractTextContent(content, false)) &&
    hasToolUseContent(content)
  ) {
    return 'toolUse';
  }
  return entry.role;
}

export function parseClaudeSessionJsonl(
  content: string,
  options: ClaudeSessionParseOptions = {},
): ClaudeSessionParseResult {
  const entries: ClaudeSessionEntry[] = [];
  const parseErrors: ClaudeSessionParseError[] = [];
  const maxLines = options.light ? Math.max(1, options.maxLines ?? LIGHT_PARSE_MAX_LINES) : null;
  const lines = jsonlLines(content, maxLines);
  let previousId: string | null = null;
  let sessionId: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      parseErrors.push({
        lineNumber: index + 1,
        message: error instanceof Error ? error.message : 'Invalid JSON',
      });
      continue;
    }

    if (!isRecord(parsed)) {
      parseErrors.push({ lineNumber: index + 1, message: 'Line is not a JSON object' });
      continue;
    }

    const type = asString(parsed.type) ?? 'entry';
    const id = asString(parsed.uuid) ?? asString(parsed.id) ?? generatedEntryId(index + 1);
    const parentUuid = asString(parsed.parentUuid) ?? asString(parsed.parentId);
    const parentId = parentUuid === id ? null : (parentUuid ?? (type === 'summary' ? asString(parsed.leafUuid) : null));
    const message = isRecord(parsed.message) ? parsed.message : null;
    const role = asString(message?.role) ?? (type === 'user' || type === 'assistant' ? type : null);
    const timestamp = asString(parsed.timestamp) ?? asString(message?.timestamp) ?? undefined;
    const entrySessionId = asString(parsed.sessionId);
    if (!sessionId && entrySessionId) sessionId = entrySessionId;

    entries.push({
      id,
      parentId: parentId ?? previousId,
      type,
      role,
      ...(timestamp ? { timestamp } : {}),
      ...(entrySessionId ? { sessionId: entrySessionId } : {}),
      raw: parsed,
    });
    previousId = id;
  }

  return {
    entries,
    parseErrors,
    firstUserMessage: findFirstUserMessage(entries),
    sessionId,
  };
}

export function isClaudeSessionPath(path: string): boolean {
  return path.endsWith('.jsonl') && path.startsWith('.input/.claude/projects/');
}

export function getDefaultClaudeSessionLeafId(entries: ClaudeSessionEntry[]): string | null {
  return entries.at(-1)?.id ?? null;
}

function timestampSortValue(entry: ClaudeSessionEntry): number {
  if (typeof entry.timestamp !== 'string') return 0;
  const time = new Date(entry.timestamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function buildClaudeSessionTree(entries: ClaudeSessionEntry[]): ClaudeSessionTreeNode[] {
  const nodeMap = new Map<string, ClaudeSessionTreeNode>();
  for (const entry of entries) {
    nodeMap.set(entry.id, { entry, children: [] });
  }

  const roots: ClaudeSessionTreeNode[] = [];
  for (const entry of entries) {
    const node = nodeMap.get(entry.id);
    if (!node) continue;
    if (entry.parentId === null || entry.parentId === entry.id) {
      roots.push(node);
      continue;
    }
    const parent = nodeMap.get(entry.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    node.children.sort((left, right) => timestampSortValue(left.entry) - timestampSortValue(right.entry));
    stack.push(...node.children);
  }

  return roots;
}

function collectToolCalls(entries: ClaudeSessionEntry[]): Map<string, ToolCallSummary> {
  const toolCalls = new Map<string, ToolCallSummary>();
  for (const entry of entries) {
    const content = contentFor(entry);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const id = asString(block.id);
      const name = asString(block.name);
      if (id && name) toolCalls.set(id, { name, input: block.input });
    }
  }
  return toolCalls;
}

function collectCoalescedToolResults(
  entries: ClaudeSessionEntry[],
  toolCalls: Map<string, ToolCallSummary>,
): CoalescedToolResults {
  const byToolUseId = new Map<string, ToolResultSummary>();
  const entryIds = new Set<string>();

  for (const entry of entries) {
    const content = contentFor(entry);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const toolUseId = asString(block.tool_use_id);
      if (!toolUseId || !toolCalls.has(toolUseId)) continue;
      entryIds.add(entry.id);
      byToolUseId.set(toolUseId, { isError: block.is_error === true });
    }
  }

  return { byToolUseId, entryIds };
}

function isMetadataEntry(entry: ClaudeSessionEntry): boolean {
  return (
    DEFAULT_HIDDEN_ENTRY_TYPES.has(entry.type) ||
    entry.raw.isMeta === true ||
    isSystemReminderEntry(entry) ||
    isDefaultHiddenSystemDirectiveEntry(entry) ||
    isLocalCommandCaveatEntry(entry) ||
    isBracketOnlyDirectiveEntry(entry) ||
    isXmlLikeWrapperEntry(entry)
  );
}

function passesFilter(entry: ClaudeSessionEntry, filterMode: SessionTranscriptFilterMode): boolean {
  if (filterMode === 'default') {
    const role = entryRole(entry);
    if (role === 'toolUse' || role === 'toolResult' || role === 'textToolCall') return false;
  }

  switch (filterMode) {
    case 'full':
      return true;
    case 'default':
    case 'minimal':
      return (
        !isMetadataEntry(entry) &&
        !isClaudeTextToolCallEntry(entry) &&
        !isEmptyAssistantEntry(entry) &&
        !isAuthErrorAssistantEntry(entry)
      );
    default:
      return true;
  }
}

function truncateToolDisplayValue(value: string, maxLength: number): string {
  const normalized = normalizePiSessionText(value);
  return `${normalized.slice(0, maxLength)}${normalized.length > maxLength ? '...' : ''}`;
}

function isSearchToolName(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return normalizedName === 'websearch' || normalizedName === 'toolsearch';
}

function formatSearchToolCall(name: string, input: unknown): string | null {
  if (!isSearchToolName(name) || !isRecord(input)) return null;
  const query = input.query;
  if (typeof query !== 'string') return null;
  return `[${name}: ${truncateToolDisplayValue(query, 80)}]`;
}

function successfulToolResultLabel(name: string): string {
  return isSearchToolName(name) ? 'success' : 'result';
}

function formatToolCall(name: string, input: unknown): string {
  const searchToolCall = formatSearchToolCall(name, input);
  if (searchToolCall) return searchToolCall;

  const record = isRecord(input) ? input : {};
  const normalizedName = name.toLowerCase();
  const path = String(record.file_path || record.path || record.notebook_path || '');

  switch (normalizedName) {
    case 'read':
      return `[read: ${path}]`;
    case 'write':
      return `[write: ${path}]`;
    case 'edit':
    case 'multiedit':
      return `[edit: ${path}]`;
    case 'bash': {
      const rawCommand = String(record.command || '');
      const command = normalizePiSessionText(rawCommand).slice(0, 50);
      return `[bash: ${command}${rawCommand.length > 50 ? '...' : ''}]`;
    }
    case 'grep':
      return `[grep: ${String(record.pattern || '')} in ${String(record.path || '.')}]`;
    case 'glob':
      return `[glob: ${String(record.pattern || '')} in ${String(record.path || '.')}]`;
    case 'ls':
      return `[ls: ${String(record.path || '.')}]`;
    case 'todowrite':
      return '[todo write]';
    case 'task':
      return `[task: ${normalizePiSessionText(String(record.description || record.prompt || '')).slice(0, 50)}]`;
    case 'webfetch':
      return `[web fetch: ${String(record.url || '')}]`;
    default: {
      const serialized = JSON.stringify(input ?? {});
      const truncated = serialized.slice(0, 40);
      return `[${name}: ${truncated}${serialized.length > 40 ? '...' : ''}]`;
    }
  }
}

function formatToolUses(content: unknown, toolResults: Map<string, ToolResultSummary> = new Map()): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'tool_use') return [];
    const name = asString(block.name);
    if (!name) return [];
    const id = asString(block.id);
    const result = id ? toolResults.get(id) : undefined;
    const suffix = result ? (result.isError ? ' error' : ` ${successfulToolResultLabel(name)}`) : '';
    return [`${formatToolCall(name, block.input)}${suffix}`];
  });
}

function formatToolResults(content: unknown, toolCalls: Map<string, ToolCallSummary>): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'tool_result') return [];
    const toolUseId = asString(block.tool_use_id);
    const toolCall = toolUseId ? toolCalls.get(toolUseId) : undefined;
    if (toolCall) {
      return [`${formatToolCall(toolCall.name, toolCall.input)} ${successfulToolResultLabel(toolCall.name)}`];
    }
    const text = normalizePiSessionText(extractTextContent(block.content, true));
    return [`[tool result: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}]`];
  });
}

function formatClaudeTextToolCall(text: string): string {
  const normalized = normalizePiSessionText(text);
  const match = /^\[(WebSearch|ToolSearch):\s*([\s\S]+)\](?:\s+(result|success|error))?$/i.exec(normalized);
  if (!match) return normalized;

  const [, rawName, rawInput, rawStatus] = match;
  if (!rawName || !rawInput) return normalized;
  try {
    const parsedInput = JSON.parse(rawInput);
    const toolCall = formatSearchToolCall(rawName, parsedInput);
    if (!toolCall) return normalized;
    if (rawStatus === 'error') return `${toolCall} error`;
    if (rawStatus === 'result' || rawStatus === 'success') return `${toolCall} success`;
    return toolCall;
  } catch {
    return normalized;
  }
}

function displayText(
  node: ClaudeSessionTreeNode,
  toolCalls: Map<string, ToolCallSummary>,
  toolResults: Map<string, ToolResultSummary>,
): string {
  const entry = node.entry;
  const content = contentFor(entry);
  const role = entryRole(entry);

  if (role === 'user') {
    const text = normalizePiSessionText(extractTextContent(content, false));
    return text ? `user: ${text}` : 'user: (no content)';
  }
  if (role === 'assistant') {
    const text = normalizePiSessionMarkdownText(extractTextContent(content, false));
    if (text) return `assistant: ${text}`;
    const toolUses = formatToolUses(content, toolResults);
    return toolUses.length > 0 ? `assistant: ${toolUses.join(' ')}` : 'assistant: (no content)';
  }
  if (role === 'toolUse') {
    const toolUses = formatToolUses(content, toolResults);
    return toolUses.length > 0 ? toolUses.join(' ') : '[tool use]';
  }
  if (role === 'toolResult') {
    const toolResults = formatToolResults(content, toolCalls);
    return toolResults.length > 0 ? toolResults.join(' ') : '[tool result]';
  }
  if (role === 'systemReminder') {
    return normalizePiSessionText(extractTextContent(content, false)) || '[system reminder]';
  }
  if (role === 'systemDirective' || role === 'textToolCall') {
    const text = extractTextContent(content, false);
    return role === 'textToolCall'
      ? formatClaudeTextToolCall(text) || `[${role}]`
      : normalizePiSessionText(text) || `[${role}]`;
  }
  if (entry.type === 'summary' && typeof entry.raw.summary === 'string') {
    return `[summary]: ${normalizePiSessionText(entry.raw.summary)}`;
  }
  if (entry.type === 'system') {
    return `[system]: ${normalizePiSessionText(extractTextContent(content, true))}`;
  }
  return `[${entry.type}]`;
}

function rowIndentColumns(indent: number, multipleRoots: boolean): number {
  const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
  return displayIndent * 2;
}

function entryMessageText(entry: ClaudeSessionEntry): string {
  return normalizePiSessionText(extractTextContent(contentFor(entry), false));
}

function buildContextualHiddenIds(entries: ClaudeSessionEntry[], tree: ClaudeSessionTreeNode[]): Set<string> {
  const hiddenIds = new Set<string>();
  const nodeById = new Map<string, ClaudeSessionTreeNode>();
  const indexById = new Map<string, number>();

  const visit = (node: ClaudeSessionTreeNode) => {
    nodeById.set(node.entry.id, node);
    for (const child of node.children) visit(child);
  };
  for (const root of tree) visit(root);
  entries.forEach((entry, index) => {
    indexById.set(entry.id, index);
  });

  const subtreeHasAuthError = (node: ClaudeSessionTreeNode): boolean => {
    if (isAuthErrorAssistantEntry(node.entry)) return true;
    return node.children.some((child) => subtreeHasAuthError(child));
  };

  const userEntriesByText = new Map<string, ClaudeSessionEntry[]>();
  for (const entry of entries) {
    if (entry.role !== 'user') continue;
    if (isMetadataEntry(entry) || isClaudeTextToolCallEntry(entry)) continue;
    const text = entryMessageText(entry);
    if (!text) continue;
    const matchingEntries = userEntriesByText.get(text) ?? [];
    matchingEntries.push(entry);
    userEntriesByText.set(text, matchingEntries);
  }

  for (const entry of entries) {
    if (entry.role !== 'user') continue;
    const text = entryMessageText(entry);
    if (!text) continue;
    const node = nodeById.get(entry.id);
    if (!node || !subtreeHasAuthError(node)) continue;
    const entryIndex = indexById.get(entry.id) ?? -1;
    const laterRetry = userEntriesByText
      .get(text)
      ?.some((candidate) => (indexById.get(candidate.id) ?? -1) > entryIndex);
    if (laterRetry) hiddenIds.add(entry.id);
  }

  return hiddenIds;
}

function shouldShowHiddenMetadataElision(projectedChildren: VisibleClaudeSessionTreeItem[]): boolean {
  return projectedChildren.length > 1;
}

function absorbHiddenCountIntoElision(
  items: VisibleClaudeSessionTreeItem[],
  hiddenCount: number,
): VisibleClaudeSessionTreeItem[] {
  if (items.length !== 1) return items;
  const [item] = items;
  if (!item || item.node !== null) return items;
  return [{ ...item, hiddenCount: (item.hiddenCount ?? 0) + hiddenCount }];
}

function hiddenMetadataText(hiddenCount: number): string {
  return hiddenCount === 1 ? 'hidden metadata' : `hidden metadata (${hiddenCount} entries)`;
}

export function buildClaudeSessionTreeRows(options: {
  entries: ClaudeSessionEntry[];
  currentLeafId: string | null;
  selectedEntryId: string | null;
  filterMode: SessionTranscriptFilterMode;
  foldedIds: ReadonlySet<string>;
}): SessionTranscriptTreeRow[] {
  const tree = buildClaudeSessionTree(options.entries);
  const contextualHiddenIds =
    options.filterMode === 'full' ? new Set<string>() : buildContextualHiddenIds(options.entries, tree);

  const toolCalls = collectToolCalls(options.entries);
  const coalescedToolResults =
    options.filterMode === 'full'
      ? { byToolUseId: new Map<string, ToolResultSummary>(), entryIds: new Set<string>() }
      : collectCoalescedToolResults(options.entries, toolCalls);
  const rows: SessionTranscriptTreeRow[] = [];
  const projectNode = (node: ClaudeSessionTreeNode): ProjectedClaudeSessionTree => {
    const childProjects = node.children.map((child) => projectNode(child));
    const projectedChildren = childProjects.flatMap((project) => project.items);
    const childHiddenCount = childProjects.reduce((sum, project) => sum + project.hiddenCount, 0);
    const isVisible =
      passesFilter(node.entry, options.filterMode) &&
      !contextualHiddenIds.has(node.entry.id) &&
      !coalescedToolResults.entryIds.has(node.entry.id);

    if (isVisible) {
      return {
        items: [
          {
            id: node.entry.id,
            node,
            children: projectedChildren,
          },
        ],
        hiddenCount: 0,
      };
    }

    const hiddenCount = childHiddenCount + 1;
    if (shouldShowHiddenMetadataElision(projectedChildren)) {
      return {
        items: [
          {
            id: `claude-hidden:${node.entry.id}`,
            node: null,
            children: projectedChildren,
            hiddenCount,
          },
        ],
        hiddenCount,
      };
    }

    return { items: absorbHiddenCountIntoElision(projectedChildren, 1), hiddenCount };
  };

  const roots = tree.flatMap((root) => projectNode(root).items);
  const multipleRoots = roots.length > 1;

  const visit = (item: VisibleClaudeSessionTreeItem, indent: number, siblings: VisibleClaudeSessionTreeItem[]) => {
    const visibleChildren = item.children;
    const isFolded = options.foldedIds.has(item.id);
    const isSynthetic = item.node === null;
    const isFoldable = visibleChildren.length > 0 && (siblings.length > 1 || isSynthetic);
    rows.push({
      id: item.id,
      text: item.node
        ? displayText(item.node, toolCalls, coalescedToolResults.byToolUseId)
        : hiddenMetadataText(item.hiddenCount ?? 1),
      indentColumns: rowIndentColumns(indent, multipleRoots),
      isCurrentLeaf: !isSynthetic && item.id === options.currentLeafId,
      isSelected: item.id === options.selectedEntryId,
      isFolded,
      isFoldable,
      isSynthetic,
      role: item.node ? entryRole(item.node.entry) : 'elision',
    });
    if (isFolded) return;
    const multipleChildren = visibleChildren.length > 1;
    const childIndent = multipleChildren ? indent + 1 : indent;
    visibleChildren.forEach((child) => {
      visit(child, childIndent, visibleChildren);
    });
  };

  roots.forEach((root) => {
    visit(root, multipleRoots ? 1 : 0, roots);
  });
  return rows;
}
