import type { ComponentChildren } from 'preact';

export interface DiffChangeEntry {
  path: string;
  diff: string;
}

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
      {hasLeadingClip ? <span class="reader-ai-diff-inline-ellipsis">...</span> : null}
      {clippedPrefix}
      {changed ? <span class={changedClass}>{changed}</span> : null}
      {clippedSuffix}
      {hasTrailingClip ? <span class="reader-ai-diff-inline-ellipsis">...</span> : null}
    </>
  );
}

export function UnifiedDiffView({ diff }: { diff: string }) {
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

interface SideBySideRow {
  left: string | null;
  right: string | null;
  kind: 'context' | 'add' | 'del' | 'replace' | 'meta';
}

function buildSideBySideRows(diff: string): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  const lines = diff.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('@@')) {
      rows.push({ left: line, right: line, kind: 'meta' });
      continue;
    }
    if (line.startsWith('-')) {
      const next = lines[i + 1];
      if (next?.startsWith('+') && !next.startsWith('+++')) {
        rows.push({ left: line.slice(1), right: next.slice(1), kind: 'replace' });
        i++;
        continue;
      }
      rows.push({ left: line.slice(1), right: null, kind: 'del' });
      continue;
    }
    if (line.startsWith('+')) {
      rows.push({ left: null, right: line.slice(1), kind: 'add' });
      continue;
    }
    if (line.startsWith(' ')) {
      const content = line.slice(1);
      rows.push({ left: content, right: content, kind: 'context' });
      continue;
    }
    rows.push({ left: line, right: line, kind: 'meta' });
  }
  return rows;
}

export function SideBySideDiffView({
  changes,
  leftLabel = 'Original',
  rightLabel = 'Updated',
}: {
  changes: DiffChangeEntry[];
  leftLabel?: string;
  rightLabel?: string;
}) {
  return (
    <>
      <div class="reader-ai-diff-popout-cols">
        <div class="reader-ai-diff-popout-col-head">{leftLabel}</div>
        <div class="reader-ai-diff-popout-col-head">{rightLabel}</div>
      </div>
      <div class="reader-ai-diff-popout-grid">
        {changes.map((change) => {
          const rows = buildSideBySideRows(change.diff);
          return (
            <div key={change.path} class="reader-ai-diff-popout-file">
              <div class="reader-ai-diff-popout-file-path">{change.path}</div>
              {rows.map((row, idx) => (
                <div key={`${change.path}:${idx}`} class="reader-ai-diff-popout-row">
                  <div
                    class={`reader-ai-diff-popout-cell reader-ai-diff-popout-cell--left${
                      row.kind === 'del' || row.kind === 'replace'
                        ? ' reader-ai-diff-popout-cell--del'
                        : row.kind === 'meta'
                          ? ' reader-ai-diff-popout-cell--meta'
                          : ''
                    }`}
                  >
                    {row.left ?? ''}
                  </div>
                  <div
                    class={`reader-ai-diff-popout-cell reader-ai-diff-popout-cell--right${
                      row.kind === 'add' || row.kind === 'replace'
                        ? ' reader-ai-diff-popout-cell--add'
                        : row.kind === 'meta'
                          ? ' reader-ai-diff-popout-cell--meta'
                          : ''
                    }`}
                  >
                    {row.right ?? ''}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
