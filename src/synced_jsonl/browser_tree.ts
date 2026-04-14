import { compareByTimestampThenLine, summarizeText, summarizeUnknownValue } from './shared.ts';
import type {
  ClaudeCodeAssistantContentPart,
  ClaudeCodeJsonlEvent,
  ClaudeCodeToolResultContentPart,
  JsonRecord,
  OpenAiCodexAssistantMessage,
  OpenAiCodexJsonlEvent,
  OpenAiCodexTextContentPart,
  OpenAiCodexToolCallContentPart,
  ParsedSyncedJsonl,
  ParsedSyncedJsonlEntry,
  ParsedSyncedJsonlTreeNode,
} from './types.ts';

export type BrowserHistoryTone = 'default' | 'user' | 'assistant' | 'tool' | 'branch' | 'meta' | 'error';

export interface BrowserHistoryDisplay {
  lead: string;
  text?: string;
  tone: BrowserHistoryTone;
}

export interface BrowserHistorySelectableBase {
  key: string;
  lineNumber: number;
  raw: string;
  rawType: string;
  timestamp?: string;
  resolvedLabel?: string;
  display: BrowserHistoryDisplay;
  rawValue: unknown;
}

export interface BrowserHistoryStandaloneEntry extends BrowserHistorySelectableBase {
  kind: 'standalone';
}

export interface BrowserHistoryNode extends BrowserHistorySelectableBase {
  kind: 'node';
  id: string;
  parentId: string | null;
  relation: 'root' | 'child' | 'orphan';
  children: BrowserHistoryNode[];
}

export type BrowserHistorySelectableEntry = BrowserHistoryStandaloneEntry | BrowserHistoryNode;

export interface BrowserHistoryModel {
  kind: ParsedSyncedJsonl['kind'];
  label: string;
  roots: BrowserHistoryNode[];
  standaloneEntries: BrowserHistoryStandaloneEntry[];
  currentLeafId: string | null;
  defaultSelectedKey: string | null;
}

interface BrowserHistoryFlatGutter {
  position: number;
  show: boolean;
}

export interface BrowserHistoryFlatNode {
  node: BrowserHistoryNode;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  gutters: BrowserHistoryFlatGutter[];
  isVirtualRootChild: boolean;
  multipleRoots: boolean;
  isOnActivePath: boolean;
  isFoldable: boolean;
  isFolded: boolean;
}

function summarizeOpenAiTextParts(parts: OpenAiCodexTextContentPart[]): string | undefined {
  return summarizeText(parts.map((part) => part.text).join('\n'));
}

function summarizeOpenAiAssistantMessage(message: OpenAiCodexAssistantMessage): string | undefined {
  const textSummary = summarizeText(
    message.content
      .filter((part): part is OpenAiCodexTextContentPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n'),
  );
  if (textSummary) return textSummary;

  const toolNames = message.content
    .filter((part): part is OpenAiCodexToolCallContentPart => part.type === 'toolCall')
    .map((part) => part.name);
  if (toolNames.length > 0) return toolNames.join(', ');

  if (message.errorMessage) return summarizeText(message.errorMessage);
  if (message.stopReason === 'aborted') return '(aborted)';
  return summarizeText(message.stopReason);
}

function summarizeClaudeAssistantParts(parts: ClaudeCodeAssistantContentPart[]): string | undefined {
  const textSummary = summarizeText(
    parts
      .filter((part): part is Extract<ClaudeCodeAssistantContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n'),
  );
  if (textSummary) return textSummary;

  const toolNames = parts
    .filter((part): part is Extract<ClaudeCodeAssistantContentPart, { type: 'tool_use' }> => part.type === 'tool_use')
    .map((part) => part.name);
  if (toolNames.length > 0) return toolNames.join(', ');

  return undefined;
}

function summarizeClaudeToolResult(parts: ClaudeCodeToolResultContentPart[]): string | undefined {
  return summarizeText(parts.map((part) => part.content).join('\n'));
}

function formatOpenAiDisplay(entry: ParsedSyncedJsonlEntry<OpenAiCodexJsonlEvent>): BrowserHistoryDisplay {
  const event = entry.value;
  switch (event.type) {
    case 'session':
      return { tone: 'meta', lead: '[session]', text: summarizeText(event.cwd) };
    case 'model_change':
      return { tone: 'meta', lead: '[model]', text: `${event.provider}/${event.modelId}` };
    case 'thinking_level_change':
      return { tone: 'meta', lead: '[thinking]', text: event.thinkingLevel };
    case 'compaction':
      return {
        tone: 'meta',
        lead: event.tokensBefore ? `[compaction: ${Math.round(event.tokensBefore / 1000)}k tokens]` : '[compaction]',
        text: summarizeText(event.summary),
      };
    case 'branch_summary':
      return { tone: 'branch', lead: '[branch summary]:', text: summarizeText(event.summary) };
    case 'session_info':
      return { tone: 'meta', lead: '[title]', text: summarizeText(event.name) ?? '(cleared)' };
    case 'label':
      return {
        tone: 'meta',
        lead: '[label]',
        text: event.label ? `${event.targetId} -> ${event.label}` : `${event.targetId} -> (cleared)`,
      };
    case 'custom':
      return { tone: 'meta', lead: `[${event.customType}]`, text: summarizeUnknownValue(event.data) };
    case 'custom_message':
      return { tone: 'meta', lead: `[${event.customType}]`, text: summarizeUnknownValue(event.content) };
    case 'message':
      if (event.message.role === 'user') {
        return { tone: 'user', lead: 'user:', text: summarizeOpenAiTextParts(event.message.content) };
      }
      if (event.message.role === 'assistant') {
        return {
          tone: event.message.errorMessage ? 'error' : 'assistant',
          lead: 'assistant:',
          text: summarizeOpenAiAssistantMessage(event.message),
        };
      }
      return {
        tone: event.message.isError ? 'error' : 'tool',
        lead: `[${event.message.toolName}]`,
        text: summarizeOpenAiTextParts(event.message.content),
      };
  }
}

function formatClaudeDisplay(entry: ParsedSyncedJsonlEntry<ClaudeCodeJsonlEvent>): BrowserHistoryDisplay {
  const event = entry.value;
  if ('unsupported' in event) {
    const detail =
      summarizeUnknownValue(event) ??
      (typeof event.subtype === 'string'
        ? event.subtype
        : typeof event.operation === 'string'
          ? event.operation
          : undefined);
    return {
      tone: 'meta',
      lead: `[${event.type}]`,
      text: detail,
    };
  }

  switch (event.type) {
    case 'permission-mode':
      return { tone: 'meta', lead: '[permission]', text: event.permissionMode };
    case 'file-history-snapshot':
      return { tone: 'meta', lead: '[history snapshot]', text: event.isSnapshotUpdate ? 'update' : 'snapshot' };
    case 'attachment':
      return {
        tone: 'meta',
        lead: '[attachment]',
        text: summarizeUnknownValue(event.attachment) ?? event.attachment.type,
      };
    case 'assistant':
      return {
        tone: 'assistant',
        lead: 'assistant:',
        text: summarizeClaudeAssistantParts(event.message.content) ?? summarizeText(event.message.stop_reason),
      };
    case 'user': {
      if (typeof event.message.content === 'string') {
        return { tone: 'user', lead: 'user:', text: summarizeText(event.message.content) };
      }
      const toolResults = event.message.content.filter(
        (part): part is ClaudeCodeToolResultContentPart => part.type === 'tool_result',
      );
      if (toolResults.length > 0) {
        const hasError = toolResults.some((part) => part.is_error === true);
        return {
          tone: hasError ? 'error' : 'tool',
          lead: '[tool result]',
          text: summarizeClaudeToolResult(toolResults),
        };
      }
      return { tone: 'user', lead: 'user:', text: summarizeUnknownValue(event.message.content) };
    }
  }
}

function formatGenericDisplay(entry: ParsedSyncedJsonlEntry<JsonRecord>): BrowserHistoryDisplay {
  return {
    tone: 'default',
    lead: `[${entry.type}]`,
    text: entry.summary ?? summarizeUnknownValue(entry.value),
  };
}

function adaptStandaloneOpenAiEntry(
  entry: ParsedSyncedJsonlEntry<OpenAiCodexJsonlEvent>,
): BrowserHistoryStandaloneEntry {
  return {
    kind: 'standalone',
    key: `standalone:${entry.lineNumber}`,
    lineNumber: entry.lineNumber,
    raw: entry.raw,
    rawType: entry.type,
    timestamp: entry.value.type === 'session' ? entry.value.timestamp : undefined,
    display: formatOpenAiDisplay(entry),
    rawValue: entry.value,
  };
}

function adaptStandaloneClaudeEntry(
  entry: ParsedSyncedJsonlEntry<ClaudeCodeJsonlEvent>,
): BrowserHistoryStandaloneEntry {
  return {
    kind: 'standalone',
    key: `standalone:${entry.lineNumber}`,
    lineNumber: entry.lineNumber,
    raw: entry.raw,
    rawType: entry.type,
    display: formatClaudeDisplay(entry),
    rawValue: entry.value,
  };
}

function adaptStandaloneGenericEntry(entry: ParsedSyncedJsonlEntry<JsonRecord>): BrowserHistoryStandaloneEntry {
  return {
    kind: 'standalone',
    key: `standalone:${entry.lineNumber}`,
    lineNumber: entry.lineNumber,
    raw: entry.raw,
    rawType: entry.type,
    timestamp: typeof entry.value.timestamp === 'string' ? entry.value.timestamp : undefined,
    display: formatGenericDisplay(entry),
    rawValue: entry.value,
  };
}

function adaptOpenAiNode(node: ParsedSyncedJsonlTreeNode<OpenAiCodexJsonlEvent>): BrowserHistoryNode {
  const entry = {
    lineNumber: node.lineNumber,
    raw: node.raw,
    type: node.type,
    label: node.label,
    summary: node.summary,
    value: node.value,
  } satisfies ParsedSyncedJsonlEntry<OpenAiCodexJsonlEvent>;
  return {
    kind: 'node',
    key: node.id,
    id: node.id,
    parentId: node.parentId,
    relation: node.relation,
    lineNumber: node.lineNumber,
    raw: node.raw,
    rawType: node.type,
    timestamp: node.timestamp,
    resolvedLabel: node.resolvedLabel,
    display: formatOpenAiDisplay(entry),
    rawValue: node.value,
    children: node.children.map(adaptOpenAiNode),
  };
}

function adaptClaudeNode(node: ParsedSyncedJsonlTreeNode<ClaudeCodeJsonlEvent>): BrowserHistoryNode {
  const entry = {
    lineNumber: node.lineNumber,
    raw: node.raw,
    type: node.type,
    label: node.label,
    summary: node.summary,
    value: node.value,
  } satisfies ParsedSyncedJsonlEntry<ClaudeCodeJsonlEvent>;
  return {
    kind: 'node',
    key: node.id,
    id: node.id,
    parentId: node.parentId,
    relation: node.relation,
    lineNumber: node.lineNumber,
    raw: node.raw,
    rawType: node.type,
    timestamp: node.timestamp,
    resolvedLabel: node.resolvedLabel,
    display: formatClaudeDisplay(entry),
    rawValue: node.value,
    children: node.children.map(adaptClaudeNode),
  };
}

function adaptGenericNode(node: ParsedSyncedJsonlTreeNode<JsonRecord>): BrowserHistoryNode {
  const entry = {
    lineNumber: node.lineNumber,
    raw: node.raw,
    type: node.type,
    label: node.label,
    summary: node.summary,
    value: node.value,
  } satisfies ParsedSyncedJsonlEntry<JsonRecord>;
  return {
    kind: 'node',
    key: node.id,
    id: node.id,
    parentId: node.parentId,
    relation: node.relation,
    lineNumber: node.lineNumber,
    raw: node.raw,
    rawType: node.type,
    timestamp: node.timestamp,
    resolvedLabel: node.resolvedLabel,
    display: formatGenericDisplay(entry),
    rawValue: node.value,
    children: node.children.map(adaptGenericNode),
  };
}

function compareNodeOrder(left: BrowserHistoryNode, right: BrowserHistoryNode): number {
  return compareByTimestampThenLine(
    { timestamp: left.timestamp, lineNumber: left.lineNumber },
    { timestamp: right.timestamp, lineNumber: right.lineNumber },
  );
}

function findNewestLeafId(roots: BrowserHistoryNode[]): string | null {
  let newestLeaf: BrowserHistoryNode | null = null;
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.children.length === 0 && (!newestLeaf || compareNodeOrder(current, newestLeaf) > 0)) {
      newestLeaf = current;
    }
    stack.push(...current.children);
  }
  return newestLeaf?.id ?? null;
}

function buildNodeMap(roots: BrowserHistoryNode[]): Map<string, BrowserHistoryNode> {
  const byId = new Map<string, BrowserHistoryNode>();
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    byId.set(current.id, current);
    stack.push(...current.children);
  }
  return byId;
}

export function toBrowserHistoryModel(parsed: ParsedSyncedJsonl): BrowserHistoryModel {
  if (parsed.kind === 'openai-codex') {
    const roots = parsed.tree.roots.map(adaptOpenAiNode);
    const standaloneEntries = parsed.tree.standaloneEntries.map(adaptStandaloneOpenAiEntry);
    const currentLeafId = findNewestLeafId(roots);
    return {
      kind: parsed.kind,
      label: parsed.label,
      roots,
      standaloneEntries,
      currentLeafId,
      defaultSelectedKey: currentLeafId ?? standaloneEntries[0]?.key ?? roots[0]?.key ?? null,
    };
  }

  if (parsed.kind === 'claude-code') {
    const roots = parsed.tree.roots.map(adaptClaudeNode);
    const standaloneEntries = parsed.tree.standaloneEntries.map(adaptStandaloneClaudeEntry);
    const currentLeafId = findNewestLeafId(roots);
    return {
      kind: parsed.kind,
      label: parsed.label,
      roots,
      standaloneEntries,
      currentLeafId,
      defaultSelectedKey: currentLeafId ?? standaloneEntries[0]?.key ?? roots[0]?.key ?? null,
    };
  }

  const roots = parsed.tree.roots.map(adaptGenericNode);
  const standaloneEntries = parsed.tree.standaloneEntries.map(adaptStandaloneGenericEntry);
  const currentLeafId = findNewestLeafId(roots);
  return {
    kind: parsed.kind,
    label: parsed.label,
    roots,
    standaloneEntries,
    currentLeafId,
    defaultSelectedKey: currentLeafId ?? standaloneEntries[0]?.key ?? roots[0]?.key ?? null,
  };
}

export function buildBrowserHistoryEntryIndex(model: BrowserHistoryModel): Map<string, BrowserHistorySelectableEntry> {
  const entries = new Map<string, BrowserHistorySelectableEntry>();
  for (const entry of model.standaloneEntries) {
    entries.set(entry.key, entry);
  }
  const stack = [...model.roots];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    entries.set(current.key, current);
    stack.push(...current.children);
  }
  return entries;
}

function buildActivePathIds(roots: BrowserHistoryNode[], currentLeafId: string | null): Set<string> {
  const activePathIds = new Set<string>();
  if (!currentLeafId) return activePathIds;

  const nodeMap = buildNodeMap(roots);
  let currentId: string | null = currentLeafId;
  while (currentId) {
    activePathIds.add(currentId);
    const current = nodeMap.get(currentId);
    if (!current) break;
    currentId = current.parentId;
  }
  return activePathIds;
}

export function flattenBrowserHistoryTree(
  roots: BrowserHistoryNode[],
  currentLeafId: string | null,
  foldedNodeIds?: ReadonlySet<string>,
): BrowserHistoryFlatNode[] {
  if (roots.length === 0) return [];

  const result: BrowserHistoryFlatNode[] = [];
  const activePathIds = buildActivePathIds(roots, currentLeafId);
  const containsActive = new Map<BrowserHistoryNode, boolean>();
  const allNodes: BrowserHistoryNode[] = [];
  const preOrderStack = [...roots];
  while (preOrderStack.length > 0) {
    const node = preOrderStack.pop();
    if (!node) continue;
    allNodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child) preOrderStack.push(child);
    }
  }

  for (let index = allNodes.length - 1; index >= 0; index -= 1) {
    const node = allNodes[index];
    if (!node) continue;
    let hasActive = activePathIds.has(node.id);
    for (const child of node.children) {
      if (containsActive.get(child)) {
        hasActive = true;
        break;
      }
    }
    containsActive.set(node, hasActive);
  }

  const multipleRoots = roots.length > 1;
  const orderedRoots = [...roots].sort(
    (left, right) => Number(containsActive.get(right)) - Number(containsActive.get(left)),
  );
  const stack: Array<[BrowserHistoryNode, number, boolean, boolean, boolean, BrowserHistoryFlatGutter[], boolean]> = [];
  for (let index = orderedRoots.length - 1; index >= 0; index -= 1) {
    const root = orderedRoots[index];
    if (!root) continue;
    stack.push([
      root,
      multipleRoots ? 1 : 0,
      multipleRoots,
      multipleRoots,
      index === orderedRoots.length - 1,
      [],
      multipleRoots,
    ]);
  }

  while (stack.length > 0) {
    const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;
    const isFoldable = node.children.length > 0;
    const isFolded = isFoldable && Boolean(foldedNodeIds?.has(node.id));
    result.push({
      node,
      indent,
      showConnector,
      isLast,
      gutters,
      isVirtualRootChild,
      multipleRoots,
      isOnActivePath: activePathIds.has(node.id),
      isFoldable,
      isFolded,
    });
    if (isFolded) continue;

    const orderedChildren = [...node.children].sort(
      (left, right) => Number(containsActive.get(right)) - Number(containsActive.get(left)),
    );
    const multipleChildren = orderedChildren.length > 1;
    let childIndent = indent;
    if (multipleChildren) childIndent = indent + 1;
    else if (justBranched && indent > 0) childIndent = indent + 1;

    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed ? [...gutters, { position: connectorPosition, show: !isLast }] : gutters;

    for (let index = orderedChildren.length - 1; index >= 0; index -= 1) {
      const child = orderedChildren[index];
      if (!child) continue;
      stack.push([
        child,
        childIndent,
        multipleChildren,
        multipleChildren,
        index === orderedChildren.length - 1,
        childGutters,
        false,
      ]);
    }
  }

  return result;
}

export function buildBrowserHistoryPrefix(flatNode: BrowserHistoryFlatNode): string {
  const displayIndent = flatNode.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;
  const connector = flatNode.showConnector && !flatNode.isVirtualRootChild ? (flatNode.isLast ? '└' : '├') : '';
  const connectorPosition = connector ? displayIndent - 1 : -1;
  const totalChars = displayIndent * 3;
  const prefixChars: string[] = [];

  for (let index = 0; index < totalChars; index += 1) {
    const level = Math.floor(index / 3);
    const positionInLevel = index % 3;
    const gutter = flatNode.gutters.find((entry) => entry.position === level);
    if (gutter) {
      prefixChars.push(positionInLevel === 0 ? (gutter.show ? '│' : ' ') : ' ');
      continue;
    }
    if (connector && level === connectorPosition) {
      if (positionInLevel === 0) prefixChars.push(connector);
      else if (positionInLevel === 1) prefixChars.push(flatNode.isFoldable ? (flatNode.isFolded ? '⊞' : '⊟') : '─');
      else prefixChars.push(' ');
      continue;
    }
    prefixChars.push(' ');
  }

  if (!connector && flatNode.isFoldable) return `${flatNode.isFolded ? '⊞' : '⊟'} `;
  return prefixChars.join('');
}
