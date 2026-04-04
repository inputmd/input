import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'preact/hooks';
import type { ReaderAiRunRecord, ReaderAiRunStep } from '../reader_ai_ledger';

function formatReaderAiRunTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function readerAiRunStatusLabel(run: ReaderAiRunRecord): string {
  if (run.status === 'completed') return 'Completed';
  if (run.status === 'failed') return 'Failed';
  if (run.status === 'aborted') return 'Stopped';
  return 'Running';
}

function readerAiStepStatusLabel(step: ReaderAiRunStep): string {
  if (step.retryState === 'in_progress') return 'Retrying';
  if (step.status === 'completed') return 'Done';
  if (step.status === 'failed') return 'Failed';
  return 'Running';
}

function readerAiRetryLabel(step: ReaderAiRunStep): string | null {
  if (!step.retryable) return null;
  if (step.retryState === 'ready') {
    return `Retry available${step.maxRetries > 0 ? ` (${step.retryCount}/${step.maxRetries})` : ''}`;
  }
  if (step.retryState === 'in_progress') {
    return `Retrying (${step.retryCount}/${step.maxRetries})`;
  }
  if (step.retryState === 'exhausted') {
    return `Retry limit reached (${step.retryCount}/${step.maxRetries})`;
  }
  return null;
}

export function ReaderAiRunHistorySection({
  runs,
  activeRunId,
}: {
  runs: ReaderAiRunRecord[];
  activeRunId?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());

  const visibleRuns = useMemo(() => runs.slice().reverse().slice(0, 6), [runs]);
  if (visibleRuns.length === 0) return null;

  const runningCount = visibleRuns.filter((run) => run.status === 'running').length;
  const summary =
    runningCount > 0
      ? `${visibleRuns.length} recent run${visibleRuns.length === 1 ? '' : 's'} · ${runningCount} active`
      : `${visibleRuns.length} recent run${visibleRuns.length === 1 ? '' : 's'}`;

  const toggleRun = (runId: string) => {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  return (
    <div class="reader-ai-run-history">
      <button
        type="button"
        class="reader-ai-run-history-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{summary}</span>
      </button>
      {expanded ? (
        <div class="reader-ai-run-history-list">
          {visibleRuns.map((run, index) => {
            const runExpanded = run.id === activeRunId || expandedRunIds.has(run.id) || (index === 0 && !activeRunId);
            return (
              <div
                key={run.id}
                class={`reader-ai-run-card reader-ai-run-card--${run.status}${run.id === activeRunId ? ' reader-ai-run-card--active' : ''}`}
              >
                <button type="button" class="reader-ai-run-card-toggle" onClick={() => toggleRun(run.id)}>
                  {runExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span class="reader-ai-run-card-title">{run.modelId}</span>
                  <span class={`reader-ai-run-card-status reader-ai-run-card-status--${run.status}`}>
                    {readerAiRunStatusLabel(run)}
                  </span>
                </button>
                <div class="reader-ai-run-card-meta">
                  <span>{formatReaderAiRunTime(run.createdAt)}</span>
                  <span>
                    {run.steps.length} step{run.steps.length === 1 ? '' : 's'}
                  </span>
                </div>
                {run.error ? <div class="reader-ai-run-card-error">{run.error}</div> : null}
                {runExpanded ? (
                  <div class="reader-ai-run-steps">
                    {run.steps.length > 0 ? (
                      run.steps.map((step) => (
                        <div
                          key={step.id}
                          class={`reader-ai-run-step reader-ai-run-step--${step.status}${step.retryState === 'in_progress' ? ' reader-ai-run-step--retrying' : ''}`}
                        >
                          <div class="reader-ai-run-step-header">
                            <span class="reader-ai-run-step-name">{step.name}</span>
                            <span class={`reader-ai-run-step-status reader-ai-run-step-status--${step.status}`}>
                              {readerAiStepStatusLabel(step)}
                            </span>
                          </div>
                          {step.detail ? <div class="reader-ai-run-step-detail">{step.detail}</div> : null}
                          {step.error ? <div class="reader-ai-run-step-error">{step.error}</div> : null}
                          {readerAiRetryLabel(step) ? (
                            <div class="reader-ai-run-step-retry">{readerAiRetryLabel(step)}</div>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div class="reader-ai-run-step reader-ai-run-step--empty">
                        No tool or task steps were recorded.
                      </div>
                    )}
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
