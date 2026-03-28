# Reader AI — Short-Term Architectural Roadmap

This document outlines improvements to bring the Reader AI sidebar closer to
parity with coding IDEs like Cursor, Windsurf, and Antigravity.

## Current State

The Reader AI sidebar works as a chat panel with tool-calling capabilities. It
can read documents, search, propose edits, and manage multi-file project
sessions. Key subsystems:

- **Server agent loop** (`server/routes.ts` → `handleReaderAiChat`): Streams
  text via SSE, runs an iterative tool-call loop against OpenRouter, and emits
  structured events (`tool_call`, `tool_result`, `staged_changes`, etc.).
- **Tool execution** (`server/reader_ai_tools.ts`): Defines tool schemas,
  executes tools synchronously (or spawns subagents for `task`), and manages
  `StagedChanges` for multi-file project edits.
- **Client stream consumer** (`src/reader_ai.ts` → `askReaderAiStream`):
  Parses SSE from the server and routes to callbacks.
- **UI** (`src/components/ReaderAiPanel.tsx`, `ReaderAiStagedChanges.tsx`,
  `ReaderAiToolLog.tsx`, `DiffViewer.tsx`): Renders messages, tool activity,
  and staged change diffs.
- **State orchestration** (`src/app.tsx` → `streamReaderAiAssistant`): Wires
  callbacks, manages React state for messages/tools/staged changes, and
  handles project session lifecycle.

## Roadmap Items

### 1. Per-Edit Inline Review (Accept / Reject per Hunk)

**Gap:** Edits are presented as a single "Staged changes" block. The user can
only accept or reject all changes at once.

**Target:** Each proposed edit (whether from `propose_edit_file` or
`propose_edit_document`) should appear as its own reviewable chunk in the chat
flow, immediately after the tool call that produced it. Each chunk should have
individual Accept / Reject / Edit buttons, like Cursor's inline diff cards.

**Implementation path:**

- Emit a new SSE event type (e.g., `edit_proposal`) from the server
  immediately after each edit tool call, carrying the specific diff, path, and
  an `edit_id`.
- In the client, render each proposal as an `EditProposalCard` component
  inline in the message stream (between tool log entries and assistant text).
- Track per-proposal accept/reject state. On "Apply", only send accepted
  proposals to `POST /api/ai/apply`.
- The current `StagedChangesSection` becomes a summary view that aggregates
  accepted proposals.

### 2. Streaming Diff Preview (Token-Level Edit Visualization)

**Gap:** Diffs only appear after the tool call completes and the full
arguments are available. There is no feedback while the LLM is generating
`old_text`/`new_text` arguments.

**Target:** Show a live preview of the edit as the LLM streams tool call
arguments, similar to how Cursor shows character-by-character changes.

**Implementation path:**

- On the server, emit incremental `tool_call_delta` events that forward the
  raw streaming `function.arguments` chunks for edit tools. The client can
  attempt partial JSON parse to extract `old_text`/`new_text` as they arrive.
- Build a `StreamingDiffPreview` component that takes partial `old_text` and
  `new_text`, locates `old_text` in the document, and renders an inline diff
  that updates on each delta.
- Fall back gracefully to the current behavior when partial parsing fails.

### 3. Multi-Turn Context Persistence (Server-Side Conversation State)

**Gap:** Each request sends the full message history from the client.
Tool call/result messages are not persisted in the client's message array —
the server rebuilds them on each turn of the agent loop but they're lost
between separate requests.

**Target:** The server should maintain conversation state across requests so
tool results, file reads, and prior edits remain in context without
re-sending everything.

**Implementation path:**

- Extend the project session (`readerAiProjectSessions`) to store the full
  `openRouterMessages` array and a conversation ID.
- Client sends only new user messages + conversation ID. Server appends to
  the stored messages and continues the tool loop.
- Add a `conversation_id` field to the chat API. Fall back to current
  behavior when absent.
- This also enables better context summarization (summarize tool
  call/result pairs, not just user/assistant text).

### 4. Optimistic Apply with Undo

**Gap:** Applying changes requires a round-trip to the server and a GitHub
API call. There is no way to undo after applying.

**Target:** Apply changes optimistically in the editor buffer immediately,
then persist to GitHub in the background. Provide an "Undo" action for a
short window after applying.

**Implementation path:**

- When the user clicks "Apply", immediately update the CodeMirror editor
  content with the staged file contents.
- Fire the `POST /api/ai/apply` call in the background.
- Store the pre-apply content so an "Undo" button can revert within ~10s.
- Show a toast notification with "Applied — Undo" instead of blocking the UI.

### 5. File-Aware Context Selection

**Gap:** In project mode, the entire file tree is included in the system
prompt. For large repos, this wastes context tokens on irrelevant files.

**Target:** Intelligently select which files to include in context based on
the user's question, the currently open file, and import/dependency graphs.

**Implementation path:**

- Build a lightweight dependency graph from import/require/include
  statements when loading project files.
- On each request, use a relevance scorer (BM25 or embedding-based) to
  rank files against the user query.
- Include only the top-N most relevant files plus the current file in the
  system prompt. Use `list_files` and `read_file` tools for the rest.
- Consider a two-pass approach: first ask the model which files it needs
  (like Cursor's "planning" step), then load those files.

### 6. Structured Output Parsing for Tool Calls

**Gap:** Tool call reliability varies by model. Some free models struggle to
produce valid JSON for tool arguments, leading to silent failures or
`(invalid JSON arguments)` errors.

**Target:** Improve tool call reliability across all supported models.

**Implementation path:**

- Add retry logic in the agent loop: if a tool call has invalid JSON
  arguments, append a tool result explaining the error and asking the model
  to retry with valid JSON, rather than silently failing.
- For models that support structured output (e.g., Anthropic's tool_use
  format), use provider-native tool calling instead of relying on
  OpenRouter's unified format.
- Add argument validation and correction: if `old_text` doesn't match but
  is close (fuzzy match), suggest the correction in the tool result to help
  the model self-correct.
- Consider falling back to regex-based extraction of tool calls from the
  text response when the model doesn't use the tool calling API correctly.

### 7. Real-Time Collaboration Awareness

**Gap:** If the document changes while the AI is working (e.g., the user
edits in another tab, or a collaborator pushes), the AI's context is stale
and edits may fail to apply.

**Target:** Detect document changes during AI operation and gracefully
handle conflicts.

**Implementation path:**

- Track a document version hash. Before applying staged changes, verify the
  base version matches.
- If the document changed, show a merge conflict UI that lets the user
  resolve differences.
- Send the current document content (not the stale version) when the user
  retries after a conflict.

### 8. Keyboard-Driven Workflow

**Gap:** The sidebar is primarily mouse-driven. Power users expect keyboard
shortcuts for common actions.

**Target:** Full keyboard navigation for the AI sidebar.

**Implementation path:**

- `Cmd/Ctrl+L` to focus the AI sidebar composer (already partially
  implemented via editor keybindings).
- `Cmd/Ctrl+Enter` to accept all staged changes.
- `Tab` / `Shift+Tab` to navigate between staged change hunks.
- `Y` / `N` to accept/reject individual hunks when focused.
- `Escape` to dismiss/unfocus the sidebar.
- Arrow keys to navigate chat history.

### 9. Prompt Templates and Slash Commands

**Gap:** Users must type full prompts for common operations like "fix this
bug", "add tests", "refactor this function".

**Target:** Support `/fix`, `/test`, `/refactor`, `/explain` and similar
slash commands that expand to well-crafted prompts with appropriate context.

**Implementation path:**

- Define a registry of slash commands with prompt templates.
- Show an autocomplete dropdown when the user types `/` in the composer.
- Each command can specify what context to attach (current selection,
  current file, related test files, etc.).
- Allow user-defined custom commands stored in localStorage or a
  `.reader-ai/commands.json` file.

### 10. Background Index for Large Projects

**Gap:** `search_files` does a linear scan through all project files on
every call. For large repos this is slow and burns context tokens on the
tool result.

**Target:** Build a search index when loading project files so searches are
fast and results are ranked by relevance.

**Implementation path:**

- Build a trigram or BM25 index of file contents when the project session
  is created.
- `search_files` queries the index instead of scanning all files.
- Consider adding a `semantic_search` tool that uses embeddings for
  natural-language code search.
- Cache the index in the project session so it persists across requests.

## Priority Order

Roughly ordered by impact on the editing experience:

1. **Per-Edit Inline Review** — highest impact; transforms the review UX
2. **Structured Output Parsing** — reliability is prerequisite for everything
3. **Streaming Diff Preview** — real-time feedback during generation
4. **Keyboard-Driven Workflow** — power user productivity
5. **Prompt Templates / Slash Commands** — reduces friction for common tasks
6. **Multi-Turn Context Persistence** — improves quality over long sessions
7. **Optimistic Apply with Undo** — faster apply cycle
8. **File-Aware Context Selection** — better quality for large projects
9. **Background Index for Large Projects** — performance for search-heavy use
10. **Real-Time Collaboration Awareness** — edge case robustness
