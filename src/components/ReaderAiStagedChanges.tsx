import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'preact/hooks';
import type { ReaderAiStagedChange } from '../reader_ai';

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre class="reader-ai-diff">
      {lines.map((line, i) => {
        let cls = 'reader-ai-diff-line';
        if (line.startsWith('+++') || line.startsWith('---')) cls += ' reader-ai-diff-line--header';
        else if (line.startsWith('@@')) cls += ' reader-ai-diff-line--hunk';
        else if (line.startsWith('+')) cls += ' reader-ai-diff-line--add';
        else if (line.startsWith('-')) cls += ' reader-ai-diff-line--del';
        return (
          <div key={i} class={cls}>
            {line}
          </div>
        );
      })}
    </pre>
  );
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
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage);
  if (changes.length === 0) return null;

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
