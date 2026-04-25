import { useCallback, useMemo } from 'preact/hooks';
import { buildClaudeSessionTreeRows, getDefaultClaudeSessionLeafId, parseClaudeSessionJsonl } from '../claude_session';
import {
  type SessionTranscriptFilterMode,
  type SessionTranscriptTreeRow,
  SessionTranscriptTreeView,
} from './SessionTranscriptTreeView';

interface ClaudeSessionTreeViewProps {
  content: string;
  fileName: string;
  onBack?: () => void;
  onContinue?: (sessionId: string) => void;
  claudeCredentialAvailable?: boolean | null;
}

export function ClaudeSessionTreeView({
  content,
  fileName,
  onBack,
  onContinue,
  claudeCredentialAvailable = null,
}: ClaudeSessionTreeViewProps) {
  const parsed = useMemo(() => parseClaudeSessionJsonl(content), [content]);
  const defaultLeafId = useMemo(() => getDefaultClaudeSessionLeafId(parsed.entries), [parsed.entries]);
  const sessionIdentity = `${fileName}:${parsed.sessionId ?? 'raw'}:${defaultLeafId ?? ''}`;
  const buildRows = useCallback(
    (options: {
      currentLeafId: string | null;
      selectedEntryId: string | null;
      filterMode: SessionTranscriptFilterMode;
      foldedIds: ReadonlySet<string>;
    }): SessionTranscriptTreeRow[] =>
      buildClaudeSessionTreeRows({
        entries: parsed.entries,
        currentLeafId: options.currentLeafId,
        selectedEntryId: options.selectedEntryId,
        filterMode: options.filterMode,
        foldedIds: options.foldedIds,
      }),
    [parsed.entries],
  );

  return (
    <SessionTranscriptTreeView
      agentName="Claude"
      continueAction={{
        credentialAvailable: claudeCredentialAvailable,
        onContinue: parsed.sessionId && onContinue ? () => onContinue(parsed.sessionId as string) : undefined,
      }}
      content={content}
      fileName={fileName}
      isValid={parsed.entries.length > 0}
      invalidMessage="This does not look like a Claude transcript. Showing raw JSONL."
      parseErrors={parsed.parseErrors}
      defaultLeafId={defaultLeafId}
      sessionIdentity={sessionIdentity}
      buildRows={buildRows}
      onBack={onBack}
    />
  );
}
