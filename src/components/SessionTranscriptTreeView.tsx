import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { blurOnClose } from '../dom_utils';
import { parseMarkdownToHtml } from '../markdown';
import { copyTextToClipboard } from '../util';
import { TextCodeView } from './TextCodeView';

export type SessionTranscriptFilterMode = 'default' | 'full' | 'minimal';

export interface SessionTranscriptParseError {
  lineNumber: number;
  message: string;
}

export interface SessionTranscriptTreeRow {
  id: string;
  text: string;
  label?: string;
  indentColumns: number;
  isCurrentLeaf: boolean;
  isSelected: boolean;
  isFolded: boolean;
  isFoldable: boolean;
  isSynthetic?: boolean;
  role: string | null;
}

interface SessionTranscriptTreeViewProps {
  agentName: string;
  content: string;
  continueAction?: {
    credentialAvailable: boolean | null;
    onContinue?: () => void;
  };
  fileName: string;
  isValid: boolean;
  invalidMessage: string;
  parseErrors: SessionTranscriptParseError[];
  defaultLeafId: string | null;
  sessionIdentity: string;
  buildRows: (options: {
    currentLeafId: string | null;
    selectedEntryId: string | null;
    filterMode: SessionTranscriptFilterMode;
    foldedIds: ReadonlySet<string>;
  }) => SessionTranscriptTreeRow[];
  onBack?: () => void;
}

const FILTER_MODES: Array<{ mode: SessionTranscriptFilterMode; label: string }> = [
  { mode: 'default', label: 'Default' },
  { mode: 'minimal', label: 'Tools' },
  { mode: 'full', label: 'All' },
];

function getFixedToolbarHeight(): number {
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue('--toolbar-height').trim();
  const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(raw);
  if (match) return Number.parseFloat(match[1] ?? '0');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roleClass(role: string | null): string {
  switch (role) {
    case 'user':
      return 'pi-session-tree-row--user';
    case 'assistant':
      return 'pi-session-tree-row--assistant';
    case 'toolUse':
    case 'toolResult':
      return 'pi-session-tree-row--tool';
    case 'bashExecution':
      return 'pi-session-tree-row--bash';
    case 'elision':
      return 'pi-session-tree-row--elision';
    default:
      return '';
  }
}

function renderRowText(role: string | null, text: string) {
  if (role === 'user' && text.startsWith('user: ')) {
    return (
      <>
        <span class="pi-session-tree-role-label pi-session-tree-role-label--user">user: </span>
        {text.slice('user: '.length)}
      </>
    );
  }
  if (role === 'assistant' && text.startsWith('assistant: ')) {
    const markdown = text.slice('assistant: '.length);
    return (
      <>
        <span class="pi-session-tree-role-label pi-session-tree-role-label--assistant">assistant: </span>
        <div
          class="pi-session-tree-markdown"
          dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(markdown, { smartQuotes: true }) }}
        />
      </>
    );
  }
  return text;
}

function markdownToRenderedText(markdown: string): string {
  const template = document.createElement('template');
  template.innerHTML = parseMarkdownToHtml(markdown, { smartQuotes: true });
  return (template.content.textContent ?? '').replace(/[ \t]+/g, ' ').trim();
}

function renderedRowText(row: SessionTranscriptTreeRow): string {
  const assistantPrefix = 'assistant: ';
  if (row.role === 'assistant' && row.text.startsWith(assistantPrefix)) {
    return `${assistantPrefix}${markdownToRenderedText(row.text.slice(assistantPrefix.length))}`;
  }
  return row.text;
}

function buildRenderedTreeText(rows: SessionTranscriptTreeRow[]): string {
  return rows
    .map((row) => {
      const indent = ' '.repeat(Math.max(0, row.indentColumns));
      const foldMarker = row.isFoldable ? `${row.isFolded ? '>' : 'v'} ` : '  ';
      const label = row.label ? `${row.label} ` : '';
      return `${indent}${foldMarker}${label}${renderedRowText(row)}`.trimEnd();
    })
    .join('\n');
}

export function SessionTranscriptTreeView({
  agentName,
  content,
  continueAction,
  fileName,
  isValid,
  invalidMessage,
  parseErrors,
  defaultLeafId,
  sessionIdentity,
  buildRows,
  onBack,
}: SessionTranscriptTreeViewProps) {
  const [currentLeafId, setCurrentLeafId] = useState<string | null>(defaultLeafId);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(defaultLeafId);
  const [filterMode, setFilterMode] = useState<SessionTranscriptFilterMode>('default');
  const [foldedIds, setFoldedIds] = useState<Set<string>>(() => new Set());
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const keyboardNavigationRef = useRef(false);

  useEffect(() => {
    void sessionIdentity;
    setCurrentLeafId(defaultLeafId);
    setSelectedEntryId(defaultLeafId);
    setFoldedIds(new Set());
  }, [defaultLeafId, sessionIdentity]);

  const rows = useMemo(
    () =>
      buildRows({
        currentLeafId,
        selectedEntryId,
        filterMode,
        foldedIds,
      }),
    [buildRows, currentLeafId, filterMode, foldedIds, selectedEntryId],
  );

  useEffect(() => {
    if (rows.length === 0) {
      if (selectedEntryId !== null) setSelectedEntryId(null);
      return;
    }
    if (!selectedEntryId || !rows.some((row) => row.id === selectedEntryId)) {
      setSelectedEntryId(rows[0].id);
    }
  }, [rows, selectedEntryId]);

  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.id === selectedEntryId),
  );
  const selectedRow = rows[selectedIndex] ?? null;
  const showContinueButton = Boolean(continueAction && continueAction.credentialAvailable !== false);
  const continueButtonLabel = continueAction?.credentialAvailable === null ? 'Checking login...' : 'Load Session';
  const continueButtonTitle =
    continueAction?.credentialAvailable === null
      ? `Checking ${agentName} login status.`
      : `Load this ${agentName} session in the terminal.`;
  const continueButtonDisabled =
    continueAction?.credentialAvailable === null ||
    (continueAction?.credentialAvailable === true && !continueAction.onContinue);
  const onContinueButtonClick = () => {
    if (continueAction?.credentialAvailable !== true) return;
    continueAction.onContinue?.();
  };

  const onCopyFormattedTranscript = useCallback(async () => {
    try {
      await copyTextToClipboard(buildRenderedTreeText(rows));
    } catch (err) {
      console.error('[session] failed to copy formatted transcript', err);
    }
  }, [rows]);

  const onCopyJsonTranscript = useCallback(async () => {
    try {
      await copyTextToClipboard(content);
    } catch (err) {
      console.error('[session] failed to copy transcript JSON', err);
    }
  }, [content]);

  const scrollSelectedRowIntoView = useCallback((entryId: string) => {
    window.requestAnimationFrame(() => {
      const row = rowRefs.current.get(entryId);
      if (!row) return;

      const rowRect = row.getBoundingClientRect();
      const toolbarRect = toolbarRef.current?.getBoundingClientRect();
      const topPadding = Math.max(getFixedToolbarHeight(), toolbarRect?.bottom ?? 0) + 8;
      const bottomPadding = 12;

      if (rowRect.top < topPadding) {
        window.scrollTo({ top: Math.max(0, window.scrollY + rowRect.top - topPadding) });
      } else if (rowRect.bottom > window.innerHeight - bottomPadding) {
        window.scrollTo({ top: Math.max(0, window.scrollY + rowRect.bottom - window.innerHeight + bottomPadding) });
      }
    });
  }, []);

  useEffect(() => {
    if (!selectedEntryId || !keyboardNavigationRef.current) return;
    keyboardNavigationRef.current = false;
    scrollSelectedRowIntoView(selectedEntryId);
  }, [scrollSelectedRowIntoView, selectedEntryId]);

  const selectByIndex = (index: number) => {
    const row = rows[index];
    if (!row) return;
    keyboardNavigationRef.current = true;
    setSelectedEntryId(row.id);
  };

  const toggleFold = (entryId: string) => {
    setFoldedIds((previous) => {
      const next = new Set(previous);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  };

  const onTreeKeyDown = (event: KeyboardEvent) => {
    if (rows.length === 0) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select')) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        selectByIndex(Math.min(rows.length - 1, selectedIndex + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        selectByIndex(Math.max(0, selectedIndex - 1));
        break;
      case 'Home':
        event.preventDefault();
        selectByIndex(0);
        break;
      case 'End':
        event.preventDefault();
        selectByIndex(rows.length - 1);
        break;
      case 'Enter':
        if (!selectedRow) return;
        if (selectedRow.isSynthetic) return;
        event.preventDefault();
        setCurrentLeafId(selectedRow.id);
        break;
      case ' ':
        if (!selectedRow?.isFoldable) return;
        event.preventDefault();
        toggleFold(selectedRow.id);
        break;
      case 'ArrowLeft':
        if (!selectedRow?.isFoldable || selectedRow.isFolded) return;
        event.preventDefault();
        toggleFold(selectedRow.id);
        break;
      case 'ArrowRight':
        if (!selectedRow) return;
        if (selectedRow.isFoldable && selectedRow.isFolded) {
          event.preventDefault();
          toggleFold(selectedRow.id);
        } else if (selectedRow.isFoldable) {
          event.preventDefault();
          selectByIndex(Math.min(rows.length - 1, selectedIndex + 1));
        }
        break;
      default:
        break;
    }
  };

  if (!isValid) {
    return (
      <div class="pi-session">
        <div class="pi-session-alert">{invalidMessage}</div>
        <TextCodeView content={content} fileName={fileName} scrollStorageKey={`session:${fileName}:raw`} />
      </div>
    );
  }

  return (
    <div class="pi-session">
      <div class="pi-session-toolbar" ref={toolbarRef}>
        {onBack ? (
          <div class="pi-session-mode-tabs">
            <button type="button" class="pi-session-mode-tab" onClick={onBack}>
              <ArrowLeft size={14} aria-hidden="true" />
              Back
            </button>
          </div>
        ) : null}
        <div class="pi-session-filter-tabs" role="tablist" aria-label={`${agentName} session filters`}>
          {FILTER_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              class={`pi-session-filter-tab${filterMode === mode ? ' is-active' : ''}`}
              onClick={() => {
                setFilterMode(mode);
                setFoldedIds(new Set());
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {continueAction ? (
          <>
            <DropdownMenu.Root onOpenChange={blurOnClose}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  class="pi-session-copy-button"
                  disabled={rows.length === 0 && content.length === 0}
                  title={`Copy this ${agentName} session`}
                  aria-label={`Copy this ${agentName} session`}
                >
                  Copy
                  <ChevronDown size={13} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="pi-session-copy-menu" sideOffset={6} align="end">
                  <DropdownMenu.Item
                    class="pi-session-copy-menu-item"
                    onSelect={() => void onCopyFormattedTranscript()}
                  >
                    Copy Formatted
                  </DropdownMenu.Item>
                  <DropdownMenu.Item class="pi-session-copy-menu-item" onSelect={() => void onCopyJsonTranscript()}>
                    Copy JSON
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            {showContinueButton ? (
              <button
                type="button"
                class="button-success-solid pi-session-continue-button"
                disabled={continueButtonDisabled}
                title={continueButtonTitle}
                onClick={onContinueButtonClick}
              >
                {continueButtonLabel}
              </button>
            ) : null}
          </>
        ) : null}
      </div>

      {parseErrors.length > 0 ? (
        <div class="pi-session-alert">{parseErrors.length} malformed JSONL line skipped.</div>
      ) : null}

      <div
        class="pi-session-tree"
        role="tree"
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        aria-label={`${agentName} session tree`}
      >
        {rows.length > 0 ? (
          rows.map((row) => (
            <div
              key={row.id}
              ref={(element) => {
                if (element) {
                  rowRefs.current.set(row.id, element);
                } else {
                  rowRefs.current.delete(row.id);
                }
              }}
              role="treeitem"
              class={`pi-session-tree-row ${roleClass(row.role)}${row.isSelected ? ' is-selected' : ''}${
                row.isCurrentLeaf ? ' is-current-leaf' : ''
              }`}
              aria-current={row.isCurrentLeaf ? 'true' : undefined}
              onClick={() => {
                setSelectedEntryId(row.id);
                if (!row.isSynthetic) setCurrentLeafId(row.id);
              }}
              onDblClick={() => {
                if (row.isFoldable) toggleFold(row.id);
              }}
              data-selected={row.isSelected ? 'true' : undefined}
            >
              {row.indentColumns > 0 || row.isFoldable ? (
                <span
                  class="pi-session-tree-prefix"
                  style={
                    row.isFoldable
                      ? { width: '1.25em', marginLeft: `${row.indentColumns}ch` }
                      : { width: `${row.indentColumns}ch` }
                  }
                  aria-hidden="true"
                >
                  {row.isFoldable ? (
                    <span
                      class="pi-session-tree-fold-target"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleFold(row.id);
                      }}
                      onDblClick={(event) => event.stopPropagation()}
                    >
                      {row.isFolded ? (
                        <ChevronRight size={13} aria-hidden="true" />
                      ) : (
                        <ChevronDown size={13} aria-hidden="true" />
                      )}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {row.label ? <span class="pi-session-tree-label">{row.label}</span> : null}
              <div class="pi-session-tree-text">{renderRowText(row.role, row.text)}</div>
            </div>
          ))
        ) : (
          <div class="pi-session-empty">No entries match this filter.</div>
        )}
      </div>
    </div>
  );
}
