import type { ComposeResult, SandboxProviderId } from '../types';

export interface ComposeRequest {
  prompt: string;
  repoFullName: string;
  branch: string;
  model?: string;
  apiKey: string;
}

export interface ComposerProvider {
  id: SandboxProviderId;
  compose(input: ComposeRequest): Promise<ComposeResult>;
}
