import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ReaderAiRunRecord, ReaderAiRunStep } from '../reader_ai_ledger';
import { buildToolCallJson, copyTextToClipboard } from '../util';

function formatReaderAiRunTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function readerAiRunStatusLabel(run: ReaderAiRunRecord): string {
  if (run.status === 'completed') return 'Completed';
  if (run.status === 'failed') return 'Failed';
  if (run.status === 'aborted') return 'Stopped';
  return 'Incomplete';
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

function stepToolCallJson(step: ReaderAiRunStep): string | null {
  if (!step.toolCallId) return null;
  return buildToolCallJson({
    id: step.toolCallId,
    name: step.name,
    argumentsJson: step.args,
  });
}

export function ReaderAiRunHistorySection({
  runs,
  onRetryStep,
}: {
  runs: ReaderAiRunRecord[];
  onRetryStep?: (target: { runId: string; stepId: string }) => Promise<void>;
}) {
  const visibleRuns = useMemo(() => runs.slice().reverse(), [runs]);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set(runs.map((run) => run.id)));
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(() => new Set());
  const knownRunIdsRef = useRef<Set<string>>(new Set(runs.map((run) => run.id)));
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
    const newRunIds = runs.map((run) => run.id).filter((id) => !knownRunIdsRef.current.has(id));
    if (newRunIds.length > 0) {
      setExpandedRunIds((current) => new Set([...current, ...newRunIds]));
      for (const id of newRunIds) knownRunIdsRef.current.add(id);
    }
  }, [runs]);

  return (
    <div class="reader-ai-run-history">
      <div class="reader-ai-run-history-list">
        {visibleRuns.map((run) => {
          const runExpanded = expandedRunIds.has(run.id);
          return (
            <div key={run.id} class={`reader-ai-run-card reader-ai-run-card--${run.status}`}>
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
                      run.steps.map((step) => {
                        const expanded = expandedStepIds.has(step.id);
                        const retryLabel = readerAiRetryLabel(step);
                        const retryReasonLabel = readerAiRetryReasonLabel(step);
                        const toolCallJson = stepToolCallJson(step);
                        const showInspector =
                          expanded &&
                          (Boolean(step.errorCode) ||
                            Boolean(retryReasonLabel) ||
                            (step.retryable && step.retryState === 'ready' && Boolean(onRetryStep)));

                        return (
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
                              aria-expanded={expanded}
                            >
                              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                              <span class="reader-ai-run-step-name">{step.name}</span>
                              {toolCallJson ? (
                                <button
                                  type="button"
                                  class="reader-ai-tool-copy-btn"
                                  aria-label={`Copy ${step.name} tool call JSON`}
                                  title="Copy tool call JSON"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void copyTextToClipboard(toolCallJson);
                                  }}
                                >
                                  <Copy size={12} aria-hidden="true" />
                                </button>
                              ) : null}
                              <span class={`reader-ai-run-step-status reader-ai-run-step-status--${step.status}`}>
                                {readerAiStepStatusLabel(step)}
                              </span>
                            </div>
                            {step.detail ? <div class="reader-ai-run-step-detail">{step.detail}</div> : null}
                            {step.error ? <div class="reader-ai-run-step-error">{step.error}</div> : null}
                            {retryLabel ? <div class="reader-ai-run-step-retry">{retryLabel}</div> : null}
                            {showInspector ? (
                              <div class="reader-ai-run-step-inspector">
                                {step.errorCode || retryReasonLabel ? (
                                  <div class="reader-ai-run-step-inspector-meta">
                                    {step.errorCode ? (
                                      <span class="reader-ai-run-step-chip">Error: {step.errorCode}</span>
                                    ) : null}
                                    {retryReasonLabel ? (
                                      <span class="reader-ai-run-step-chip">{retryReasonLabel}</span>
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
                        );
                      })
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
