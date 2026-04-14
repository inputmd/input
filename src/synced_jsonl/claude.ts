import {
  buildParsedTree,
  isRecord,
  readBoolean,
  readNullableString,
  readNumber,
  readOptionalString,
  readString,
  readStringArray,
  summarizeText,
  summarizeUnknownValue,
} from './shared.ts';
import type {
  ClaudeCodeAssistantContentPart,
  ClaudeCodeAssistantUsage,
  ClaudeCodeAttachment,
  ClaudeCodeConversationEnvelope,
  ClaudeCodeJsonlEvent,
  ClaudeCodeTextContentPart,
  ClaudeCodeToolResultContentPart,
  ClaudeCodeToolUseContentPart,
  ClaudeCodeUnknownConversationEvent,
  ClaudeCodeUnknownMetaEvent,
  ClaudeCodeUserContentPart,
  ParsedClaudeCodeJsonl,
  ParsedJsonlLine,
  ParsedSyncedJsonlEntry,
} from './types.ts';

function parseClaudeCodeUserContentPart(value: unknown): ClaudeCodeUserContentPart | null {
  if (!isRecord(value)) return null;
  const type = readString(value, 'type');
  if (!type) return null;

  if (type === 'tool_result') {
    const toolUseId = readString(value, 'tool_use_id');
    const content = value.content;
    const isError = value.is_error;
    if (toolUseId == null || content === undefined) return null;
    if (isError !== undefined && typeof isError !== 'boolean') return null;

    return {
      type,
      tool_use_id: toolUseId,
      content,
      ...(typeof isError === 'boolean' ? { is_error: isError } : {}),
    };
  }

  return { ...value, type };
}

function parseClaudeCodeAssistantContentPart(value: unknown): ClaudeCodeAssistantContentPart | null {
  if (!isRecord(value)) return null;
  const type = readString(value, 'type');
  if (!type) return null;

  if (type === 'tool_use') {
    const id = readString(value, 'id');
    const name = readString(value, 'name');
    const input = value.input;
    const caller = value.caller;
    if (id == null || name == null || !isRecord(input) || !isRecord(caller)) return null;

    const callerType = readString(caller, 'type');
    if (callerType == null) return null;

    return {
      type,
      id,
      name,
      input,
      caller: {
        type: callerType,
      },
    };
  }

  if (type === 'text') {
    const text = readString(value, 'text');
    if (text == null) return null;
    return { type, text };
  }

  return { ...value, type };
}

function parseClaudeCodeAssistantUsage(value: unknown): ClaudeCodeAssistantUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = readNumber(value, 'input_tokens');
  const cacheCreationInputTokens = readNumber(value, 'cache_creation_input_tokens');
  const cacheReadInputTokens = readNumber(value, 'cache_read_input_tokens');
  const outputTokens = readNumber(value, 'output_tokens');
  const serverToolUse = value.server_tool_use;
  const serviceTier = readNullableString(value, 'service_tier');
  const cacheCreation = value.cache_creation;
  const inferenceGeo = readNullableString(value, 'inference_geo');
  const iterations = value.iterations;
  const speed = readNullableString(value, 'speed');

  if (
    inputTokens == null ||
    cacheCreationInputTokens == null ||
    cacheReadInputTokens == null ||
    outputTokens == null ||
    !isRecord(serverToolUse) ||
    !isRecord(cacheCreation) ||
    serviceTier === undefined ||
    inferenceGeo === undefined ||
    (iterations !== null && !Array.isArray(iterations)) ||
    speed === undefined
  ) {
    return null;
  }

  const webSearchRequests = readNumber(serverToolUse, 'web_search_requests');
  const webFetchRequests = readNumber(serverToolUse, 'web_fetch_requests');
  if (webSearchRequests == null || webFetchRequests == null) return null;

  const cacheCreationEntries = Object.entries(cacheCreation);
  if (!cacheCreationEntries.every(([, entryValue]) => typeof entryValue === 'number' && Number.isFinite(entryValue))) {
    return null;
  }

  return {
    input_tokens: inputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    output_tokens: outputTokens,
    server_tool_use: {
      web_search_requests: webSearchRequests,
      web_fetch_requests: webFetchRequests,
    },
    service_tier: serviceTier,
    cache_creation: Object.fromEntries(cacheCreationEntries as Array<[string, number]>),
    inference_geo: inferenceGeo,
    iterations: Array.isArray(iterations) ? [...iterations] : null,
    speed,
  };
}

function parseClaudeCodeConversationEnvelope(value: Record<string, unknown>): ClaudeCodeConversationEnvelope | null {
  const parentUuid = readNullableString(value, 'parentUuid');
  const isSidechain = readBoolean(value, 'isSidechain');
  const uuid = readString(value, 'uuid');
  const timestamp = readString(value, 'timestamp');
  const userType = readString(value, 'userType');
  const entrypoint = readString(value, 'entrypoint');
  const cwd = readString(value, 'cwd');
  const sessionId = readString(value, 'sessionId');
  const version = readString(value, 'version');
  const gitBranch = readString(value, 'gitBranch');

  if (
    parentUuid === undefined ||
    isSidechain == null ||
    uuid == null ||
    timestamp == null ||
    userType == null ||
    entrypoint == null ||
    cwd == null ||
    sessionId == null ||
    version == null ||
    gitBranch == null
  ) {
    return null;
  }

  const promptId = readOptionalString(value, 'promptId');
  const permissionMode = readOptionalString(value, 'permissionMode');
  const slug = readOptionalString(value, 'slug');
  return {
    parentUuid,
    isSidechain,
    uuid,
    timestamp,
    userType,
    entrypoint,
    cwd,
    sessionId,
    version,
    gitBranch,
    ...(promptId ? { promptId } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(slug ? { slug } : {}),
  };
}

function parseClaudeCodeAttachment(value: unknown): ClaudeCodeAttachment | null {
  if (!isRecord(value)) return null;
  const type = readString(value, 'type');
  if (!type) return null;

  if (type === 'deferred_tools_delta') {
    const addedNames = readStringArray(value, 'addedNames');
    const addedLines = readStringArray(value, 'addedLines');
    const removedNames = readStringArray(value, 'removedNames');
    if (addedNames == null || addedLines == null || removedNames == null) return null;
    return { type, addedNames, addedLines, removedNames };
  }

  if (type === 'skill_listing') {
    const content = readString(value, 'content');
    const skillCount = readNumber(value, 'skillCount');
    const isInitial = readBoolean(value, 'isInitial');
    if (content == null || skillCount == null || isInitial == null) return null;
    return { type, content, skillCount, isInitial };
  }

  return { ...value, type };
}

function parseClaudeCodeEvent(value: unknown): ClaudeCodeJsonlEvent | null {
  if (!isRecord(value)) return null;
  const type = readString(value, 'type');

  if (type === 'permission-mode') {
    const permissionMode = readString(value, 'permissionMode');
    const sessionId = readString(value, 'sessionId');
    if (permissionMode == null || sessionId == null) return null;
    return { type, permissionMode, sessionId };
  }

  if (type === 'file-history-snapshot') {
    const messageId = readString(value, 'messageId');
    const snapshotValue = value.snapshot;
    const isSnapshotUpdate = readBoolean(value, 'isSnapshotUpdate');
    if (messageId == null || !isRecord(snapshotValue) || isSnapshotUpdate == null) return null;

    const snapshotMessageId = readString(snapshotValue, 'messageId');
    const trackedFileBackups = snapshotValue.trackedFileBackups;
    const snapshotTimestamp = readString(snapshotValue, 'timestamp');
    if (snapshotMessageId == null || !isRecord(trackedFileBackups) || snapshotTimestamp == null) return null;

    return {
      type,
      messageId,
      snapshot: {
        messageId: snapshotMessageId,
        trackedFileBackups,
        timestamp: snapshotTimestamp,
      },
      isSnapshotUpdate,
    };
  }

  const envelope = parseClaudeCodeConversationEnvelope(value);
  if (envelope == null) return null;

  if (type === 'user') {
    const messageValue = value.message;
    if (!isRecord(messageValue) || readString(messageValue, 'role') !== 'user') return null;

    const content = messageValue.content;
    let parsedContent: string | ClaudeCodeUserContentPart[];
    if (typeof content === 'string') {
      parsedContent = content;
    } else if (Array.isArray(content)) {
      const parts = content.map((part) => parseClaudeCodeUserContentPart(part));
      if (parts.some((part) => part == null)) return null;
      parsedContent = parts as ClaudeCodeUserContentPart[];
    } else {
      return null;
    }

    const sourceToolAssistantUUID = readOptionalString(value, 'sourceToolAssistantUUID');
    return {
      ...envelope,
      type,
      message: {
        role: 'user',
        content: parsedContent,
      },
      ...(typeof value.isMeta === 'boolean' ? { isMeta: value.isMeta } : {}),
      ...(value.toolUseResult !== undefined ? { toolUseResult: value.toolUseResult } : {}),
      ...(sourceToolAssistantUUID ? { sourceToolAssistantUUID } : {}),
    };
  }

  if (type === 'assistant') {
    const requestId = readOptionalString(value, 'requestId');
    const messageValue = value.message;
    if (!isRecord(messageValue)) return null;

    const model = readString(messageValue, 'model');
    const id = readString(messageValue, 'id');
    const messageType = readString(messageValue, 'type');
    const role = readString(messageValue, 'role');
    const content = messageValue.content;
    const stopReason = readString(messageValue, 'stop_reason');
    const stopSequence = readNullableString(messageValue, 'stop_sequence');
    const usageValue = messageValue.usage;
    const usage = usageValue === undefined || usageValue === null ? null : parseClaudeCodeAssistantUsage(usageValue);
    if (
      model == null ||
      id == null ||
      messageType !== 'message' ||
      role !== 'assistant' ||
      !Array.isArray(content) ||
      stopReason == null ||
      stopSequence === undefined ||
      (usageValue !== undefined && usageValue !== null && usage == null)
    ) {
      return null;
    }

    const parsedContent = content.map((part) => parseClaudeCodeAssistantContentPart(part));
    if (parsedContent.some((part) => part == null)) return null;

    return {
      ...envelope,
      type,
      ...(requestId ? { requestId } : {}),
      message: {
        model,
        id,
        type: messageType,
        role,
        content: parsedContent as ClaudeCodeAssistantContentPart[],
        stop_reason: stopReason,
        stop_sequence: stopSequence,
        stop_details: messageValue.stop_details,
        usage,
      },
    };
  }

  if (type === 'attachment') {
    const attachment = parseClaudeCodeAttachment(value.attachment);
    if (attachment == null) return null;
    return {
      ...envelope,
      type,
      attachment,
    };
  }

  return null;
}

function parseClaudeCodeUnsupportedEvent(
  value: Record<string, unknown>,
): ClaudeCodeUnknownConversationEvent | ClaudeCodeUnknownMetaEvent | null {
  const type = readString(value, 'type');
  if (
    !type ||
    type === 'permission-mode' ||
    type === 'file-history-snapshot' ||
    type === 'user' ||
    type === 'assistant' ||
    type === 'attachment'
  ) {
    return null;
  }

  const envelope = parseClaudeCodeConversationEnvelope(value);
  if (envelope != null) {
    return {
      ...value,
      ...envelope,
      type,
      unsupported: true,
    };
  }

  const sessionId = readOptionalString(value, 'sessionId');
  const timestamp = readOptionalString(value, 'timestamp');
  const hasClaudeMetaShape =
    sessionId != null &&
    (timestamp != null ||
      readOptionalString(value, 'cwd') != null ||
      readOptionalString(value, 'entrypoint') != null ||
      readOptionalString(value, 'version') != null ||
      readOptionalString(value, 'gitBranch') != null ||
      readOptionalString(value, 'permissionMode') != null ||
      readOptionalString(value, 'messageId') != null);
  if (!hasClaudeMetaShape) return null;

  return {
    ...value,
    type,
    unsupported: true,
    ...(sessionId ? { sessionId } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}

function summarizeUnsupportedClaudeCodeEvent(
  event: ClaudeCodeUnknownConversationEvent | ClaudeCodeUnknownMetaEvent,
): string | undefined {
  const subtype = typeof event.subtype === 'string' ? event.subtype : undefined;
  const operation = typeof event.operation === 'string' ? event.operation : undefined;
  return summarizeUnknownValue(event) ?? subtype ?? operation;
}

function describeUnsupportedClaudeCodeEvent(
  event: ClaudeCodeUnknownConversationEvent | ClaudeCodeUnknownMetaEvent,
): string {
  const subtype = typeof event.subtype === 'string' ? event.subtype : undefined;
  const operation = typeof event.operation === 'string' ? event.operation : undefined;
  if (subtype) return `${event.type} · ${subtype}`;
  if (operation) return `${event.type} · ${operation}`;
  return event.type;
}

function isClaudeCodeConversationEvent(event: ClaudeCodeJsonlEvent): event is Exclude<
  ClaudeCodeJsonlEvent,
  { type: 'permission-mode' | 'file-history-snapshot' }
> & {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
} {
  return (
    'uuid' in event &&
    typeof event.uuid === 'string' &&
    'parentUuid' in event &&
    (typeof event.parentUuid === 'string' || event.parentUuid === null) &&
    typeof event.timestamp === 'string'
  );
}

function summarizeClaudeCodeEvent(event: ClaudeCodeJsonlEvent): string | undefined {
  if ('unsupported' in event) return summarizeUnsupportedClaudeCodeEvent(event);
  if (event.type === 'permission-mode') return event.permissionMode;
  if (event.type === 'file-history-snapshot') return event.isSnapshotUpdate ? 'update' : 'snapshot';

  if (event.type === 'attachment') {
    if (event.attachment.type === 'skill_listing') return `${event.attachment.skillCount} skills`;
    if (event.attachment.type === 'deferred_tools_delta' && Array.isArray(event.attachment.addedNames)) {
      return `+${event.attachment.addedNames.length} tools`;
    }
    return summarizeUnknownValue(event.attachment);
  }

  if (event.type === 'user') {
    if (typeof event.message.content === 'string') return summarizeText(event.message.content);
    const firstToolResult = event.message.content.find(
      (part): part is ClaudeCodeToolResultContentPart => part.type === 'tool_result',
    );
    if (firstToolResult) {
      const prefix = firstToolResult.is_error ? 'tool_result error' : 'tool_result';
      const summary =
        typeof firstToolResult.content === 'string'
          ? summarizeText(firstToolResult.content)
          : summarizeUnknownValue(firstToolResult.content);
      return summary ? `${prefix} · ${summary}` : prefix;
    }
    return summarizeUnknownValue(event.message.content);
  }

  const toolNames = event.message.content
    .filter((part): part is ClaudeCodeToolUseContentPart => part.type === 'tool_use')
    .map((part) => part.name);
  const textSummary = summarizeText(
    event.message.content
      .filter((part): part is ClaudeCodeTextContentPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n'),
  );
  if (toolNames.length > 0 && textSummary) return `${toolNames.join(', ')} · ${textSummary}`;
  if (toolNames.length > 0) return toolNames.join(', ');
  return textSummary ?? event.message.stop_reason;
}

function describeClaudeCodeEvent(event: ClaudeCodeJsonlEvent): string {
  if ('unsupported' in event) return describeUnsupportedClaudeCodeEvent(event);
  if (event.type === 'permission-mode') return `${event.type} · ${event.permissionMode}`;
  if (event.type === 'attachment') return `${event.type} · ${event.attachment.type}`;
  if (event.type === 'assistant') {
    const toolUseCount = event.message.content.filter((part) => part.type === 'tool_use').length;
    return toolUseCount > 0 ? `${event.type} · tool_use` : event.type;
  }
  return event.type;
}

export function parseClaudeCodeJsonl(
  parsedLines: ParsedJsonlLine[],
  skippedLineNumbers: number[],
): ParsedClaudeCodeJsonl | null {
  let hasUserEvent = false;
  let hasAssistantEvent = false;
  let unsupportedEventCount = 0;
  const claudeEntries = parsedLines.map((line) => {
    let value = parseClaudeCodeEvent(line.value);
    let isUnsupported = false;
    if (value == null) {
      value = parseClaudeCodeUnsupportedEvent(line.value);
      isUnsupported = value != null;
    }
    if (value == null) return null;
    if (value.type === 'user') hasUserEvent = true;
    if (value.type === 'assistant') hasAssistantEvent = true;
    if (isUnsupported) unsupportedEventCount += 1;

    return {
      lineNumber: line.lineNumber,
      raw: line.raw,
      type: value.type,
      label: describeClaudeCodeEvent(value),
      summary: summarizeClaudeCodeEvent(value),
      value,
    } satisfies ParsedSyncedJsonlEntry<ClaudeCodeJsonlEvent>;
  });
  if (!claudeEntries.every((entry) => entry != null)) return null;
  if (unsupportedEventCount > 0 && (!hasUserEvent || !hasAssistantEvent)) return null;

  const normalizedEntries = claudeEntries as ParsedSyncedJsonlEntry<ClaudeCodeJsonlEvent>[];
  return {
    kind: 'claude-code',
    label: 'Claude Code',
    entries: normalizedEntries,
    tree: buildParsedTree(normalizedEntries, (entry) => {
      if (!isClaudeCodeConversationEvent(entry.value)) return null;
      return {
        id: entry.value.uuid,
        parentId: entry.value.parentUuid,
        timestamp: entry.value.timestamp,
      };
    }),
    skippedLineCount: skippedLineNumbers.length,
    skippedLineNumbers,
  };
}
