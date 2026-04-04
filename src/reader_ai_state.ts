export type ReaderAiProposalToolCallStatus = 'accepted' | 'rejected' | 'ignored';

export type ReaderAiSelectedHunkIdsByChangeId = Record<string, Set<string>>;
