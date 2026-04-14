import type { JsonRecord, ParsedSyncedJsonlEntry, ParsedSyncedJsonlTree, ParsedSyncedJsonlTreeNode } from './types.ts';

export interface TreeLink {
  id: string;
  parentId: string | null;
  timestamp?: string;
}

interface TimestampedLine {
  timestamp?: string;
  lineNumber: number;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

export function readOptionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function readNumber(record: JsonRecord, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readOptionalNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(record: JsonRecord, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

export function readOptionalBoolean(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function readNullableString(record: JsonRecord, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

export function readStringArray(record: JsonRecord, key: string): string[] | null {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return null;
  return [...value];
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function summarizeText(text: string | null | undefined, maxLength = 120): string | undefined {
  if (typeof text !== 'string') return undefined;
  const collapsed = collapseWhitespace(text);
  if (!collapsed) return undefined;
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 3)}...` : collapsed;
}

export function summarizeUnknownValue(value: unknown, maxLength = 120): string | undefined {
  if (typeof value === 'string') return summarizeText(value, maxLength);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const summary = summarizeUnknownValue(entry, maxLength);
      if (summary) return summary;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const key of ['text', 'summary', 'content', 'name', 'message'] as const) {
      const summary = summarizeUnknownValue(value[key], maxLength);
      if (summary) return summary;
    }
  }
  return undefined;
}

export function compareByTimestampThenLine(left: TimestampedLine, right: TimestampedLine): number {
  const leftTimestamp = left.timestamp ? Date.parse(left.timestamp) : Number.NaN;
  const rightTimestamp = right.timestamp ? Date.parse(right.timestamp) : Number.NaN;
  const leftHasTimestamp = Number.isFinite(leftTimestamp);
  const rightHasTimestamp = Number.isFinite(rightTimestamp);
  if (leftHasTimestamp && rightHasTimestamp && leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
  if (leftHasTimestamp !== rightHasTimestamp) return leftHasTimestamp ? -1 : 1;
  return left.lineNumber - right.lineNumber;
}

export function buildParsedTree<TValue extends object>(
  entries: ParsedSyncedJsonlEntry<TValue>[],
  getLink: (entry: ParsedSyncedJsonlEntry<TValue>) => TreeLink | null,
  resolvedLabels?: Map<string, string>,
): ParsedSyncedJsonlTree<TValue> {
  const standaloneEntries: ParsedSyncedJsonlEntry<TValue>[] = [];
  const nodesById = new Map<string, ParsedSyncedJsonlTreeNode<TValue>>();
  const orderedNodes: ParsedSyncedJsonlTreeNode<TValue>[] = [];

  for (const entry of entries) {
    const link = getLink(entry);
    if (link == null) {
      standaloneEntries.push(entry);
      continue;
    }

    const resolvedLabel = resolvedLabels?.get(link.id);
    const node: ParsedSyncedJsonlTreeNode<TValue> = {
      id: link.id,
      parentId: link.parentId,
      lineNumber: entry.lineNumber,
      raw: entry.raw,
      type: entry.type,
      label: entry.label,
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(link.timestamp ? { timestamp: link.timestamp } : {}),
      ...(resolvedLabel ? { resolvedLabel } : {}),
      relation: 'child',
      value: entry.value,
      children: [],
    };
    nodesById.set(node.id, node);
    orderedNodes.push(node);
  }

  const roots: ParsedSyncedJsonlTreeNode<TValue>[] = [];
  for (const node of orderedNodes) {
    if (node.parentId == null || node.parentId === node.id) {
      node.relation = 'root';
      roots.push(node);
      continue;
    }

    const parent = nodesById.get(node.parentId);
    if (!parent) {
      node.relation = 'orphan';
      roots.push(node);
      continue;
    }

    parent.children.push(node);
  }

  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    current.children.sort(compareByTimestampThenLine);
    stack.push(...current.children);
  }
  roots.sort(compareByTimestampThenLine);

  return {
    roots,
    standaloneEntries,
  };
}
