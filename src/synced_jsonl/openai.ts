import {
  buildParsedTree,
  isRecord,
  readBoolean,
  readNullableString,
  readNumber,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readString,
  summarizeText,
  summarizeUnknownValue,
} from './shared.ts';
import type {
  OpenAiCodexJsonlEvent,
  OpenAiCodexMessage,
  OpenAiCodexMessageContentPart,
  OpenAiCodexTextContentPart,
  OpenAiCodexToolCallContentPart,
  OpenAiCodexUsage,
  ParsedJsonlLine,
  ParsedOpenAiCodexJsonl,
  ParsedSyncedJsonlEntry,
} from './types.ts';

function parseOpenAiCodexContentPart(value: unknown): OpenAiCodexMessageContentPart | null {
  if (!isRecord(value)) return null;
  const type = readString(value, 'type');
  if (!type) return null;

  if (type === 'text') {
    const text = readString(value, 'text');
    if (text == null) return null;
    const textSignature = readOptionalString(value, 'textSignature');
    return {
      type,
      text,
      ...(textSignature ? { textSignature } : {}),
    };
  }

  if (type === 'thinking') {
    const thinking = readString(value, 'thinking');
    const thinkingSignature = readString(value, 'thinkingSignature');
    if (thinking == null || thinkingSignature == null) return null;
    return { type, thinking, thinkingSignature };
  }

  if (type === 'toolCall') {
    const id = readString(value, 'id');
    const name = readString(value, 'name');
    const argumentsValue = value.arguments;
    const partialJson = readString(value, 'partialJson');
    if (id == null || name == null || !isRecord(argumentsValue) || partialJson == null) return null;
    return { type, id, name, arguments: argumentsValue, partialJson };
  }

  return { ...value, type };
}

function parseOpenAiCodexTextContentPart(value: unknown): OpenAiCodexTextContentPart | null {
  const part = parseOpenAiCodexContentPart(value);
  if (!part || part.type !== 'text' || !('text' in part) || typeof part.text !== 'string') return null;

  return {
    type: 'text',
    text: part.text,
    ...(typeof part.textSignature === 'string' ? { textSignature: part.textSignature } : {}),
  };
}

function parseOpenAiCodexUsage(value: unknown): OpenAiCodexUsage | null {
  if (!isRecord(value)) return null;
  const input = readNumber(value, 'input');
  const output = readNumber(value, 'output');
  const cacheRead = readNumber(value, 'cacheRead');
  const cacheWrite = readNumber(value, 'cacheWrite');
  const totalTokens = readNumber(value, 'totalTokens');
  const cost = value.cost;

  if (
    input == null ||
    output == null ||
    cacheRead == null ||
    cacheWrite == null ||
    totalTokens == null ||
    !isRecord(cost)
  ) {
    return null;
  }

  const costInput = readNumber(cost, 'input');
  const costOutput = readNumber(cost, 'output');
  const costCacheRead = readNumber(cost, 'cacheRead');
  const costCacheWrite = readNumber(cost, 'cacheWrite');
  const costTotal = readNumber(cost, 'total');
  if (costInput == null || costOutput == null || costCacheRead == null || costCacheWrite == null || costTotal == null) {
    return null;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  };
}

function parseOpenAiCodexMessage(value: unknown): OpenAiCodexMessage | null {
  if (!isRecord(value)) return null;
  const role = readString(value, 'role');

  if (role === 'user') {
    const content = value.content;
    const timestamp = readNumber(value, 'timestamp');
    if (!Array.isArray(content) || timestamp == null) return null;

    const parsedContent = content.map((part) => parseOpenAiCodexTextContentPart(part));
    if (parsedContent.some((part) => part == null)) return null;

    return {
      role,
      content: parsedContent as OpenAiCodexTextContentPart[],
      timestamp,
    };
  }

  if (role === 'assistant') {
    const content = value.content;
    const api = readString(value, 'api');
    const provider = readString(value, 'provider');
    const model = readString(value, 'model');
    const usage = parseOpenAiCodexUsage(value.usage);
    const stopReason = readString(value, 'stopReason');
    const timestamp = readNumber(value, 'timestamp');
    const responseId = readString(value, 'responseId');

    if (
      !Array.isArray(content) ||
      api == null ||
      provider == null ||
      model == null ||
      usage == null ||
      stopReason == null ||
      timestamp == null ||
      responseId == null
    ) {
      return null;
    }

    const parsedContent = content.map((part) => parseOpenAiCodexContentPart(part));
    if (parsedContent.some((part) => part == null)) return null;

    const errorMessage = readOptionalString(value, 'errorMessage');
    return {
      role,
      content: parsedContent as OpenAiCodexMessageContentPart[],
      api,
      provider,
      model,
      usage,
      stopReason,
      timestamp,
      responseId,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  if (role === 'toolResult') {
    const toolCallId = readString(value, 'toolCallId');
    const toolName = readString(value, 'toolName');
    const content = value.content;
    const isError = readBoolean(value, 'isError');
    const timestamp = readNumber(value, 'timestamp');
    if (!Array.isArray(content) || toolCallId == null || toolName == null || isError == null || timestamp == null) {
      return null;
    }

    const parsedContent = content.map((part) => parseOpenAiCodexTextContentPart(part));
    if (parsedContent.some((part) => part == null)) return null;

    return {
      role,
      toolCallId,
      toolName,
      content: parsedContent as OpenAiCodexTextContentPart[],
      isError,
      timestamp,
    };
  }

  return null;
}

function parseOpenAiCodexEvent(value: unknown): OpenAiCodexJsonlEvent | null {
  if (!isRecord(value)) return null;
  const type = readString(value, 'type');

  if (type === 'session') {
    const version = readNumber(value, 'version');
    const id = readString(value, 'id');
    const timestamp = readString(value, 'timestamp');
    const cwd = readString(value, 'cwd');
    const parentSession = readOptionalString(value, 'parentSession');
    if (version == null || id == null || timestamp == null || cwd == null) return null;

    return {
      type,
      version,
      id,
      timestamp,
      cwd,
      ...(parentSession !== undefined ? { parentSession } : {}),
    };
  }

  if (type === 'model_change') {
    const id = readString(value, 'id');
    const parentId = readNullableString(value, 'parentId');
    const timestamp = readString(value, 'timestamp');
    const provider = readString(value, 'provider');
    const modelId = readString(value, 'modelId');
    if (id == null || parentId === undefined || timestamp == null || provider == null || modelId == null) return null;
    return { type, id, parentId, timestamp, provider, modelId };
  }

  if (type === 'thinking_level_change') {
    const id = readString(value, 'id');
    const parentId = readNullableString(value, 'parentId');
    const timestamp = readString(value, 'timestamp');
    const thinkingLevel = readString(value, 'thinkingLevel');
    if (id == null || parentId === undefined || timestamp == null || thinkingLevel == null) return null;
    return { type, id, parentId, timestamp, thinkingLevel };
  }

  if (type === 'message') {
    const id = readString(value, 'id');
    const parentId = readNullableString(value, 'parentId');
    const timestamp = readString(value, 'timestamp');
    const message = parseOpenAiCodexMessage(value.message);
    if (id == null || parentId === undefined || timestamp == null || message == null) return null;
    return { type, id, parentId, timestamp, message };
  }

  if (type === 'compaction') {
    const id = readString(value, 'id');
    const parentId = readNullableString(value, 'parentId');
    const timestamp = readString(value, 'timestamp');
    const summary = readString(value, 'summary');
    if (id == null || parentId === undefined || timestamp == null || summary == null) return null;

    const firstKeptEntryId = readOptionalString(value, 'firstKeptEntryId');
    const tokensBefore = readOptionalNumber(value, 'tokensBefore');
    const fromHook = readOptionalBoolean(value, 'fromHook');
    return {
      type,
      id,
      parentId,
      timestamp,
      summary,
      ...(firstKeptEntryId !== undefined ? { firstKeptEntryId } : {}),
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      ...('details' in value ? { details: value.details } : {}),
      ...(fromHook !== undefined ? { fromHook } : {}),
    };
  }

  if (type === 'custom') {
    const id = readString(value, 'id');
    const parentId = readNullableString(value, 'parentId');
    const timestamp = readString(value, 'timestamp');
    const customType = readString(value, 'customType');
    if (id == null || parentId === undefined || timestamp == null || customType == null || !('data' in value)) {
      return null;
    }
    return { type, id, parentId, timestamp, customType, data: value.data };
  }

  if (type === 'session_info') {
    const id = readString(value, 'id');
    const parentId = readNullableString(value, 'parentId');
    const timestamp = readString(value, 'timestamp');
    const name = readString(value, 'name');
    if (id == null || parentId === undefined || timestamp == null || name == null) return null;
    return { type, id, parentId, timestamp, name };
  }

  if (type === 'custom_message') {
    const id = readString(value, 'id');
    const parentId = readNullableString(value, 'parentId');
    const timestamp = readString(value, 'timestamp');
    const customType = readString(value, 'customType');
    if (id == null || parentId === undefined || timestamp == null || customType == null || !('content' in value)) {
      return null;
    }

    const display = readOptionalBoolean(value, 'display');
    return {
      type,
      id,
      parentId,
      timestamp,
      customType,
      content: value.content,
      ...(display !== undefined ? { display } : {}),
      ...('details' in value ? { details: value.details } : {}),
    };
  }

  if (type === 'label') {
    const id = readString(value, 'id');
    const parentId = readNullableString(value, 'parentId');
    const timestamp = readString(value, 'timestamp');
    const targetId = readString(value, 'targetId');
    const label = readOptionalString(value, 'label');
    if (id == null || parentId === undefined || timestamp == null || targetId == null) return null;

    return {
      type,
      id,
      parentId,
      timestamp,
      targetId,
      ...(label !== undefined ? { label } : {}),
    };
  }

  if (type === 'branch_summary') {
    const id = readString(value, 'id');
    const parentId = readNullableString(value, 'parentId');
    const timestamp = readString(value, 'timestamp');
    const fromId = readString(value, 'fromId');
    const summary = readString(value, 'summary');
    if (id == null || parentId === undefined || timestamp == null || fromId == null || summary == null) return null;

    const fromHook = readOptionalBoolean(value, 'fromHook');
    return {
      type,
      id,
      parentId,
      timestamp,
      fromId,
      summary,
      ...('details' in value ? { details: value.details } : {}),
      ...(fromHook !== undefined ? { fromHook } : {}),
    };
  }

  return null;
}

function summarizeOpenAiTextParts(parts: OpenAiCodexTextContentPart[]): string | undefined {
  return summarizeText(parts.map((part) => part.text).join('\n'));
}

function summarizeOpenAiCodexEvent(event: OpenAiCodexJsonlEvent): string | undefined {
  if (event.type === 'session') return summarizeText(event.cwd);
  if (event.type === 'model_change') return `${event.provider}/${event.modelId}`;
  if (event.type === 'thinking_level_change') return event.thinkingLevel;
  if (event.type === 'compaction' || event.type === 'branch_summary') return summarizeText(event.summary);
  if (event.type === 'session_info') return summarizeText(event.name) ?? '(cleared)';
  if (event.type === 'custom') return summarizeUnknownValue(event.data) ?? event.customType;
  if (event.type === 'custom_message') return summarizeUnknownValue(event.content) ?? event.customType;
  if (event.type === 'label') {
    return event.label ? `${event.targetId} -> ${event.label}` : `${event.targetId} -> (cleared)`;
  }

  if (event.message.role === 'user') return summarizeOpenAiTextParts(event.message.content);
  if (event.message.role === 'toolResult') {
    const resultSummary = summarizeOpenAiTextParts(event.message.content);
    const prefix = event.message.isError ? `${event.message.toolName} error` : event.message.toolName;
    return resultSummary ? `${prefix} · ${resultSummary}` : prefix;
  }

  const toolNames = event.message.content
    .filter((part): part is OpenAiCodexToolCallContentPart => part.type === 'toolCall')
    .map((part) => part.name);
  const textSummary = summarizeText(
    event.message.content
      .filter((part): part is OpenAiCodexTextContentPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n'),
  );
  if (toolNames.length > 0 && textSummary) return `${toolNames.join(', ')} · ${textSummary}`;
  if (toolNames.length > 0) return toolNames.join(', ');
  return textSummary ?? event.message.stopReason;
}

function describeOpenAiCodexEvent(event: OpenAiCodexJsonlEvent): string {
  if (event.type === 'model_change') return `${event.type} · ${event.modelId}`;
  if (event.type === 'thinking_level_change') return `${event.type} · ${event.thinkingLevel}`;
  if (event.type === 'custom' || event.type === 'custom_message') return `${event.type} · ${event.customType}`;
  if (event.type === 'message') {
    if (event.message.role === 'assistant') return `${event.type} · assistant`;
    if (event.message.role === 'toolResult') return `${event.type} · toolResult`;
    return `${event.type} · user`;
  }
  return event.type;
}

function buildOpenAiResolvedLabels(entries: ParsedSyncedJsonlEntry<OpenAiCodexJsonlEvent>[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.value.type !== 'label') continue;
    const nextLabel = entry.value.label?.trim();
    if (nextLabel) labels.set(entry.value.targetId, nextLabel);
    else labels.delete(entry.value.targetId);
  }
  return labels;
}

export function parseOpenAiCodexJsonl(
  parsedLines: ParsedJsonlLine[],
  skippedLineNumbers: number[],
): ParsedOpenAiCodexJsonl | null {
  const openAiEntries = parsedLines.map((line) => {
    const value = parseOpenAiCodexEvent(line.value);
    if (value == null) return null;

    return {
      lineNumber: line.lineNumber,
      raw: line.raw,
      type: value.type,
      label: describeOpenAiCodexEvent(value),
      summary: summarizeOpenAiCodexEvent(value),
      value,
    } satisfies ParsedSyncedJsonlEntry<OpenAiCodexJsonlEvent>;
  });
  if (!openAiEntries.every((entry) => entry != null)) return null;

  const normalizedEntries = openAiEntries as ParsedSyncedJsonlEntry<OpenAiCodexJsonlEvent>[];
  return {
    kind: 'openai-codex',
    label: 'OpenAI Codex',
    entries: normalizedEntries,
    tree: buildParsedTree(
      normalizedEntries,
      (entry) => {
        if (entry.value.type === 'session') return null;
        return {
          id: entry.value.id,
          parentId: entry.value.parentId,
          timestamp: entry.value.timestamp,
        };
      },
      buildOpenAiResolvedLabels(normalizedEntries),
    ),
    skippedLineCount: skippedLineNumbers.length,
    skippedLineNumbers,
  };
}
