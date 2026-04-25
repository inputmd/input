export const PI_SESSION_CURRENT_VERSION = 3;

export type PiSessionFilterMode = 'default' | 'full' | 'minimal';

export interface PiSessionParseError {
  lineNumber: number;
  message: string;
}

export interface PiSessionHeader {
  type: 'session';
  id: string;
  version?: number;
  [key: string]: unknown;
}

export interface PiSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

export interface PiSessionParseResult {
  header: PiSessionHeader | null;
  entries: PiSessionEntry[];
  parseErrors: PiSessionParseError[];
  firstUserMessage: string | null;
}

export interface PiSessionTreeNode {
  entry: PiSessionEntry;
  children: PiSessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

export interface PiSessionTreeRow {
  id: string;
  entry: PiSessionEntry;
  text: string;
  label?: string;
  labelTimestamp?: string;
  indentColumns: number;
  isCurrentLeaf: boolean;
  isSelected: boolean;
  isFolded: boolean;
  isFoldable: boolean;
  role: string | null;
}

interface ToolCallSummary {
  name: string;
  arguments: unknown;
}

interface FlattenCandidate {
  node: PiSessionTreeNode;
  parentId: string | null;
}

export interface PiSessionParseOptions {
  light?: boolean;
  maxLines?: number;
}

const LIGHT_PARSE_MAX_LINES = 75;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function normalizePiSessionText(value: string): string {
  return value.replace(/[\n\t]/g, ' ').trim();
}

export function normalizePiSessionMarkdownText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim();
}

function generatedEntryId(index: number, usedIds: Set<string>): string {
  let id = `migrated-${index}`;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `migrated-${index}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function normalizeEntryIds(entries: Record<string, unknown>[]): void {
  const usedIds = new Set<string>();
  for (const entry of entries) {
    const id = asString(entry.id);
    if (id && !usedIds.has(id)) {
      usedIds.add(id);
    }
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === 'session') continue;
    const id = asString(entry.id);
    if (!id) {
      entry.id = generatedEntryId(index, usedIds);
    }
    if (entry.parentId !== null && typeof entry.parentId !== 'string') {
      entry.parentId = null;
    }
  }
}

function migrateV1ToV2(entries: Record<string, unknown>[]): void {
  const usedIds = new Set<string>();
  let previousId: string | null = null;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === 'session') {
      entry.version = 2;
      continue;
    }

    const id = generatedEntryId(index, usedIds);
    entry.id = id;
    entry.parentId = previousId;
    previousId = id;

    if (entry.type === 'compaction' && typeof entry.firstKeptEntryIndex === 'number') {
      const targetEntry = entries[entry.firstKeptEntryIndex];
      if (targetEntry && targetEntry.type !== 'session' && typeof targetEntry.id === 'string') {
        entry.firstKeptEntryId = targetEntry.id;
      }
      delete entry.firstKeptEntryIndex;
    }
  }
}

function migrateV2ToV3(entries: Record<string, unknown>[]): void {
  for (const entry of entries) {
    if (entry.type === 'session') {
      entry.version = 3;
      continue;
    }

    if (entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'hookMessage') {
      entry.message.role = 'custom';
    }
  }
}

function migrateEntries(entries: Record<string, unknown>[]): void {
  const header = entries.find((entry) => entry.type === 'session');
  const version = typeof header?.version === 'number' ? header.version : 1;
  if (version < 2) migrateV1ToV2(entries);
  if (version < 3) migrateV2ToV3(entries);
  normalizeEntryIds(entries);
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

function findFirstUserMessage(entries: Record<string, unknown>[]): string | null {
  for (const entry of entries) {
    if (entry.type !== 'message' || !isRecord(entry.message) || entry.message.role !== 'user') continue;
    const content = normalizePiSessionText(extractContent(entry.message.content));
    if (content) return content;
  }
  return null;
}

export function parsePiSessionJsonl(content: string, options: PiSessionParseOptions = {}): PiSessionParseResult {
  const parsedEntries: Record<string, unknown>[] = [];
  const parseErrors: PiSessionParseError[] = [];
  const maxLines = options.light ? Math.max(1, options.maxLines ?? LIGHT_PARSE_MAX_LINES) : null;
  const lines = jsonlLines(content, maxLines);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) {
        parsedEntries.push(parsed);
      } else {
        parseErrors.push({ lineNumber: index + 1, message: 'Line is not a JSON object' });
      }
    } catch (error) {
      parseErrors.push({
        lineNumber: index + 1,
        message: error instanceof Error ? error.message : 'Invalid JSON',
      });
    }
  }

  migrateEntries(parsedEntries);
  const firstUserMessage = findFirstUserMessage(parsedEntries);

  const firstEntry = parsedEntries[0];
  const header =
    firstEntry?.type === 'session' && typeof firstEntry.id === 'string' ? (firstEntry as PiSessionHeader) : null;
  if (!header) return { header: null, entries: [], parseErrors, firstUserMessage: null };

  const entries = parsedEntries.filter(
    (entry): entry is PiSessionEntry =>
      entry.type !== 'session' && typeof entry.type === 'string' && typeof entry.id === 'string',
  );

  return { header, entries, parseErrors, firstUserMessage };
}

export function isPiSessionPath(path: string): boolean {
  return path.endsWith('.jsonl') && path.startsWith('.input/.pi/agent/sessions/');
}

export function getDefaultPiSessionLeafId(entries: PiSessionEntry[]): string | null {
  return entries.at(-1)?.id ?? null;
}

export function buildPiSessionTree(entries: PiSessionEntry[]): PiSessionTreeNode[] {
  const labelsById = new Map<string, string>();
  const labelTimestampsById = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'label') continue;
    const targetId = asString(entry.targetId);
    if (!targetId) continue;
    const label = asString(entry.label);
    if (label) {
      labelsById.set(targetId, label);
      if (typeof entry.timestamp === 'string') labelTimestampsById.set(targetId, entry.timestamp);
    } else {
      labelsById.delete(targetId);
      labelTimestampsById.delete(targetId);
    }
  }

  const nodeMap = new Map<string, PiSessionTreeNode>();
  for (const entry of entries) {
    nodeMap.set(entry.id, {
      entry,
      children: [],
      label: labelsById.get(entry.id),
      labelTimestamp: labelTimestampsById.get(entry.id),
    });
  }

  const roots: PiSessionTreeNode[] = [];
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

function timestampSortValue(entry: PiSessionEntry): number {
  if (typeof entry.timestamp !== 'string') return 0;
  const time = new Date(entry.timestamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function collectToolCalls(entries: PiSessionEntry[]): Map<string, ToolCallSummary> {
  const toolCalls = new Map<string, ToolCallSummary>();
  for (const entry of entries) {
    if (entry.type !== 'message' || !isRecord(entry.message) || entry.message.role !== 'assistant') continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'toolCall') continue;
      const id = asString(block.id);
      const name = asString(block.name);
      if (id && name) toolCalls.set(id, { name, arguments: block.arguments });
    }
  }
  return toolCalls;
}

function flattenTreeCandidates(roots: PiSessionTreeNode[]): FlattenCandidate[] {
  const candidates: FlattenCandidate[] = [];

  const visit = (node: PiSessionTreeNode, parentId: string | null) => {
    candidates.push({ node, parentId });
    const children = [...node.children].sort(
      (left, right) => timestampSortValue(left.entry) - timestampSortValue(right.entry),
    );
    for (const child of children) visit(child, node.entry.id);
  };

  const orderedRoots = [...roots].sort(
    (left, right) => timestampSortValue(left.entry) - timestampSortValue(right.entry),
  );
  for (const root of orderedRoots) visit(root, null);
  return candidates;
}

function entryRole(entry: PiSessionEntry): string | null {
  return entry.type === 'message' && isRecord(entry.message) && typeof entry.message.role === 'string'
    ? entry.message.role
    : null;
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0,
  );
}

function hasToolCallContent(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'toolCall');
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let result = '';
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      result += block.text;
    }
  }
  return result;
}

function isSettingsEntry(entry: PiSessionEntry): boolean {
  return (
    entry.type === 'label' ||
    entry.type === 'custom' ||
    entry.type === 'model_change' ||
    entry.type === 'thinking_level_change' ||
    entry.type === 'session_info'
  );
}

function passesFilter(node: PiSessionTreeNode, filterMode: PiSessionFilterMode, currentLeafId: string | null): boolean {
  const entry = node.entry;
  const role = entryRole(entry);
  const message = isRecord(entry.message) ? entry.message : {};

  if (
    filterMode === 'default' &&
    (role === 'toolResult' ||
      role === 'bashExecution' ||
      (entry.type === 'message' && role === 'assistant' && hasToolCallContent(message.content)))
  ) {
    return false;
  }

  if (entry.type === 'message' && role === 'assistant' && entry.id !== currentLeafId && isRecord(entry.message)) {
    const stopReason = asString(message.stopReason);
    const isErrorOrAborted = Boolean(stopReason && stopReason !== 'stop' && stopReason !== 'toolUse');
    if (!hasTextContent(message.content) && !isErrorOrAborted) return false;
  }

  switch (filterMode) {
    case 'full':
      return true;
    case 'default':
    case 'minimal':
      return !isSettingsEntry(entry);
    default:
      return true;
  }
}

function formatToolCall(name: string, args: unknown): string {
  const record = isRecord(args) ? args : {};
  const path = String(record.path || record.file_path || '');
  switch (name) {
    case 'read': {
      const offset = record.offset;
      const limit = record.limit;
      let display = path;
      if (offset !== undefined || limit !== undefined) {
        const start = typeof offset === 'number' ? offset : 1;
        const end = typeof limit === 'number' ? start + limit - 1 : '';
        display += `:${start}${end ? `-${end}` : ''}`;
      }
      return `[read: ${display}]`;
    }
    case 'write':
      return `[write: ${path}]`;
    case 'edit':
      return `[edit: ${path}]`;
    case 'bash': {
      const rawCommand = String(record.command || '');
      const command = normalizePiSessionText(rawCommand).slice(0, 50);
      return `[bash: ${command}${rawCommand.length > 50 ? '...' : ''}]`;
    }
    case 'grep':
      return `[grep: /${String(record.pattern || '')}/ in ${String(record.path || '.')}]`;
    case 'find':
      return `[find: ${String(record.pattern || '')} in ${String(record.path || '.')}]`;
    case 'ls':
      return `[ls: ${String(record.path || '.')}]`;
    default: {
      const serialized = JSON.stringify(args ?? {});
      const truncated = serialized.slice(0, 40);
      return `[${name}: ${truncated}${serialized.length > 40 ? '...' : ''}]`;
    }
  }
}

function displayText(node: PiSessionTreeNode, toolCalls: Map<string, ToolCallSummary>): string {
  const entry = node.entry;
  switch (entry.type) {
    case 'message': {
      const message = isRecord(entry.message) ? entry.message : {};
      const role = asString(message.role) ?? 'message';
      if (role === 'user') return `user: ${normalizePiSessionText(extractContent(message.content))}`;
      if (role === 'assistant') {
        const content = normalizePiSessionMarkdownText(extractContent(message.content));
        if (content) return `assistant: ${content}`;
        if (message.stopReason === 'aborted') return 'assistant: (aborted)';
        if (typeof message.errorMessage === 'string')
          return `assistant: ${normalizePiSessionText(message.errorMessage).slice(0, 80)}`;
        return 'assistant: (no content)';
      }
      if (role === 'toolResult') {
        const toolCallId = asString(message.toolCallId);
        const toolCall = toolCallId ? toolCalls.get(toolCallId) : undefined;
        return toolCall
          ? formatToolCall(toolCall.name, toolCall.arguments)
          : `[${asString(message.toolName) ?? 'tool'}]`;
      }
      if (role === 'bashExecution') return `[bash]: ${normalizePiSessionText(asString(message.command) ?? '')}`;
      return `[${role}]`;
    }
    case 'custom_message':
      return `[${asString(entry.customType) ?? 'custom'}]: ${normalizePiSessionText(extractContent(entry.content))}`;
    case 'compaction': {
      const tokensBefore = typeof entry.tokensBefore === 'number' ? entry.tokensBefore : 0;
      return `[compaction: ${Math.round(tokensBefore / 1000)}k tokens]`;
    }
    case 'branch_summary':
      return `[branch summary]: ${normalizePiSessionText(asString(entry.summary) ?? '')}`;
    case 'model_change':
      return `[model: ${asString(entry.modelId) ?? ''}]`;
    case 'thinking_level_change':
      return `[thinking: ${asString(entry.thinkingLevel) ?? ''}]`;
    case 'custom':
      return `[custom: ${asString(entry.customType) ?? ''}]`;
    case 'label':
      return `[label: ${asString(entry.label) ?? '(cleared)'}]`;
    case 'session_info':
      return `[title: ${asString(entry.name) || 'empty'}]`;
    default:
      return `[${entry.type}]`;
  }
}

function rowIndentColumns(indent: number, multipleRoots: boolean): number {
  const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
  return displayIndent * 2;
}

export function buildPiSessionTreeRows(options: {
  entries: PiSessionEntry[];
  currentLeafId: string | null;
  selectedEntryId: string | null;
  filterMode: PiSessionFilterMode;
  foldedIds: ReadonlySet<string>;
}): PiSessionTreeRow[] {
  const tree = buildPiSessionTree(options.entries);
  const candidates = flattenTreeCandidates(tree);
  const visibleCandidates = candidates.filter(({ node }) => {
    if (!passesFilter(node, options.filterMode, options.currentLeafId)) return false;
    return true;
  });

  const visibleIds = new Set(visibleCandidates.map(({ node }) => node.entry.id));
  const candidateById = new Map(candidates.map((candidate) => [candidate.node.entry.id, candidate]));
  const visibleChildrenByParent = new Map<string | null, PiSessionTreeNode[]>();
  const visibleParentById = new Map<string, string | null>();
  visibleChildrenByParent.set(null, []);

  const nearestVisibleAncestor = (candidate: FlattenCandidate): string | null => {
    let parentId = candidate.parentId;
    while (parentId) {
      if (visibleIds.has(parentId)) return parentId;
      parentId = candidateById.get(parentId)?.parentId ?? null;
    }
    return null;
  };

  for (const candidate of visibleCandidates) {
    const ancestorId = nearestVisibleAncestor(candidate);
    visibleParentById.set(candidate.node.entry.id, ancestorId);
    const children = visibleChildrenByParent.get(ancestorId) ?? [];
    children.push(candidate.node);
    visibleChildrenByParent.set(ancestorId, children);
  }

  const toolCalls = collectToolCalls(options.entries);
  const rows: PiSessionTreeRow[] = [];
  const roots = visibleChildrenByParent.get(null) ?? [];
  const multipleRoots = roots.length > 1;
  const visit = (node: PiSessionTreeNode, indent: number) => {
    const visibleChildren = visibleChildrenByParent.get(node.entry.id) ?? [];
    const isFolded = options.foldedIds.has(node.entry.id);
    const visibleParentId = visibleParentById.get(node.entry.id) ?? null;
    const visibleSiblings = visibleChildrenByParent.get(visibleParentId) ?? [];
    const isFoldable = visibleChildren.length > 0 && visibleSiblings.length > 1;
    rows.push({
      id: node.entry.id,
      entry: node.entry,
      text: displayText(node, toolCalls),
      label: node.label,
      labelTimestamp: node.labelTimestamp,
      indentColumns: rowIndentColumns(indent, multipleRoots),
      isCurrentLeaf: node.entry.id === options.currentLeafId,
      isSelected: node.entry.id === options.selectedEntryId,
      isFolded,
      isFoldable,
      role: entryRole(node.entry),
    });
    if (isFolded) return;
    const multipleChildren = visibleChildren.length > 1;
    const childIndent = multipleChildren ? indent + 1 : indent;
    visibleChildren.forEach((child) => {
      visit(child, childIndent);
    });
  };

  roots.forEach((root) => {
    visit(root, multipleRoots ? 1 : 0);
  });
  return rows;
}
