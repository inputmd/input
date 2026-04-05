import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'preact/hooks';

export interface ReaderAiToolLogEntry {
  type: 'call' | 'result' | 'progress';
  id?: string;
  name: string;
  detail?: string;
  toolArguments?: string;
  taskId?: string;
  taskStatus?: 'running' | 'completed' | 'error';
  tone?: 'default' | 'success' | 'warning' | 'error';
  callStatus?: 'succeeded' | 'rejected';
}

export const TOOL_LABELS: Record<string, string> = {
  read_document: 'Read document',
  search_document: 'Search document',
  propose_replace_region: 'Propose region replacement',
  propose_replace_matches: 'Propose match replacement',
  task: 'Subagent',
};

function taskCardTitle(index: number): string {
  return `Subagent ${index + 1}`;
}

function taskStatusLabel(status: ReaderAiToolLogEntry['taskStatus']): string {
  if (status === 'completed') return 'done';
  if (status === 'error') return 'error';
  return 'running';
}

export function ToolLogSection({
  entries,
  live,
  proposalStatusesByToolCallId,
}: {
  entries: ReaderAiToolLogEntry[];
  live?: boolean;
  proposalStatusesByToolCallId?: Record<string, 'accepted' | 'rejected' | 'ignored'>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());
  if (entries.length === 0) return null;

  const activityCount = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.id) ids.add(entry.id);
    }
    return ids.size;
  }, [entries]);
  const summary = live
    ? `${activityCount} tool call${activityCount === 1 ? '' : 's'}…`
    : `${activityCount} tool call${activityCount === 1 ? '' : 's'}`;

  // Auto-expand while live
  const isExpanded = live || expanded;

  const grouped = useMemo(() => {
    const taskCards: Array<{
      taskId: string;
      index: number;
      entries: ReaderAiToolLogEntry[];
      status: NonNullable<ReaderAiToolLogEntry['taskStatus']>;
    }> = [];
    const taskIndexById = new Map<string, number>();
    const generalEntries: ReaderAiToolLogEntry[] = [];
    for (const entry of entries) {
      if (!entry.taskId) {
        generalEntries.push(entry);
        continue;
      }
      const existingIndex = taskIndexById.get(entry.taskId);
      if (existingIndex === undefined) {
        taskIndexById.set(entry.taskId, taskCards.length);
        taskCards.push({
          taskId: entry.taskId,
          index: taskCards.length,
          entries: [entry],
          status: entry.taskStatus ?? 'running',
        });
        continue;
      }
      const card = taskCards[existingIndex];
      card.entries.push(entry);
      card.status = entry.taskStatus ?? card.status;
    }
    return { generalEntries, taskCards };
  }, [entries]);

  const toggleTask = (taskId: string) => {
    setExpandedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const showProposalStatusNote = (entry: ReaderAiToolLogEntry): boolean =>
    entry.type === 'call' && (entry.name === 'propose_replace_region' || entry.name === 'propose_replace_matches');

  const entryCallStatus = (
    entry: ReaderAiToolLogEntry,
  ): { label: 'Success' | 'Error' | 'Rejected'; tone: 'success' | 'warning' } | null => {
    if (entry.type !== 'call') return null;
    const proposalStatus = entry.id ? proposalStatusesByToolCallId?.[entry.id] : undefined;
    if (proposalStatus === 'accepted') return { label: 'Success', tone: 'success' };
    if (proposalStatus === 'rejected') return { label: 'Rejected', tone: 'warning' };
    if (entry.callStatus === 'succeeded') return { label: 'Success', tone: 'success' };
    if (entry.callStatus === 'rejected') return { label: 'Error', tone: 'warning' };
    return null;
  };

  const renderEntryCallStatus = (entry: ReaderAiToolLogEntry) => {
    const status = entryCallStatus(entry);
    if (!status) return null;
    return (
      <span class={`reader-ai-tool-log-status-note reader-ai-tool-log-status-note--${status.tone}`}>
        {status.label}
      </span>
    );
  };

  return (
    <div class="reader-ai-tool-log">
      <a
        href="#"
        class="reader-ai-tool-log-toggle"
        aria-expanded={isExpanded}
        onClick={(event) => {
          event.preventDefault();
          setExpanded(!expanded);
        }}
      >
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{summary}</span>
      </a>
      {isExpanded ? (
        <div class="reader-ai-tool-log-entries">
          {grouped.generalEntries
            .filter((entry) => entry.type !== 'result')
            .map((entry, i) => {
              return (
                <div
                  key={`general:${i}`}
                  class={`reader-ai-tool-log-entry reader-ai-tool-log-entry--${entry.type}${
                    entry.tone ? ` reader-ai-tool-log-entry--tone-${entry.tone}` : ''
                  }${showProposalStatusNote(entry) ? ' reader-ai-tool-log-entry--proposal-call' : ''}`}
                >
                  <span class="reader-ai-tool-log-name">{TOOL_LABELS[entry.name] ?? entry.name}</span>
                  {renderEntryCallStatus(entry)}
                </div>
              );
            })}
          {grouped.taskCards.map((card) => {
            const taskExpanded = live || expandedTaskIds.has(card.taskId);
            return (
              <div key={card.taskId} class={`reader-ai-tool-task reader-ai-tool-task--${card.status}`}>
                <button type="button" class="reader-ai-tool-task-toggle" onClick={() => toggleTask(card.taskId)}>
                  {taskExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span class="reader-ai-tool-task-title">{taskCardTitle(card.index)}</span>
                  <span class={`reader-ai-tool-task-status reader-ai-tool-task-status--${card.status}`}>
                    {taskStatusLabel(card.status)}
                  </span>
                </button>
                {taskExpanded ? (
                  <div class="reader-ai-tool-task-entries">
                    {card.entries
                      .filter((entry) => entry.type !== 'result')
                      .map((entry, entryIndex) => {
                        return (
                          <div
                            key={`${card.taskId}:${entryIndex}`}
                            class={`reader-ai-tool-log-entry reader-ai-tool-log-entry--${entry.type}${
                              entry.tone ? ` reader-ai-tool-log-entry--tone-${entry.tone}` : ''
                            }${showProposalStatusNote(entry) ? ' reader-ai-tool-log-entry--proposal-call' : ''}`}
                          >
                            <span class="reader-ai-tool-log-name">{TOOL_LABELS[entry.name] ?? entry.name}</span>
                            {renderEntryCallStatus(entry)}
                          </div>
                        );
                      })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
