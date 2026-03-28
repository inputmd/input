import { useMemo } from 'preact/hooks';

interface StreamingEditPreview {
  toolCallId: string;
  name: string;
  path?: string;
  oldText?: string;
  newText?: string;
  content?: string;
}

/**
 * Try to extract field values from a partial JSON string being streamed.
 * Handles incomplete strings by finding quoted field values.
 */
function extractPartialJsonField(json: string, field: string): string | undefined {
  // Look for "field": "value..." pattern
  const patterns = [`"${field}"`, `"${field}" `];
  for (const pattern of patterns) {
    const keyIdx = json.indexOf(pattern);
    if (keyIdx === -1) continue;
    const afterKey = json.indexOf(':', keyIdx + pattern.length);
    if (afterKey === -1) continue;
    // Find the opening quote of the value
    const valueStart = json.indexOf('"', afterKey + 1);
    if (valueStart === -1) continue;
    // Find the closing quote, handling escaped quotes
    let i = valueStart + 1;
    let value = '';
    while (i < json.length) {
      if (json[i] === '\\' && i + 1 < json.length) {
        const escaped = json[i + 1];
        if (escaped === 'n') value += '\n';
        else if (escaped === 't') value += '\t';
        else if (escaped === 'r') value += '\r';
        else if (escaped === '"') value += '"';
        else if (escaped === '\\') value += '\\';
        else value += json.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (json[i] === '"') {
        return value;
      }
      value += json[i];
      i++;
    }
    // Unterminated string — return what we have (still streaming)
    if (value.length > 0) return value;
  }
  return undefined;
}

function parseStreamingEditArgs(argumentsSoFar: string, name: string): StreamingEditPreview | null {
  if (!argumentsSoFar || argumentsSoFar.length < 10) return null;

  const path = extractPartialJsonField(argumentsSoFar, 'path');

  if (name === 'propose_create_file' || name === 'propose_delete_file') {
    const content = extractPartialJsonField(argumentsSoFar, 'content');
    if (path) return { toolCallId: '', name, path, content };
    return null;
  }

  const oldText = extractPartialJsonField(argumentsSoFar, 'old_text');
  const newText = extractPartialJsonField(argumentsSoFar, 'new_text');

  if (!oldText && !newText && !path) return null;
  return { toolCallId: '', name, path, oldText, newText };
}

function buildStreamingDiffLines(
  preview: StreamingEditPreview,
): { type: 'context' | 'del' | 'add' | 'info'; text: string }[] {
  const lines: { type: 'context' | 'del' | 'add' | 'info'; text: string }[] = [];

  if (preview.name === 'propose_create_file') {
    if (preview.path) lines.push({ type: 'info', text: `Creating ${preview.path}` });
    if (preview.content) {
      for (const line of preview.content.split('\n')) {
        lines.push({ type: 'add', text: `+${line}` });
      }
    }
    return lines;
  }

  if (preview.name === 'propose_delete_file') {
    if (preview.path) lines.push({ type: 'info', text: `Deleting ${preview.path}` });
    return lines;
  }

  if (preview.oldText) {
    for (const line of preview.oldText.split('\n')) {
      lines.push({ type: 'del', text: `-${line}` });
    }
  }
  if (preview.newText) {
    for (const line of preview.newText.split('\n')) {
      lines.push({ type: 'add', text: `+${line}` });
    }
  }

  return lines;
}

export function StreamingDiffPreview({
  toolCallId,
  name,
  argumentsSoFar,
}: {
  toolCallId: string;
  name: string;
  argumentsSoFar: string;
}) {
  const preview = useMemo(() => parseStreamingEditArgs(argumentsSoFar, name), [argumentsSoFar, name]);

  if (!preview) return null;

  const diffLines = buildStreamingDiffLines(preview);
  if (diffLines.length === 0) return null;

  const path = preview.path;
  const isStreaming = !argumentsSoFar.trimEnd().endsWith('}');

  return (
    <div class="reader-ai-streaming-diff" data-tool-call-id={toolCallId}>
      {path ? (
        <div class="reader-ai-streaming-diff-header">
          <span class="reader-ai-streaming-diff-path">{path}</span>
          {isStreaming ? (
            <span class="reader-ai-thinking-spinner reader-ai-thinking-spinner--inline" aria-hidden="true" />
          ) : null}
        </div>
      ) : null}
      <pre class="reader-ai-diff reader-ai-streaming-diff-content">
        {diffLines.map((line, i) => (
          <div
            key={`${toolCallId}-${i}`}
            class={`reader-ai-diff-line${
              line.type === 'add'
                ? ' reader-ai-diff-line--add'
                : line.type === 'del'
                  ? ' reader-ai-diff-line--del'
                  : line.type === 'info'
                    ? ' reader-ai-diff-line--hunk'
                    : ''
            }`}
          >
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
