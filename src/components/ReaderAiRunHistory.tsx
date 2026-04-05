import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
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

function readerAiRetryReasonLabel(step: ReaderAiRunStep): string | null {
  if (step.retryReason === 'tool-arguments') return 'Argument repair';
  if (step.retryReason === 'task-failure') return 'Task retry';
  if (step.retryReason === 'transient') return 'Transient retry';
  if (step.retryReason === 'unknown') return 'Retry suggested';
  return null;
}

function handleReaderAiDisclosureKeyDown(event: KeyboardEvent, onToggle: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onToggle();
}

export function ReaderAiRunHistorySection({
  runs,
  activeRunId,
  onRetryStep,
}: {
  runs: ReaderAiRunRecord[];
  activeRunId?: string | null;
  onRetryStep?: (target: { runId: string; stepId: string }) => Promise<void>;
}) {
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => {
    const initialRun = runs.at(-1);
    return initialRun ? new Set([initialRun.id]) : new Set();
  });
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(() => new Set());
  const previousActiveRunIdRef = useRef<string | null>(activeRunId ?? null);

  const visibleRuns = useMemo(() => runs.slice().reverse(), [runs]);
  if (visibleRuns.length === 0) return null;

  const toggleRun = (runId: string) => {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const toggleStep = (stepId: string) => {
    setExpandedStepIds((current) => {
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  useEffect(() => {
    if (!activeRunId || previousActiveRunIdRef.current === activeRunId) return;
    previousActiveRunIdRef.current = activeRunId;
    setExpandedRunIds((current) => {
      const next = new Set(current);
      next.add(activeRunId);
      return next;
    });
  }, [activeRunId]);

  return (
    <div class="reader-ai-run-history">
      <div class="reader-ai-run-history-list">
        {visibleRuns.map((run) => {
          const runExpanded = expandedRunIds.has(run.id);
          return (
            <div
              key={run.id}
              class={`reader-ai-run-card reader-ai-run-card--${run.status}${run.id === activeRunId ? ' reader-ai-run-card--active' : ''}`}
            >
              <div
                class="reader-ai-run-card-toggle"
                role="button"
                tabIndex={0}
                aria-expanded={runExpanded}
                onClick={() => toggleRun(run.id)}
                onKeyDown={(event) => handleReaderAiDisclosureKeyDown(event, () => toggleRun(run.id))}
              >
                {runExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span class="reader-ai-run-card-title">{run.modelId}</span>
                <span class={`reader-ai-run-card-status reader-ai-run-card-status--${run.status}`}>
                  {readerAiRunStatusLabel(run)}
                </span>
              </div>
              {runExpanded ? (
                <div class="reader-ai-run-card-meta">
                  <span>{formatReaderAiRunTime(run.createdAt)}</span>
                  <span>
                    {run.steps.length} step{run.steps.length === 1 ? '' : 's'}
                  </span>
                </div>
              ) : null}
              {runExpanded ? (
                <>
                  <div class="reader-ai-run-steps">
                    {run.steps.length > 0 ? (
                      run.steps.map((step) => (
                        <div
                          key={step.id}
                          class={`reader-ai-run-step reader-ai-run-step--${step.status}${step.retryState === 'in_progress' ? ' reader-ai-run-step--retrying' : ''}`}
                        >
                          <div
                            class="reader-ai-run-step-toggle"
                            role="button"
                            tabIndex={0}
                            onClick={() => toggleStep(step.id)}
                            onKeyDown={(event) => handleReaderAiDisclosureKeyDown(event, () => toggleStep(step.id))}
                            aria-expanded={expandedStepIds.has(step.id)}
                          >
                            {expandedStepIds.has(step.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
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
                          {expandedStepIds.has(step.id) ? (
                            <div class="reader-ai-run-step-inspector">
                              {step.args ? (
                                <div class="reader-ai-run-step-inspector-block">
                                  <div class="reader-ai-run-step-inspector-label">Arguments</div>
                                  <pre class="reader-ai-run-step-inspector-code">{step.args}</pre>
                                </div>
                              ) : null}
                              {step.errorCode || readerAiRetryReasonLabel(step) ? (
                                <div class="reader-ai-run-step-inspector-meta">
                                  {step.errorCode ? (
                                    <span class="reader-ai-run-step-chip">Error: {step.errorCode}</span>
                                  ) : null}
                                  {readerAiRetryReasonLabel(step) ? (
                                    <span class="reader-ai-run-step-chip">{readerAiRetryReasonLabel(step)}</span>
                                  ) : null}
                                </div>
                              ) : null}
                              {step.retryable && step.retryState === 'ready' && onRetryStep ? (
                                <div class="reader-ai-run-step-actions">
                                  <button
                                    type="button"
                                    class="reader-ai-run-step-action"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void onRetryStep({ runId: run.id, stepId: step.id });
                                    }}
                                  >
                                    Retry step
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div class="reader-ai-run-step reader-ai-run-step--empty">
                        No tool or task steps were recorded.
                      </div>
                    )}
                  </div>
                  {run.error ? <div class="reader-ai-run-card-error">{run.error}</div> : null}
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
