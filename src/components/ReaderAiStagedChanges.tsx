import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ReaderAiStagedChange } from '../reader_ai';

const LONG_DIFF_LINE_CLIP_THRESHOLD = 220;
const LONG_DIFF_LINE_CONTEXT_CHARS = 48;

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string, prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function renderDiffContent(line: string, changedClass: string, pairLine?: string): ComponentChildren {
  if (!pairLine) return line;
  const content = line.slice(1);
  const pairContent = pairLine.slice(1);
  const prefix = commonPrefixLength(content, pairContent);
  const suffix = commonSuffixLength(content, pairContent, prefix);
  const changedEnd = content.length - suffix;
  const unchangedPrefix = content.slice(0, prefix);
  const changed = content.slice(prefix, changedEnd);
  const unchangedSuffix = content.slice(changedEnd);
  const shouldClip = content.length > LONG_DIFF_LINE_CLIP_THRESHOLD;
  const clippedPrefix =
    shouldClip && unchangedPrefix.length > LONG_DIFF_LINE_CONTEXT_CHARS
      ? unchangedPrefix.slice(-LONG_DIFF_LINE_CONTEXT_CHARS)
      : unchangedPrefix;
  const clippedSuffix =
    shouldClip && unchangedSuffix.length > LONG_DIFF_LINE_CONTEXT_CHARS
      ? unchangedSuffix.slice(0, LONG_DIFF_LINE_CONTEXT_CHARS)
      : unchangedSuffix;
  const hasLeadingClip = shouldClip && clippedPrefix !== unchangedPrefix;
  const hasTrailingClip = shouldClip && clippedSuffix !== unchangedSuffix;

  return (
    <>
      {line[0]}
      {hasLeadingClip ? <span class="reader-ai-diff-inline-ellipsis">…</span> : null}
      {clippedPrefix}
      {changed ? <span class={changedClass}>{changed}</span> : null}
      {clippedSuffix}
      {hasTrailingClip ? <span class="reader-ai-diff-inline-ellipsis">…</span> : null}
    </>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  const renderedLines: ComponentChildren[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const isPair = line.startsWith('-') && next?.startsWith('+') && !line.startsWith('---') && !next.startsWith('+++');
    if (isPair) {
      renderedLines.push(
        <div key={`${i}-del`} class="reader-ai-diff-line reader-ai-diff-line--del">
          {renderDiffContent(line, 'reader-ai-diff-inline-change--del', next)}
        </div>,
      );
      renderedLines.push(
        <div key={`${i + 1}-add`} class="reader-ai-diff-line reader-ai-diff-line--add">
          {renderDiffContent(next, 'reader-ai-diff-inline-change--add', line)}
        </div>,
      );
      i++;
      continue;
    }

    let cls = 'reader-ai-diff-line';
    if (line.startsWith('+++') || line.startsWith('---')) cls += ' reader-ai-diff-line--header';
    else if (line.startsWith('@@')) cls += ' reader-ai-diff-line--hunk';
    else if (line.startsWith('+')) cls += ' reader-ai-diff-line--add';
    else if (line.startsWith('-')) cls += ' reader-ai-diff-line--del';
    renderedLines.push(
      <div key={`${i}`} class={cls}>
        {line}
      </div>,
    );
  }

  return <pre class="reader-ai-diff">{renderedLines}</pre>;
}

export function StagedChangesSection({
  changes,
  defaultCommitMessage,
  applying,
  canApply,
  applyToEditor,
  onApply,
}: {
  changes: ReaderAiStagedChange[];
  defaultCommitMessage: string;
  applying: boolean;
  canApply: boolean;
  applyToEditor?: boolean;
  onApply: (commitMessage?: string) => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(changes.map((change) => change.path)));
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage);
  if (changes.length === 0) return null;

  useEffect(() => {
    setExpandedPaths(new Set(changes.map((change) => change.path)));
  }, [changes]);

  const togglePath = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const typeLabel = (type: string) => {
    if (type === 'create') return 'new';
    if (type === 'delete') return 'del';
    return 'edit';
  };

  return (
    <div class="reader-ai-staged-changes">
      <div class="reader-ai-staged-changes-header">
        <span>
          Staged changes ({changes.length} file{changes.length === 1 ? '' : 's'})
        </span>
      </div>
      {changes.map((change) => (
        <div key={change.path} class="reader-ai-staged-change">
          <button type="button" class="reader-ai-staged-change-header" onClick={() => togglePath(change.path)}>
            {expandedPaths.has(change.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span class={`reader-ai-staged-change-type reader-ai-staged-change-type--${change.type}`}>
              {typeLabel(change.type)}
            </span>
            <span class="reader-ai-staged-change-path">{change.path}</span>
          </button>
          {expandedPaths.has(change.path) ? <DiffView diff={change.diff} /> : null}
        </div>
      ))}
      {canApply ? (
        <div class="reader-ai-staged-changes-footer">
          {applyToEditor ? null : (
            <input
              type="text"
              class="reader-ai-staged-changes-commit-input"
              placeholder="Commit message (optional)"
              value={commitMessage}
              onInput={(e) => setCommitMessage(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !applying) {
                  e.preventDefault();
                  onApply(commitMessage.trim() || undefined);
                }
              }}
              disabled={applying}
            />
          )}
          <button
            type="button"
            class="reader-ai-staged-changes-apply"
            onClick={() => onApply(applyToEditor ? undefined : commitMessage.trim() || undefined)}
            disabled={applying}
          >
            {applying ? (applyToEditor ? 'Applying…' : 'Committing…') : applyToEditor ? 'Apply to editor' : 'Commit'}
          </button>
        </div>
      ) : (
        <div class="reader-ai-staged-changes-footer reader-ai-staged-changes-footer--readonly">
          Read-only — no write access
        </div>
      )}
    </div>
  );
}
