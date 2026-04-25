import { useCallback, useMemo } from 'preact/hooks';
import {
  buildPiSessionTreeRows,
  getDefaultPiSessionLeafId,
  type PiSessionFilterMode,
  parsePiSessionJsonl,
} from '../pi_session';
import {
  type SessionTranscriptFilterMode,
  type SessionTranscriptTreeRow,
  SessionTranscriptTreeView,
} from './SessionTranscriptTreeView';

interface PiSessionTreeViewProps {
  content: string;
  fileName: string;
  onBack?: () => void;
  onContinue?: (fileName: string) => void;
  piCredentialAvailable?: boolean | null;
}

export function PiSessionTreeView({
  content,
  fileName,
  onBack,
  onContinue,
  piCredentialAvailable = null,
}: PiSessionTreeViewProps) {
  const parsed = useMemo(() => parsePiSessionJsonl(content), [content]);
  const defaultLeafId = useMemo(() => getDefaultPiSessionLeafId(parsed.entries), [parsed.entries]);
  const sessionIdentity = `${fileName}:${parsed.header?.id ?? 'raw'}:${defaultLeafId ?? ''}`;
  const buildRows = useCallback(
    (options: {
      currentLeafId: string | null;
      selectedEntryId: string | null;
      filterMode: SessionTranscriptFilterMode;
      foldedIds: ReadonlySet<string>;
    }): SessionTranscriptTreeRow[] =>
      buildPiSessionTreeRows({
        entries: parsed.entries,
        currentLeafId: options.currentLeafId,
        selectedEntryId: options.selectedEntryId,
        filterMode: options.filterMode as PiSessionFilterMode,
        foldedIds: options.foldedIds,
      }),
    [parsed.entries],
  );

  return (
    <SessionTranscriptTreeView
      agentName="Pi"
      continueAction={{
        credentialAvailable: piCredentialAvailable,
        onContinue: onContinue ? () => onContinue(fileName) : undefined,
      }}
      content={content}
      fileName={fileName}
      isValid={parsed.header !== null}
      invalidMessage="This does not look like a Pi session. Showing raw JSONL."
      parseErrors={parsed.parseErrors}
      defaultLeafId={defaultLeafId}
      sessionIdentity={sessionIdentity}
      buildRows={buildRows}
      onBack={onBack}
    />
  );
}
