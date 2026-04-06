import type { ComponentChildren } from 'preact';
import {
  clipInlineDiffSegmentsForDisplay,
  findUnifiedDiffReplacementPair,
  getUnifiedDiffLineParts,
  type InlineDiffSegment,
  type InlineDisplaySegment,
  prepareUnifiedDiffLines,
  selectInlineDiffSegments,
} from './diff_viewer_utils.ts';

export interface DiffChangeEntry {
  path: string;
  diff: string;
}

function renderInlineDiffSegments(
  segments: InlineDiffSegment[],
  changedClass: string,
  options?: { clipLongLine?: boolean },
): ComponentChildren {
  const visibleSegments: InlineDisplaySegment[] =
    options?.clipLongLine === true
      ? clipInlineDiffSegmentsForDisplay(segments)
      : segments.map((segment) => ({ ...segment }));

  return (
    <>
      {visibleSegments.map((segment, index) =>
        segment.ellipsis ? (
          <span key={index} class="reader-ai-diff-inline-ellipsis">
            {segment.value}
          </span>
        ) : segment.changed ? (
          <span key={index} class={changedClass}>
            {segment.value}
          </span>
        ) : (
          segment.value
        ),
      )}
    </>
  );
}

function renderDiffContent(line: string, changedClass: string, pairLine?: string): ComponentChildren {
  const { content } = getUnifiedDiffLineParts(line);
  if (!pairLine) return content;
  const { content: pairContent } = getUnifiedDiffLineParts(pairLine);
  const isDeletion = line.startsWith('-');
  const segments = selectInlineDiffSegments(
    isDeletion ? content : pairContent,
    isDeletion ? pairContent : content,
    isDeletion ? 'left' : 'right',
  );
  return renderInlineDiffSegments(segments, changedClass);
}

function renderUnifiedDiffLine(
  key: string,
  line: string,
  className: string,
  changedClass?: string,
  pairLine?: string,
): ComponentChildren {
  const { hasSignColumn, sign } = getUnifiedDiffLineParts(line);

  if (!hasSignColumn) {
    return (
      <div key={key} class={className}>
        <span class="reader-ai-diff-line-text reader-ai-diff-line-text--full">{line}</span>
      </div>
    );
  }

  return (
    <div key={key} class={`${className} reader-ai-diff-line--split`}>
      <span class="reader-ai-diff-line-sign" aria-hidden="true">
        {sign}
      </span>
      <span class="reader-ai-diff-line-text">{renderDiffContent(line, changedClass ?? '', pairLine)}</span>
    </div>
  );
}

export function UnifiedDiffView({
  diff,
  clipContextLines = false,
  hideHunkHeaders = false,
}: {
  diff: string;
  clipContextLines?: boolean;
  hideHunkHeaders?: boolean;
}) {
  const lines = prepareUnifiedDiffLines(diff, { clipContextLines, hideHunkHeaders });
  const renderedLines: ComponentChildren[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pairIndex = findUnifiedDiffReplacementPair(lines, i);
    if (pairIndex !== null) {
      const pairLine = lines[pairIndex] ?? '';
      renderedLines.push(
        renderUnifiedDiffLine(
          `${i}-del`,
          line,
          'reader-ai-diff-line reader-ai-diff-line--del',
          'reader-ai-diff-inline-change--del',
          pairLine,
        ),
      );
      renderedLines.push(
        renderUnifiedDiffLine(
          `${pairIndex}-add`,
          pairLine,
          'reader-ai-diff-line reader-ai-diff-line--add',
          'reader-ai-diff-inline-change--add',
          line,
        ),
      );
      i = pairIndex;
      continue;
    }

    let cls = 'reader-ai-diff-line';
    if (line.startsWith('+++') || line.startsWith('---')) cls += ' reader-ai-diff-line--header';
    else if (line.startsWith('@@')) cls += ' reader-ai-diff-line--hunk';
    else if (line.startsWith('+')) cls += ' reader-ai-diff-line--add';
    else if (line.startsWith('-')) cls += ' reader-ai-diff-line--del';
    renderedLines.push(renderUnifiedDiffLine(`${i}`, line, cls));
  }

  return <pre class="reader-ai-diff">{renderedLines}</pre>;
}

interface SideBySideRow {
  left: string | null;
  right: string | null;
  kind: 'context' | 'add' | 'del' | 'replace' | 'meta';
}

function renderSideBySideCellContent(
  leftContent: string | null,
  rightContent: string | null,
  changedClass: string,
  side: 'left' | 'right',
): ComponentChildren {
  const content = side === 'left' ? leftContent : rightContent;
  const pairContent = side === 'left' ? rightContent : leftContent;
  if (content === null) return '';
  if (pairContent === null || content === pairContent) return content;
  return renderInlineDiffSegments(selectInlineDiffSegments(leftContent ?? '', rightContent ?? '', side), changedClass);
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
      const pairIndex = findUnifiedDiffReplacementPair(lines, i);
      if (pairIndex !== null) {
        const pairLine = lines[pairIndex] ?? '';
        rows.push({ left: line.slice(1), right: pairLine.slice(1), kind: 'replace' });
        i = pairIndex;
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
                    {row.kind === 'replace'
                      ? renderSideBySideCellContent(row.left, row.right, 'reader-ai-diff-inline-change--del', 'left')
                      : (row.left ?? '')}
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
                    {row.kind === 'replace'
                      ? renderSideBySideCellContent(row.left, row.right, 'reader-ai-diff-inline-change--add', 'right')
                      : (row.right ?? '')}
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
