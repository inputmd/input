import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'preact/hooks';

export interface ReaderAiToolLogEntry {
  type: 'call' | 'result' | 'progress';
  name: string;
  detail?: string;
}

export const TOOL_LABELS: Record<string, string> = {
  read_document: 'Read document',
  search_document: 'Search document',
  edit_document: 'Edit document',
  read_file: 'Read file',
  search_files: 'Search files',
  list_files: 'List files',
  edit_file: 'Edit file',
  create_file: 'Create file',
  delete_file: 'Delete file',
  task: 'Subagent',
};

export function ToolLogSection({ entries, live }: { entries: ReaderAiToolLogEntry[]; live?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) return null;

  const visibleEntries = entries.filter((e) => e.type !== 'result');
  const activityCount = visibleEntries.length;
  const summary = live
    ? `${activityCount} tool activit${activityCount === 1 ? 'y' : 'ies'}…`
    : `${activityCount} tool activit${activityCount === 1 ? 'y' : 'ies'}`;

  // Auto-expand while live
  const isExpanded = live || expanded;

  return (
    <div class="reader-ai-tool-log">
      <button type="button" class="reader-ai-tool-log-toggle" onClick={() => setExpanded(!expanded)}>
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{summary}</span>
      </button>
      {isExpanded ? (
        <div class="reader-ai-tool-log-entries">
          {visibleEntries.map((entry, i) => (
            <div key={i} class="reader-ai-tool-log-entry">
              <span class="reader-ai-tool-log-name">{TOOL_LABELS[entry.name] ?? entry.name}</span>
              {entry.detail ? (
                <span class="reader-ai-tool-log-detail">
                  {entry.detail.length > 60 ? `${entry.detail.slice(0, 60)}…` : entry.detail}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
