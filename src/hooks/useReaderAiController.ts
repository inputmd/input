import { useCallback, useEffect, useMemo, useRef } from 'preact/hooks';
import type { ReaderAiMessage } from '../components/ReaderAiPanel';
import { stripCriticMarkupComments } from '../criticmarkup.ts';
import type { ReaderAiModel } from '../reader_ai';
import { trimReaderAiSource } from '../reader_ai_context';
import { buildReaderAiRetryRequestForStep } from '../reader_ai_controller_runtime';
import { READER_AI_SELECTION_MAX_CHARS } from '../reader_ai_limits';
import {
  buildReaderAiHistoryDocumentKey,
  type ReaderAiConversationScope,
  type ReaderAiEditorCheckpoint,
  useReaderAiSession,
} from './useReaderAiSession';

interface UseReaderAiControllerOptions {
  activeView: string;
  currentEditingDocPath: string | null;
  currentFileName: string | null;
  currentRepoDocPath: string | null;
  getCurrentEditContent: () => string;
  getSelectionSource: (maxChars: number) => string | null;
  historyEligible: boolean;
  historyDocumentKey: string | null;
  inlinePromptAbortRef: { current: AbortController | null };
  readerAiModels: ReaderAiModel[];
  readerAiSelectedModel: string;
  readerAiSource: string;
  resetInlinePromptState: () => void;
  selectedReaderAiModel: ReaderAiModel | null;
  showFailureToast: (message: string) => void;
}

export { buildReaderAiHistoryDocumentKey, type ReaderAiConversationScope, type ReaderAiEditorCheckpoint };

export function useReaderAiController(options: UseReaderAiControllerOptions) {
  const session = useReaderAiSession({
    historyEligible: options.historyEligible,
    historyDocumentKey: options.historyDocumentKey,
    resetInlinePromptState: options.resetInlinePromptState,
    inlinePromptAbortRef: options.inlinePromptAbortRef,
  });

  const readerAiMessagesRef = useRef<ReaderAiMessage[]>(session.readerAiMessages);

  useEffect(() => {
    readerAiMessagesRef.current = session.readerAiMessages;
  }, [session.readerAiMessages]);

  const streamReaderAiAssistant = useCallback(
    async (
      baseMessages: ReaderAiMessage[],
      streamOptions?: { edited?: boolean; modelId?: string | null; parentRunId?: string | null; retryStepId?: string },
    ) => {
      const modelId = streamOptions?.modelId ?? options.readerAiSelectedModel;
      if (!modelId) return false;
      const allowDocumentEdits = options.activeView === 'edit';
      const currentEditContent = options.getCurrentEditContent();
      const documentSource = trimReaderAiSource(
        stripCriticMarkupComments(allowDocumentEdits ? currentEditContent : options.readerAiSource),
      );
      const selectionSource = allowDocumentEdits ? options.getSelectionSource(READER_AI_SELECTION_MAX_CHARS) : null;
      const currentDocPath = allowDocumentEdits
        ? options.currentEditingDocPath
        : (options.currentRepoDocPath ?? options.currentFileName);
      const selectedModel =
        options.readerAiModels.find((model) => model.id === modelId) ??
        (modelId === options.readerAiSelectedModel ? options.selectedReaderAiModel : null);
      return session.startReaderAiStream({
        allowDocumentEdits,
        baseMessages,
        currentDocPath,
        documentSource,
        edited: streamOptions?.edited,
        modelId,
        parentRunId: streamOptions?.parentRunId ?? undefined,
        retryStepId: streamOptions?.retryStepId ?? undefined,
        selectedModel,
        selectionSource,
        showFailureToast: options.showFailureToast,
      });
    },
    [
      options.activeView,
      options.currentEditingDocPath,
      options.currentFileName,
      options.currentRepoDocPath,
      options.getCurrentEditContent,
      options.getSelectionSource,
      options.readerAiModels,
      options.readerAiSelectedModel,
      options.readerAiSource,
      options.selectedReaderAiModel,
      options.showFailureToast,
      session,
    ],
  );

  const onReaderAiSend = useCallback(
    async (prompt: string) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) return true;
      return streamReaderAiAssistant([...readerAiMessagesRef.current, { role: 'user', content: trimmedPrompt }]);
    },
    [streamReaderAiAssistant],
  );

  const onReaderAiEditMessage = useCallback(
    async (index: number, nextContent: string) => {
      const trimmedContent = nextContent.trim();
      if (!trimmedContent) return false;
      const currentMessages = readerAiMessagesRef.current;
      if (index < 0 || index >= currentMessages.length) return false;
      const target = currentMessages[index];
      if (!target || target.role !== 'user') return false;
      const updated =
        target.content === trimmedContent
          ? currentMessages.slice(0, index + 1)
          : currentMessages
              .slice(0, index + 1)
              .map((message, messageIndex) =>
                messageIndex === index ? { ...message, content: trimmedContent, edited: false } : message,
              );
      void streamReaderAiAssistant(updated, { edited: true });
      return true;
    },
    [streamReaderAiAssistant],
  );

  const onReaderAiRetryLastMessage = useCallback(async () => {
    if (session.readerAiSending) return;
    const currentMessages = readerAiMessagesRef.current;
    if (currentMessages.length === 0) return;
    let lastUserIndex = -1;
    for (let index = currentMessages.length - 1; index >= 0; index -= 1) {
      if (currentMessages[index].role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex === -1) return;
    const retryRequest = session.buildReaderAiRetryRequest();
    const messagesToReplay = retryRequest?.baseMessages.length
      ? retryRequest.baseMessages
      : currentMessages.slice(0, lastUserIndex + 1);
    await streamReaderAiAssistant(messagesToReplay, {
      modelId: retryRequest?.modelId ?? options.readerAiSelectedModel,
      parentRunId: retryRequest?.parentRunId ?? null,
      retryStepId: retryRequest?.retryStepId,
    });
  }, [options.readerAiSelectedModel, session, streamReaderAiAssistant]);

  const onReaderAiResetToMessage = useCallback(
    async (index: number) => {
      if (session.readerAiSending) return;
      const currentMessages = readerAiMessagesRef.current;
      if (index < 0 || index >= currentMessages.length) return;
      const target = currentMessages[index];
      if (!target || target.role !== 'user') return;
      session.rewindReaderAiConversation(currentMessages.slice(0, index));
      return target.content;
    },
    [session],
  );

  const onReaderAiRetryRunStep = useCallback(
    async ({ runId, stepId }: { runId: string; stepId: string }) => {
      if (session.readerAiSending) return;
      const retryRequest = buildReaderAiRetryRequestForStep(session.readerAiRuns, { runId, stepId });
      if (!retryRequest) return;
      await streamReaderAiAssistant(retryRequest.baseMessages, {
        modelId: retryRequest.modelId ?? options.readerAiSelectedModel,
        parentRunId: retryRequest.parentRunId ?? null,
        retryStepId: retryRequest.retryStepId,
      });
    },
    [options.readerAiSelectedModel, session.readerAiRuns, session.readerAiSending, streamReaderAiAssistant],
  );

  return useMemo(
    () => ({
      ...session,
      onReaderAiClear: session.clearReaderAi,
      onReaderAiEditMessage,
      onReaderAiResetToMessage,
      onReaderAiRetryLastMessage,
      onReaderAiRetryRunStep,
      onReaderAiSend,
      onReaderAiStop: session.stopReaderAi,
      streamReaderAiAssistant,
    }),
    [
      onReaderAiEditMessage,
      onReaderAiResetToMessage,
      onReaderAiRetryLastMessage,
      onReaderAiRetryRunStep,
      onReaderAiSend,
      session,
      streamReaderAiAssistant,
    ],
  );
}
