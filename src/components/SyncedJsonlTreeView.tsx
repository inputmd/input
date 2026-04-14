import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  type BrowserHistoryNode,
  type BrowserHistorySelectableEntry,
  buildBrowserHistoryEntryIndex,
  buildBrowserHistoryPrefix,
  flattenBrowserHistoryTree,
  toBrowserHistoryModel,
} from '../synced_jsonl/browser_tree.ts';
import type { ParsedSyncedJsonl } from '../synced_jsonl.ts';

interface SyncedJsonlTreeViewProps {
  parsed: ParsedSyncedJsonl;
}

interface JsonTreeNodeProps {
  label: string;
  value: unknown;
  path: string;
  depth: number;
  expandedState: Record<string, boolean>;
  onToggle: (path: string, defaultExpanded: boolean) => void;
}

interface HistoryRowProps {
  entry: BrowserHistorySelectableEntry;
  prefix?: string;
  isSelected: boolean;
  isOnActivePath: boolean;
  onSelect: () => void;
  onToggleFold?: () => void;
}

interface InspectorProps {
  entry: BrowserHistorySelectableEntry;
  expandedState: Record<string, boolean>;
  onToggleJsonNode: (path: string, defaultExpanded: boolean) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExpandableValue(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || isRecord(value);
}

function formatScalarValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

function formatContainerSummary(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  return `{${Object.keys(value).length}}`;
}

function formatNodeType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function formatScalarPreview(value: unknown): string {
  if (typeof value !== 'string') return formatScalarValue(value);
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  if (!collapsed) return '""';
  return collapsed.length > 72 ? `${collapsed.slice(0, 69)}...` : collapsed;
}

function childEntriesForValue(
  value: Record<string, unknown> | unknown[],
): Array<{ label: string; value: unknown; path: string }> {
  if (Array.isArray(value)) {
    return value.map((entry, index) => ({
      label: `[${index}]`,
      value: entry,
      path: `[${index}]`,
    }));
  }
  return Object.entries(value).map(([key, entryValue]) => ({
    label: key,
    value: entryValue,
    path: key,
  }));
}

function JsonTreeNode({ label, value, path, depth, expandedState, onToggle }: JsonTreeNodeProps) {
  const expandable = isExpandableValue(value);
  const defaultExpanded = depth <= 1;
  const expanded = expandable ? (expandedState[path] ?? defaultExpanded) : false;

  if (!expandable) {
    const isMultilineString = typeof value === 'string' && value.includes('\n');
    return (
      <div class="terminal-persistence-dialog__json-node terminal-persistence-dialog__json-node--scalar">
        <div class="terminal-persistence-dialog__json-node-header terminal-persistence-dialog__json-node-header--static">
          <span class="terminal-persistence-dialog__json-node-key">{label}</span>
          <span class="terminal-persistence-dialog__json-node-type">{formatNodeType(value)}</span>
          {!isMultilineString ? (
            <span class="terminal-persistence-dialog__json-node-summary">{formatScalarPreview(value)}</span>
          ) : null}
        </div>
        <div
          class={`terminal-persistence-dialog__json-node-value${typeof value === 'string' ? ' terminal-persistence-dialog__json-node-value--string' : ''}`}
        >
          {typeof value === 'string' ? <pre>{value}</pre> : <code>{formatScalarValue(value)}</code>}
        </div>
      </div>
    );
  }

  const children = childEntriesForValue(value);
  return (
    <div class="terminal-persistence-dialog__json-node terminal-persistence-dialog__json-node--container">
      <button
        type="button"
        class="terminal-persistence-dialog__json-node-header terminal-persistence-dialog__json-node-header--button"
        aria-expanded={expanded}
        onClick={() => onToggle(path, defaultExpanded)}
      >
        <span class={`terminal-persistence-dialog__json-node-caret${expanded ? ' is-open' : ''}`} aria-hidden="true">
          <ChevronRight size={13} />
        </span>
        <span class="terminal-persistence-dialog__json-node-key">{label}</span>
        <span class="terminal-persistence-dialog__json-node-type">{formatNodeType(value)}</span>
        <span class="terminal-persistence-dialog__json-node-summary">{formatContainerSummary(value)}</span>
      </button>
      {expanded ? (
        <div class="terminal-persistence-dialog__json-node-children">
          {children.map((child) => (
            <JsonTreeNode
              key={`${path}.${child.path}`}
              label={child.label}
              value={child.value}
              path={`${path}.${child.path}`}
              depth={depth + 1}
              expandedState={expandedState}
              onToggle={onToggle}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function compactTimestamp(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function HistoryRow({ entry, prefix, isSelected, isOnActivePath, onSelect, onToggleFold }: HistoryRowProps) {
  const timestamp = compactTimestamp(entry.timestamp);
  return (
    <div
      class={`terminal-persistence-dialog__history-row${isSelected ? ' is-selected' : ''}${isOnActivePath ? ' is-in-path' : ''}`}
    >
      {prefix ? (
        onToggleFold ? (
          <button
            type="button"
            class="terminal-persistence-dialog__history-prefix terminal-persistence-dialog__history-prefix--button"
            aria-label="Toggle branch"
            onClick={onToggleFold}
          >
            {prefix}
          </button>
        ) : (
          <span class="terminal-persistence-dialog__history-prefix">{prefix}</span>
        )
      ) : null}
      <button type="button" class="terminal-persistence-dialog__history-row-main" onClick={onSelect}>
        <span class="terminal-persistence-dialog__history-marker" aria-hidden="true">
          {isOnActivePath ? '•' : ''}
        </span>
        {entry.resolvedLabel ? (
          <span class="terminal-persistence-dialog__history-label">[{entry.resolvedLabel}]</span>
        ) : null}
        <span class={`terminal-persistence-dialog__history-lead is-${entry.display.tone}`}>{entry.display.lead}</span>
        {entry.display.text ? (
          <span class="terminal-persistence-dialog__history-text">{entry.display.text}</span>
        ) : null}
        <span class="terminal-persistence-dialog__history-line">L{entry.lineNumber}</span>
        {timestamp ? <span class="terminal-persistence-dialog__history-time">{timestamp}</span> : null}
      </button>
    </div>
  );
}

function buildInspectorMeta(entry: BrowserHistorySelectableEntry): string[] {
  const chips = [`line ${entry.lineNumber}`];
  if (entry.kind === 'standalone') {
    chips.push('standalone');
  } else {
    chips.push(`id ${entry.id}`);
    chips.push(entry.parentId ? `parent ${entry.parentId}` : 'root');
    if (entry.relation === 'orphan') chips.push('orphan');
  }
  if (entry.resolvedLabel) chips.push(`label ${entry.resolvedLabel}`);
  const timestamp = compactTimestamp(entry.timestamp);
  if (timestamp) chips.push(timestamp);
  chips.push(entry.rawType);
  return chips;
}

function Inspector({ entry, expandedState, onToggleJsonNode }: InspectorProps) {
  const chips = buildInspectorMeta(entry);
  return (
    <section class="terminal-persistence-dialog__jsonl-detail">
      <div class="terminal-persistence-dialog__jsonl-section-title">
        Selected event
        <span>{entry.key}</span>
      </div>
      <div class="terminal-persistence-dialog__jsonl-detail-summary">
        {entry.resolvedLabel ? (
          <span class="terminal-persistence-dialog__history-label">[{entry.resolvedLabel}]</span>
        ) : null}
        <span class={`terminal-persistence-dialog__history-lead is-${entry.display.tone}`}>{entry.display.lead}</span>
        {entry.display.text ? (
          <span class="terminal-persistence-dialog__history-text">{entry.display.text}</span>
        ) : null}
      </div>
      <div class="terminal-persistence-dialog__jsonl-entry-meta">
        {chips.map((chip) => (
          <span key={chip} class="terminal-persistence-dialog__jsonl-chip">
            {chip}
          </span>
        ))}
      </div>
      <JsonTreeNode
        label={entry.rawType}
        value={entry.rawValue}
        path={`selected:${entry.key}`}
        depth={0}
        expandedState={expandedState}
        onToggle={onToggleJsonNode}
      />
      <details class="terminal-persistence-dialog__jsonl-raw">
        <summary>Raw line</summary>
        <pre>{entry.raw}</pre>
      </details>
    </section>
  );
}

function treeSectionTitle(parsed: ParsedSyncedJsonl): string {
  if (parsed.kind === 'generic') return 'Records';
  return 'Event tree';
}

function standaloneSectionTitle(parsed: ParsedSyncedJsonl): string {
  if (parsed.kind === 'openai-codex') return 'Session metadata';
  return 'Standalone events';
}

function countTreeNodes(roots: BrowserHistoryNode[]): number {
  let count = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    count += 1;
    stack.push(...current.children);
  }
  return count;
}

function isDescendantOf(
  nodeId: string,
  ancestorId: string,
  entriesByKey: Map<string, BrowserHistorySelectableEntry>,
): boolean {
  let currentId: string | null = nodeId;
  while (currentId) {
    if (currentId === ancestorId) return true;
    const current = entriesByKey.get(currentId);
    if (!current || current.kind !== 'node') return false;
    currentId = current.parentId;
  }
  return false;
}

export function SyncedJsonlTreeView({ parsed }: SyncedJsonlTreeViewProps) {
  const model = useMemo(() => toBrowserHistoryModel(parsed), [parsed]);
  const entriesByKey = useMemo(() => buildBrowserHistoryEntryIndex(model), [model]);
  const [selectedKey, setSelectedKey] = useState<string | null>(model.defaultSelectedKey);
  const [foldedNodes, setFoldedNodes] = useState<Record<string, true>>({});
  const [expandedState, setExpandedState] = useState<Record<string, boolean>>({});
  const foldedNodeIds = useMemo(() => new Set(Object.keys(foldedNodes)), [foldedNodes]);
  const flatNodes = useMemo(
    () => flattenBrowserHistoryTree(model.roots, model.currentLeafId, foldedNodeIds),
    [foldedNodeIds, model.currentLeafId, model.roots],
  );
  const selectedEntry = selectedKey ? (entriesByKey.get(selectedKey) ?? null) : null;
  const totalTreeNodes = useMemo(() => countTreeNodes(model.roots), [model.roots]);

  useEffect(() => {
    setSelectedKey(model.defaultSelectedKey);
    setFoldedNodes({});
    setExpandedState({});
  }, [model]);

  const toggleJsonNode = (path: string, defaultExpanded: boolean) => {
    setExpandedState((current) => ({
      ...current,
      [path]: !(current[path] ?? defaultExpanded),
    }));
  };

  return (
    <div class="terminal-persistence-dialog__jsonl-tree">
      <div class="terminal-persistence-dialog__jsonl-meta">
        <span>{parsed.label}</span>
        <span>{parsed.entries.length} lines</span>
        <span>{totalTreeNodes} tree rows</span>
        <span>{flatNodes.length} visible</span>
        {parsed.skippedLineCount > 0 ? <span>skipped {parsed.skippedLineCount}</span> : null}
      </div>

      {flatNodes.length > 0 ? (
        <section class="terminal-persistence-dialog__jsonl-section">
          <div class="terminal-persistence-dialog__jsonl-section-title">
            {treeSectionTitle(parsed)}
            <span>
              {flatNodes.length}/{totalTreeNodes}
            </span>
          </div>
          <div class="terminal-persistence-dialog__history-list">
            {flatNodes.map((flatNode) => (
              <HistoryRow
                key={flatNode.node.id}
                entry={flatNode.node}
                prefix={buildBrowserHistoryPrefix(flatNode)}
                isSelected={selectedKey === flatNode.node.key}
                isOnActivePath={flatNode.isOnActivePath}
                onSelect={() => setSelectedKey(flatNode.node.key)}
                onToggleFold={
                  flatNode.isFoldable
                    ? () => {
                        const nextIsFolded = !foldedNodes[flatNode.node.id];
                        if (
                          nextIsFolded &&
                          selectedKey &&
                          isDescendantOf(selectedKey, flatNode.node.id, entriesByKey)
                        ) {
                          setSelectedKey(flatNode.node.key);
                        }
                        setFoldedNodes((current) => {
                          if (current[flatNode.node.id]) {
                            const next = { ...current };
                            delete next[flatNode.node.id];
                            return next;
                          }
                          return { ...current, [flatNode.node.id]: true };
                        });
                      }
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      ) : null}

      {model.standaloneEntries.length > 0 ? (
        <section class="terminal-persistence-dialog__jsonl-section">
          <div class="terminal-persistence-dialog__jsonl-section-title">
            {standaloneSectionTitle(parsed)}
            <span>{model.standaloneEntries.length}</span>
          </div>
          <div class="terminal-persistence-dialog__history-list">
            {model.standaloneEntries.map((entry) => (
              <HistoryRow
                key={entry.key}
                entry={entry}
                isSelected={selectedKey === entry.key}
                isOnActivePath={false}
                onSelect={() => setSelectedKey(entry.key)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {selectedEntry ? (
        <Inspector entry={selectedEntry} expandedState={expandedState} onToggleJsonNode={toggleJsonNode} />
      ) : (
        <div class="terminal-persistence-dialog__empty">No event selected</div>
      )}
    </div>
  );
}
