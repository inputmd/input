import { ClientError } from '../errors';
import { OpenAIComposerProvider } from './providers/openai';
import type { ComposeResult } from './types';

const openaiProvider = new OpenAIComposerProvider();

export function composerCapabilities(): { requiresUserKey: true } {
  return { requiresUserKey: true };
}

export async function composeForRepo(
  repoFullName: string,
  branch: string,
  prompt: string,
  requestedModel: string | null,
  apiKey: string,
): Promise<ComposeResult> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) throw new ClientError('prompt is required', 400);
  if (trimmedPrompt.length > 20_000) throw new ClientError('prompt is too long', 400);

  return openaiProvider.compose({
    prompt: trimmedPrompt,
    repoFullName,
    branch,
    model: requestedModel ?? undefined,
    apiKey,
  });
}
