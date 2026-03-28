import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'preact/hooks';
import type { ReaderAiEditProposal } from '../reader_ai';
import { ReaderAiEditProposalCard } from './ReaderAiEditProposalCard';

export interface ReaderAiToolLogEntry {
  type: 'call' | 'result' | 'progress';
  id?: string;
  name: string;
  detail?: string;
  taskId?: string;
  taskStatus?: 'running' | 'completed' | 'error';
  tone?: 'default' | 'success' | 'error';
}

export const TOOL_LABELS: Record<string, string> = {
  read_document: 'Read document',
  search_document: 'Search document',
  propose_edit_document: 'Propose document edit',
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
  proposals,
  onAcceptProposal,
  onRejectProposal,
  onEditProposal,
  onToggleProposalHunkSelection,
}: {
  entries: ReaderAiToolLogEntry[];
  live?: boolean;
  proposals?: ReaderAiEditProposal[];
  onAcceptProposal?: (proposalId: string) => void;
  onRejectProposal?: (proposalId: string) => void;
  onEditProposal?: (proposalId: string) => void;
  onToggleProposalHunkSelection?: (proposalId: string, hunkId: string, selected: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());
  if (entries.length === 0) return null;

  const activityCount = entries.length;
  const summary = live
    ? `${activityCount} tool activit${activityCount === 1 ? 'y' : 'ies'}…`
    : `${activityCount} tool activit${activityCount === 1 ? 'y' : 'ies'}`;

  // Auto-expand while live
  const isExpanded = live || expanded || (proposals?.length ?? 0) > 0;
  const proposalsByToolCallId = useMemo(() => {
    const grouped = new Map<string, ReaderAiEditProposal[]>();
    for (const proposal of proposals ?? []) {
      if (!proposal.toolCallId) continue;
      const current = grouped.get(proposal.toolCallId) ?? [];
      current.push(proposal);
      grouped.set(proposal.toolCallId, current);
    }
    return grouped;
  }, [proposals]);

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

  return (
    <div class="reader-ai-tool-log">
      <button type="button" class="reader-ai-tool-log-toggle" onClick={() => setExpanded(!expanded)}>
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{summary}</span>
      </button>
      {isExpanded ? (
        <div class="reader-ai-tool-log-entries">
          {grouped.generalEntries.map((entry, i) => (
            <div key={`general:${i}`} class="reader-ai-tool-log-entry-block">
              <div
                class={`reader-ai-tool-log-entry reader-ai-tool-log-entry--${entry.type}${
                  entry.tone ? ` reader-ai-tool-log-entry--tone-${entry.tone}` : ''
                }`}
              >
                <span class="reader-ai-tool-log-name">{TOOL_LABELS[entry.name] ?? entry.name}</span>
                {entry.detail ? (
                  <span class="reader-ai-tool-log-detail">
                    {entry.detail.length > 90 ? `${entry.detail.slice(0, 90)}…` : entry.detail}
                  </span>
                ) : null}
              </div>
              {entry.type === 'result' && entry.id
                ? (proposalsByToolCallId.get(entry.id) ?? []).map((proposal) => (
                    <ReaderAiEditProposalCard
                      key={proposal.id}
                      proposal={proposal}
                      onAccept={onAcceptProposal}
                      onReject={onRejectProposal}
                      onEdit={onEditProposal}
                      onToggleHunkSelection={onToggleProposalHunkSelection}
                    />
                  ))
                : null}
            </div>
          ))}
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
                    {card.entries.map((entry, entryIndex) => (
                      <div key={`${card.taskId}:${entryIndex}`} class="reader-ai-tool-log-entry-block">
                        <div
                          class={`reader-ai-tool-log-entry reader-ai-tool-log-entry--${entry.type}${
                            entry.tone ? ` reader-ai-tool-log-entry--tone-${entry.tone}` : ''
                          }`}
                        >
                          <span class="reader-ai-tool-log-name">{TOOL_LABELS[entry.name] ?? entry.name}</span>
                          {entry.detail ? (
                            <span class="reader-ai-tool-log-detail">
                              {entry.detail.length > 120 ? `${entry.detail.slice(0, 120)}…` : entry.detail}
                            </span>
                          ) : null}
                        </div>
                        {entry.type === 'result' && entry.id
                          ? (proposalsByToolCallId.get(entry.id) ?? []).map((proposal) => (
                              <ReaderAiEditProposalCard
                                key={proposal.id}
                                proposal={proposal}
                                onAccept={onAcceptProposal}
                                onReject={onRejectProposal}
                                onEdit={onEditProposal}
                                onToggleHunkSelection={onToggleProposalHunkSelection}
                              />
                            ))
                          : null}
                      </div>
                    ))}
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
