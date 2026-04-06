import type { ReaderAiMessage } from './components/ReaderAiPanel';
import type { ReaderAiEditProposal, ReaderAiStagedChange } from './reader_ai';
import type { ReaderAiStepErrorCode } from './reader_ai_errors';

export type ReaderAiTranscriptItem =
  | {
      id: string;
      kind: 'user_message';
      messageIndex: number;
      content: string;
      edited?: boolean;
    }
  | {
      id: string;
      kind: 'assistant_turn';
      runId?: string;
      iteration?: number;
      content: string;
      edited?: boolean;
      status: 'streaming' | 'completed' | 'aborted' | 'failed';
    }
  | {
      id: string;
      kind: 'tool_call';
      runId?: string;
      iteration?: number;
      toolCallId: string;
      name: string;
      argumentsJson?: string;
      detail?: string;
      taskId?: string;
    }
  | {
      id: string;
      kind: 'tool_result';
      runId?: string;
      iteration?: number;
      toolCallId: string;
      name: string;
      preview?: string;
      error?: string;
      errorCode?: ReaderAiStepErrorCode;
      taskId?: string;
    }
  | {
      id: string;
      kind: 'task_progress';
      runId?: string;
      iteration?: number;
      taskId: string;
      phase: 'started' | 'iteration_start' | 'tool_call' | 'tool_result' | 'completed' | 'error';
      detail?: string;
    }
  | {
      id: string;
      kind: 'edit_proposal';
      runId?: string;
      iteration?: number;
      proposal: ReaderAiEditProposal;
    }
  | {
      id: string;
      kind: 'staged_changes_snapshot';
      runId?: string;
      iteration?: number;
      changes: ReaderAiStagedChange[];
    }
  | {
      id: string;
      kind: 'change_set_decision';
      runId?: string;
      iteration?: number;
      action: 'applied' | 'discarded' | 'restored_to_staging';
      changes: ReaderAiStagedChange[];
      selectedChangeIds?: string[];
      selectedHunkIdsByChangeId?: Record<string, string[]>;
      stagedFileContents?: Record<string, string>;
      documentEditedContent?: string | null;
    }
  | {
      id: string;
      kind: 'editor_checkpoint_event';
      path: string;
      checkpointId?: string;
      action: 'applied' | 'restored' | 'reapplied';
    }
  | {
      id: string;
      kind: 'error';
      runId?: string;
      iteration?: number;
      message: string;
    };

interface ReaderAiTranscriptMessageDescriptor {
  itemIndex: number;
  message: ReaderAiMessage;
}

export function createReaderAiTranscriptId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `transcript:${prefix}:${crypto.randomUUID()}`;
  }
  return `transcript:${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export function isReaderAiTranscriptMessageItem(
  item: ReaderAiTranscriptItem,
): item is Extract<ReaderAiTranscriptItem, { kind: 'user_message' | 'assistant_turn' }> {
  return item.kind === 'user_message' || item.kind === 'assistant_turn';
}

function transcriptMessageDescriptors(transcript: ReaderAiTranscriptItem[]): ReaderAiTranscriptMessageDescriptor[] {
  const descriptors: ReaderAiTranscriptMessageDescriptor[] = [];
  transcript.forEach((item, itemIndex) => {
    if (!isReaderAiTranscriptMessageItem(item)) return;
    descriptors.push({
      itemIndex,
      message:
        item.kind === 'user_message'
          ? { role: 'user', content: item.content, ...(item.edited ? { edited: true } : {}) }
          : { role: 'assistant', content: item.content, ...(item.edited ? { edited: true } : {}) },
    });
  });
  return descriptors;
}

function readerAiMessagesEqual(a: ReaderAiMessage, b: ReaderAiMessage): boolean {
  return a.role === b.role && a.content === b.content && Boolean(a.edited) === Boolean(b.edited);
}

function transcriptItemFromMessage(message: ReaderAiMessage, messageIndex: number): ReaderAiTranscriptItem {
  if (message.role === 'user') {
    return {
      id: createReaderAiTranscriptId('user'),
      kind: 'user_message',
      messageIndex,
      content: message.content,
      ...(message.edited ? { edited: true } : {}),
    };
  }
  return {
    id: createReaderAiTranscriptId('assistant'),
    kind: 'assistant_turn',
    content: message.content,
    ...(message.edited ? { edited: true } : {}),
    status: 'completed',
  };
}

export function buildReaderAiTranscriptFromMessages(messages: ReaderAiMessage[]): ReaderAiTranscriptItem[] {
  return messages.map((message, messageIndex) => transcriptItemFromMessage(message, messageIndex));
}

export function reconcileReaderAiTranscriptWithMessages(
  transcript: ReaderAiTranscriptItem[],
  messages: ReaderAiMessage[],
): ReaderAiTranscriptItem[] {
  const descriptors = transcriptMessageDescriptors(transcript);
  let matched = 0;
  let lastMatchedItemIndex = -1;

  while (matched < descriptors.length && matched < messages.length) {
    if (!readerAiMessagesEqual(descriptors[matched].message, messages[matched])) break;
    lastMatchedItemIndex = descriptors[matched].itemIndex;
    matched += 1;
  }

  const next = lastMatchedItemIndex >= 0 ? transcript.slice(0, lastMatchedItemIndex + 1) : [];
  for (let messageIndex = matched; messageIndex < messages.length; messageIndex += 1) {
    next.push(transcriptItemFromMessage(messages[messageIndex], messageIndex));
  }
  return next;
}
