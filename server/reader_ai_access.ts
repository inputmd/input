export type ReaderAiModelAccessScope = 'free_only' | 'with_paid';

export function readerAiModelAccessScopeForAuthenticated(authenticated: boolean): ReaderAiModelAccessScope {
  return authenticated ? 'with_paid' : 'free_only';
}

export function getReaderAiModelSource(model: string, paidModelIds: ReadonlySet<string>): 'free' | 'paid' {
  return paidModelIds.has(model) ? 'paid' : 'free';
}

export function canAccessReaderAiModel(
  model: string,
  authenticated: boolean,
  paidModelIds: ReadonlySet<string>,
): boolean {
  return authenticated || getReaderAiModelSource(model, paidModelIds) === 'free';
}
