# Prompt Lab

This lab is a local-only, in-memory test harness for Reader AI exposed from [server/routes.ts](/Users/raymond/Code/input/server/routes.ts). It is only reachable from loopback, and all documents/runs disappear when the server restarts.

Typical loop:

1. Create a document.
2. Start a run against that document.
3. Watch the SSE stream for text, tool calls, and `staged_changes`.
4. Inspect the saved run.
5. Either apply the staged document, reset the document, or retry from `current` or `original`.

## Endpoints

- `POST /api/test/reader-ai/documents`
- `GET /api/test/reader-ai/documents/:id`
- `POST /api/test/reader-ai/documents/:id/reset`
- `POST /api/test/reader-ai/documents/:id/runs`
- `GET /api/test/reader-ai/runs/:id`
- `POST /api/test/reader-ai/runs/:id/retry`
- `POST /api/test/reader-ai/runs/:id/apply`

The run endpoints are implemented in [server/routes.ts](/Users/raymond/Code/input/server/routes.ts), and the end-to-end test examples are in [server/__tests__/reader_ai_lab.test.ts](/Users/raymond/Code/input/server/__tests__/reader_ai_lab.test.ts).

## Getting Started

**Find the server port.** The dev server port depends on your local configuration. Check which port is listening:

```bash
lsof -iTCP -sTCP:LISTEN -P -n | grep node
```

All examples below use port `8787` — substitute your actual port.

**Available models.** Lab requests bypass authentication, so both free OpenRouter models (`:free` suffix, must support tools) and the paid models hardcoded in `OPENROUTER_PAID_MODELS` in `server/routes.ts` are available. Current paid models include:

- `anthropic/claude-sonnet-4.6`
- `anthropic/claude-opus-4.6`
- `google/gemini-3-flash-preview`
- `google/gemini-3.1-pro-preview`

**Server restarts clear state.** All lab documents and runs are in-memory. If you restart the server (e.g. after editing `server/routes.ts` or `reader-ai/tools.ts`), you must re-create your documents.

## Minimal Example

Create a document:

```bash
curl -s http://127.0.0.1:8787/api/test/reader-ai/documents \
  -H 'Content-Type: application/json' \
  -d '{
    "path": "doc.md",
    "source": "Alpha\nBeta\nGamma"
  }'
```

Response shape:

```json
{
  "document": {
    "id": "...",
    "path": "doc.md",
    "original_source": "Alpha\nBeta\nGamma",
    "current_source": "Alpha\nBeta\nGamma"
  }
}
```

Run Reader AI against it:

```bash
curl -N -s -D /tmp/reader-ai-headers.txt \
  http://127.0.0.1:8787/api/test/reader-ai/documents/DOCUMENT_ID/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "anthropic/claude-sonnet-4.6",
    "messages": [
      { "role": "user", "content": "Rewrite the first paragraph." }
    ],
    "current_doc_path": "doc.md"
  }' > /tmp/reader-ai-stream.txt
```

Important details:

- This streams SSE, same style as `/api/ai/chat`.
- The response header `X-Reader-Ai-Lab-Run-Id` gives you the saved run id. Use `-D <file>` to capture it:
  ```bash
  grep -i 'X-Reader-Ai-Lab-Run-Id' /tmp/reader-ai-headers.txt
  ```
- The `model` field is required. See "Available models" above.

Inspect the saved run:

```bash
curl -s http://127.0.0.1:8787/api/test/reader-ai/runs/RUN_ID
```

That includes:

- original source used for the run
- saved request params
- accumulated assistant text
- full event log
- `staged_document_content`
- `staged_changes`

Apply the staged document to the lab document:

```bash
curl -s -X POST http://127.0.0.1:8787/api/test/reader-ai/runs/RUN_ID/apply
```

Reset the document back to its original content:

```bash
curl -s -X POST http://127.0.0.1:8787/api/test/reader-ai/documents/DOCUMENT_ID/reset
```

Retry from the same run with a different prompt:

```bash
curl -N -i http://127.0.0.1:8787/api/test/reader-ai/runs/RUN_ID/retry \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      { "role": "user", "content": "Try a more concise rewrite." }
    ]
  }'
```

## Useful Test Knobs

These are the extra test-only fields for `runs` and `retry`:

- `base_source`: `"current"` or `"original"`
- `allowed_tools`: tool subset, for example `["read_document"]` or `["read_document","search_document","propose_edit_document"]`
- `system_prompt_prefix`: prepend custom instructions before the normal Reader AI system prompt
- `allow_document_edits`: `false` for read-only behavior
- `edit_mode_current_doc_only`: `true` to restrict to current-doc editing tools

Example: force a read-only run with only `read_document` enabled:

```bash
curl -N -i http://127.0.0.1:8787/api/test/reader-ai/documents/DOCUMENT_ID/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "anthropic/claude-sonnet-4.6",
    "messages": [
      { "role": "user", "content": "Summarize this document." }
    ],
    "allowed_tools": ["read_document"],
    "allow_document_edits": false
  }'
```

Example: retry from the original doc, not the current lab state:

```bash
curl -N -i http://127.0.0.1:8787/api/test/reader-ai/runs/RUN_ID/retry \
  -H 'Content-Type: application/json' \
  -d '{
    "base_source": "original",
    "messages": [
      { "role": "user", "content": "Try a completely different rewrite." }
    ]
  }'
```

## Recommended Workflow

- Create one lab document per test case.
- Run once with full tools.
- Inspect `GET /runs/:id` to see exactly what happened.
- If you want a clean retry, use `base_source: "original"` or call `reset`.
- If you want to keep an accepted staged output as the next baseline, call `apply` first, then retry from `current`.

## Notes

- Local-only means `127.0.0.1` on the same machine. Remote callers should get `404`.
- State is in memory only.
- The final SSE stream always emits a `staged_changes` snapshot, even if it’s empty.
- The lab uses the same core Reader AI execution path as normal chat, so tool behavior should match closely.
