// ── Reader AI System Prompt Builders ──

import { READER_AI_DOC_PREVIEW_CHARS } from './tools.ts';

export function buildReaderAiSystemPrompt(
  source: string,
  lines: string[],
  maxPreviewChars: number,
  currentDocPath?: string | null,
  allowDocumentEdits = true,
): string {
  const totalLines = lines.length;
  const totalChars = source.length;

  let docSection: string;
  if (totalChars <= maxPreviewChars) {
    const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
    docSection = `The full document is included below (${totalLines} lines). You already have the complete text — do not call read_document unless the user asks you to re-examine specific line ranges.\n\n<document>\n${numbered}\n</document>`;
  } else {
    let previewEnd = 0;
    let previewChars = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLen = `${i + 1}: ${lines[i]}\n`.length;
      if (previewChars + lineLen > maxPreviewChars && i > 0) break;
      previewChars += lineLen;
      previewEnd = i + 1;
    }
    const preview = lines
      .slice(0, previewEnd)
      .map((line, i) => `${i + 1}: ${line}`)
      .join('\n');
    docSection = `A preview of the document is included below (first ${previewEnd} of ${totalLines} lines). Use the read_document and search_document tools for full access.\n\n<document-preview>\n${preview}\n</document-preview>`;
  }

  const toolLines = [
    '- read_document: Read all or part of the document by line range. Returns numbered lines.',
    '- search_document: Search for text in the document (case-insensitive). Returns matching lines with context.',
    ...(allowDocumentEdits
      ? [
          '- propose_edit_document: Propose an edit to the current document. Use this whenever you want to change the document so the user can explicitly approve or reject the proposal.',
        ]
      : []),
    '- task: Spawn an independent subagent with its own system prompt and fresh context. The subagent can read and search the document but cannot spawn further subagents. Avoid this by default. Use it only when the user explicitly asks for a subagent-style workflow, a skill/instruction explicitly requires one, or a distinct specialized role is clearly necessary. Multiple task calls in the same response run concurrently. Each subagent returns its complete output as the tool result.',
  ];
  const guidelineLines = [
    '- For specific questions, use search_document to find relevant sections.',
    '- Cite line numbers when referencing specific parts.',
    '- If the document content already visible contains the answer, respond directly without tools.',
    ...(allowDocumentEdits
      ? [
          '- To suggest or make any document change, call propose_edit_document instead of describing the edit in text.',
          '- Before any propose_edit_document call, first call read_document for the exact affected span. The read result tells you whether you are looking at the original or staged document and whether a proposal is already pending. Use the latest read_document result as the only source for old_text or expected_old_text; do not copy edit text from memory, search_document, or earlier narration.',
          '- For paragraph or sentence edits, prefer exact-text replacement with old_text copied directly from the latest read_document result. Use start_line/end_line only after re-reading the relevant lines and only for a single contiguous block you have just verified.',
          '- For paragraph or block removals, first call read_document for the exact affected span, then make exactly one propose_edit_document call that replaces the full span atomically, then stop. Splitting an intended edit into multiple delete/fix proposals WILL NOT WORK because of line number drift.',
          '- After each propose_edit_document call, treat the tool result and its document_state summary as the source of truth. Do not describe edit outcomes from memory. If there is any doubt, re-read the document before proposing another edit.',
          '- If a proposal is wrong, do not patch the previous proposal incrementally. Recompute the next proposal from the user intent and the current staged document state.',
          '- If you must use a line-range edit, include expected_old_text from the fresh read and set dry_run explicitly to true or false so the intent is unambiguous.',
        ]
      : [
          '- This chat is read-only while the user is viewing the document. Do not call edit tools or present edits as pending actions.',
          '- If the user asks you to change, rewrite, fix, or edit the document, tell them to switch to edit mode and make the request there.',
        ]),
    '- Prefer making the proposal yourself instead of asking a subagent to do it.',
    '- If the document lacks the answer, say so plainly.',
    '- Do not use markdown tables in responses; use short headings and bullet lists instead.',
    '- Do not use the task tool unless the user explicitly asks for it, a skill/instruction explicitly requires it, or a distinct specialized role is clearly necessary.',
    '- You can only see the current document. If the user asks about other files or the broader project, say that this chat only has document access.',
  ];

  return [
    'You are a helpful assistant that answers questions about a document.',
    '',
    'You have tools available:',
    ...toolLines,
    '',
    'Guidelines:',
    ...guidelineLines,
    '',
    ...(currentDocPath ? [`Current document path: ${currentDocPath}`, ''] : []),
    `Document info: ${totalLines} lines, ${totalChars} characters.`,
    '',
    docSection,
  ].join('\n');
}

export function buildReaderAiPromptListSystemPrompt(): string {
  return [
    'You are continuing an inline AI conversation embedded inside a document.',
    'Prioritize coherence with the conversation thread over broad document analysis.',
    '',
    'Use the thread history as the primary context for your answer.',
    'You do not have document context for this turn.',
    'If the answer depends on document details that are not in the thread, say what is missing instead of guessing.',
    'Respond in plain text. Keep the answer concise but allow short paragraphs when they help.',
    'Do not output tables.',
    'Avoid markdown-heavy formatting unless the user explicitly asks for it.',
  ].join('\n');
}

export { READER_AI_DOC_PREVIEW_CHARS };
