import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ReaderAiRunRecord, ReaderAiRunStep } from '../reader_ai_ledger';
import { buildToolCallJson, copyTextToClipboard } from '../util';

const TOOL_LABELS: Record<string, string> = {
  read_document: 'Read document',
  search_document: 'Search document',
  propose_edit_document: 'Propose document edit',
  task: 'Subagent',
};

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

function parseReaderAiStepArgs(step: ReaderAiRunStep): Record<string, unknown> | null {
  if (!step.args) return null;
  try {
    const parsed = JSON.parse(step.args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readIntegerArg(args: Record<string, unknown> | null, key: string): number | null {
  if (!args) return null;
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null;
}

function readStringArg(args: Record<string, unknown> | null, key: string): string | null {
  if (!args) return null;
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function quoteSummaryText(value: string, maxLength = 60): string {
  return `"${truncateText(compactWhitespace(value), maxLength)}"`;
}

function describeLineRange(verb: string, startLine: number | null, endLine: number | null): string {
  if (startLine !== null && endLine !== null) {
    return startLine === endLine ? `${verb} line ${startLine}` : `${verb} lines ${startLine}-${endLine}`;
  }
  if (startLine !== null) return `${verb} from line ${startLine}`;
  if (endLine !== null) return `${verb} through line ${endLine}`;
  return `${verb} the full document`;
}

function describeEditRange(verb: string, startLine: number | null, endLine: number | null): string {
  if (startLine !== null && endLine !== null) {
    return startLine === endLine
      ? `${verb} an edit for line ${startLine}`
      : `${verb} edits for lines ${startLine}-${endLine}`;
  }
  if (startLine !== null) return `${verb} edits from line ${startLine}`;
  if (endLine !== null) return `${verb} edits through line ${endLine}`;
  return `${verb} a document edit`;
}

function readerAiStepSummary(step: ReaderAiRunStep): string {
  const args = parseReaderAiStepArgs(step);

  if (step.name === 'read_document') {
    return describeLineRange('Read', readIntegerArg(args, 'start_line'), readIntegerArg(args, 'end_line'));
  }

  if (step.name === 'search_document') {
    const query = readStringArg(args, 'query');
    const isRegex = args?.is_regex === true;
    if (!query) return isRegex ? 'Ran a regex search' : 'Searched the document';
    return isRegex ? `Ran regex search ${quoteSummaryText(query, 52)}` : `Searched for ${quoteSummaryText(query)}`;
  }

  if (step.name === 'propose_edit_document') {
    const edits = Array.isArray(args?.edits) ? args.edits : null;
    const dryRun = args?.dry_run === true;
    const verb = dryRun ? 'Previewed' : 'Drafted';
    if (edits && edits.length > 0) {
      return `${verb} ${edits.length} document edit${edits.length === 1 ? '' : 's'}`;
    }
    const startLine = readIntegerArg(args, 'start_line');
    const endLine = readIntegerArg(args, 'end_line');
    if (startLine !== null || endLine !== null) return describeEditRange(verb, startLine, endLine);
    if (typeof args?.old_text === 'string' && typeof args?.new_text === 'string') {
      return `${verb} a text replacement`;
    }
    return `${verb} a document edit`;
  }

  if (step.name === 'task') {
    const prompt = readStringArg(args, 'prompt');
    if (!prompt) return 'Ran a subagent';
    return `Ran a subagent for ${quoteSummaryText(prompt, 72)}`;
  }

  return TOOL_LABELS[step.name] ?? step.name;
}

function readerAiStepLabel(step: ReaderAiRunStep): string {
  return TOOL_LABELS[step.name] ?? step.name;
}

function readerAiStepDetail(step: ReaderAiRunStep): { label: string; text: string; tone: 'default' | 'error' } | null {
  const detail = step.detail?.trim();
  const error = step.error?.trim();
  if (step.status === 'failed') {
    if (detail) return { label: 'Failed', text: detail, tone: 'error' };
    if (error) return { label: 'Failed', text: error, tone: 'error' };
    return null;
  }
  if (!detail) return null;
  return { label: step.status === 'running' ? 'Working on' : 'Result', text: detail, tone: 'default' };
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
                        const stepSummary = readerAiStepSummary(step);
                        const stepLabel = readerAiStepLabel(step);
                        const stepDetail = readerAiStepDetail(step);
                        const showInspector =
                          expanded &&
                          (Boolean(step.errorCode) ||
                            step.name !== stepLabel ||
                            Boolean(step.toolCallId) ||
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
                              <div class="reader-ai-run-step-heading">
                                <span class="reader-ai-run-step-name">{stepSummary}</span>
                                <span class="reader-ai-run-step-label">{stepLabel}</span>
                              </div>
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
                            {stepDetail ? (
                              <div
                                class={`reader-ai-run-step-detail-block${
                                  stepDetail.tone === 'error' ? ' reader-ai-run-step-detail-block--error' : ''
                                }`}
                              >
                                <span class="reader-ai-run-step-detail-label">{stepDetail.label}</span>
                                <div class="reader-ai-run-step-detail">{stepDetail.text}</div>
                              </div>
                            ) : null}
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
                                {step.name !== stepLabel || step.toolCallId ? (
                                  <div class="reader-ai-run-step-inspector-meta">
                                    <span class="reader-ai-run-step-chip">Tool: {step.name}</span>
                                    {step.toolCallId ? (
                                      <span class="reader-ai-run-step-chip">Call: {step.toolCallId}</span>
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
