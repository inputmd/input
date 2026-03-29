// ── Reader AI Session ──

import { runReaderAiLoop } from './loop.ts';
import type { ReaderAiChatOptions, ReaderAiEvent, ReaderAiMessage, ReaderAiSessionConfig } from './types.ts';

export class ReaderAiSession {
  readonly config: ReaderAiSessionConfig;

  constructor(config: ReaderAiSessionConfig) {
    this.config = config;
  }

  /**
   * Run a chat turn against the document.
   * Returns an async generator that yields events as they occur.
   */
  chat(messages: ReaderAiMessage[], options: ReaderAiChatOptions = {}): AsyncGenerator<ReaderAiEvent> {
    return runReaderAiLoop(this.config, messages, options);
  }
}

/** Create a new Reader AI session. */
export function createReaderAiSession(config: ReaderAiSessionConfig): ReaderAiSession {
  return new ReaderAiSession(config);
}
