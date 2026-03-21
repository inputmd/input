import test from 'ava';
import {
  executeReaderAiSubagent,
  READER_AI_TASK_MAX_OUTPUT_CHARS,
  type ReaderAiFileEntry,
  type ReaderAiSubagentOptions,
  StagedChanges,
} from '../reader_ai_tools.ts';

// ── Helpers ──

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseDone(): string {
  return 'data: [DONE]\n\n';
}

/** Build a ReadableStream<Uint8Array> from SSE text. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
  });
}

/** Build a Response-like object for mock fetch. */
function mockResponse(body: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, { status });
}

function textStreamResponse(...texts: string[]): Response {
  const chunks = [
    ...texts.map((t) => sseChunk({ choices: [{ delta: { content: t } }] })),
    sseChunk({ choices: [{ finish_reason: 'stop' }] }),
    sseDone(),
  ];
  return mockResponse(sseStream(chunks));
}

function toolCallStreamResponse(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
  textBefore = '',
): Response {
  const chunks: string[] = [];
  if (textBefore) {
    chunks.push(sseChunk({ choices: [{ delta: { content: textBefore } }] }));
  }
  chunks.push(
    sseChunk({
      choices: [
        {
          delta: {
            tool_calls: toolCalls.map((tc, i) => ({
              index: i,
              id: tc.id,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          },
        },
      ],
    }),
  );
  chunks.push(sseChunk({ choices: [{ finish_reason: 'tool_calls' }] }));
  chunks.push(sseDone());
  return mockResponse(sseStream(chunks));
}

const defaultOpts: Omit<ReaderAiSubagentOptions, 'fetchFn'> = {
  model: 'test-model',
  prompt: 'Do something',
  lines: ['line one', 'line two', 'line three'],
  source: 'line one\nline two\nline three',
  openRouterHeaders: { Authorization: 'Bearer test' },
  signal: new AbortController().signal,
};

// ── Tests ──

test('subagent returns text output from a simple response', async (t) => {
  const fetchFn = async () => textStreamResponse('Hello from subagent');
  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.is(result, 'Hello from subagent');
});

test('subagent concatenates multi-chunk text', async (t) => {
  const fetchFn = async () => textStreamResponse('Part 1 ', 'Part 2');
  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.is(result, 'Part 1 Part 2');
});

test('subagent uses custom system prompt when provided', async (t) => {
  let capturedBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('ok');
  };
  await executeReaderAiSubagent({
    ...defaultOpts,
    systemPrompt: 'You are a custom agent.',
    fetchFn,
  });
  const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
  t.is(parsed.messages[0].role, 'system');
  t.is(parsed.messages[0].content, 'You are a custom agent.');
});

test('subagent uses default system prompt when none provided', async (t) => {
  let capturedBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('ok');
  };
  await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
  t.is(parsed.messages[0].role, 'system');
  t.true(parsed.messages[0].content.includes('focused subagent'));
  t.true(parsed.messages[0].content.includes('3 lines'));
});

test('subagent handles tool calls and loops', async (t) => {
  let callCount = 0;
  const fetchFn = async () => {
    callCount++;
    if (callCount === 1) {
      // First call: model requests read_document
      return toolCallStreamResponse([
        { id: 'call_1', name: 'read_document', arguments: '{"start_line":1,"end_line":2}' },
      ]);
    }
    // Second call: model returns final text
    return textStreamResponse('The first two lines are: line one, line two.');
  };

  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.is(callCount, 2);
  t.is(result, 'The first two lines are: line one, line two.');
});

test('subagent processes search_document tool call', async (t) => {
  let callCount = 0;
  let secondCallBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    callCount++;
    if (callCount === 1) {
      return toolCallStreamResponse([{ id: 'call_s', name: 'search_document', arguments: '{"query":"two"}' }]);
    }
    secondCallBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('Found it.');
  };

  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.is(result, 'Found it.');

  // Verify the tool result was sent back in the conversation
  const parsed = JSON.parse(secondCallBody) as {
    messages: Array<{ role: string; content?: string; tool_call_id?: string }>;
  };
  const toolResultMsg = parsed.messages.find((m) => m.role === 'tool');
  t.truthy(toolResultMsg);
  t.is(toolResultMsg!.tool_call_id, 'call_s');
  t.true(typeof toolResultMsg!.content === 'string' && toolResultMsg!.content.includes('1 match'));
});

test('subagent does not include task tool in its tool set', async (t) => {
  let capturedBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('ok');
  };
  await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  const parsed = JSON.parse(capturedBody) as { tools: Array<{ function: { name: string } }> };
  const toolNames = parsed.tools.map((t) => t.function.name);
  t.false(toolNames.includes('task'));
  t.true(toolNames.includes('read_document'));
  t.true(toolNames.includes('search_document'));
});

test('subagent returns error message on non-OK response', async (t) => {
  const fetchFn = async () => {
    const body = JSON.stringify({ error: { message: 'rate limited' } });
    return new Response(body, { status: 429, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.true(result.includes('[Subagent error:'));
  t.true(result.includes('rate limited'));
});

test('subagent returns error when response has no body', async (t) => {
  const fetchFn = async () => new Response(null, { status: 200 });
  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.true(result.includes('[Subagent error: no response body]'));
});

test('subagent returns generic error for non-OK without error object', async (t) => {
  const fetchFn = async () => new Response('{}', { status: 500 });
  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.true(result.includes('Subagent request failed (500)'));
});

test('subagent preserves partial output on mid-loop error', async (t) => {
  let callCount = 0;
  const fetchFn = async () => {
    callCount++;
    if (callCount === 1) {
      // First call: model outputs text + requests a tool
      return toolCallStreamResponse(
        [{ id: 'call_1', name: 'read_document', arguments: '{}' }],
        'Partial output here. ',
      );
    }
    // Second call: fails
    return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 });
  };

  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.true(result.includes('Partial output here.'));
  t.true(result.includes('[Subagent error:'));
});

test('subagent returns empty output message when model produces nothing', async (t) => {
  const fetchFn = async () => {
    // Model returns finish_reason=stop with no content
    return mockResponse(sseStream([sseChunk({ choices: [{ finish_reason: 'stop' }] }), sseDone()]));
  };
  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.is(result, '(subagent produced no output)');
});

test('subagent truncates output exceeding max chars', async (t) => {
  const longText = 'x'.repeat(READER_AI_TASK_MAX_OUTPUT_CHARS + 1000);
  const fetchFn = async () => textStreamResponse(longText);
  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.true(result.length < longText.length);
  t.true(result.includes('subagent output truncated'));
  t.true(result.startsWith('x'.repeat(100)));
});

test('subagent stops after max iterations', async (t) => {
  let callCount = 0;
  const fetchFn = async () => {
    callCount++;
    // Always return tool calls, never a final response
    return toolCallStreamResponse(
      [{ id: `call_${callCount}`, name: 'read_document', arguments: '{"start_line":1,"end_line":1}' }],
      `Iteration ${callCount}. `,
    );
  };

  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  // READER_AI_TASK_MAX_ITERATIONS is 10
  t.is(callCount, 10);
  // Output should contain accumulated text from all iterations
  t.true(result.includes('Iteration 1'));
  t.true(result.includes('Iteration 10'));
});

test('subagent handles multiple tool calls in single turn', async (t) => {
  let callCount = 0;
  let secondCallBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    callCount++;
    if (callCount === 1) {
      return toolCallStreamResponse([
        { id: 'call_a', name: 'read_document', arguments: '{"start_line":1,"end_line":1}' },
        { id: 'call_b', name: 'search_document', arguments: '{"query":"three"}' },
      ]);
    }
    secondCallBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('Done.');
  };

  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.is(result, 'Done.');

  // Verify both tool results were sent
  const parsed = JSON.parse(secondCallBody) as { messages: Array<{ role: string; tool_call_id?: string }> };
  const toolResults = parsed.messages.filter((m) => m.role === 'tool');
  t.is(toolResults.length, 2);
  t.is(toolResults[0].tool_call_id, 'call_a');
  t.is(toolResults[1].tool_call_id, 'call_b');
});

test('subagent handles unknown tool call gracefully', async (t) => {
  let callCount = 0;
  let secondCallBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    callCount++;
    if (callCount === 1) {
      return toolCallStreamResponse([{ id: 'call_u', name: 'nonexistent_tool', arguments: '{}' }]);
    }
    secondCallBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('Handled.');
  };

  const result = await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.is(result, 'Handled.');

  const parsed = JSON.parse(secondCallBody) as { messages: Array<{ role: string; content?: string }> };
  const toolResult = parsed.messages.find((m) => m.role === 'tool');
  t.truthy(toolResult);
  t.true(typeof toolResult!.content === 'string' && toolResult!.content.includes('unknown tool'));
});

test('project subagent can edit shared staged changes', async (t) => {
  const projectFiles: ReaderAiFileEntry[] = [{ path: 'a.txt', content: 'hello', size: 5 }];
  const stagedChanges = new StagedChanges(projectFiles);
  let callCount = 0;
  let secondCallBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    callCount++;
    if (callCount === 1) {
      return toolCallStreamResponse([
        {
          id: 'call_e',
          name: 'propose_edit_file',
          arguments: '{"path":"a.txt","old_text":"hello","new_text":"HELLO"}',
        },
      ]);
    }
    secondCallBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('Done.');
  };

  const result = await executeReaderAiSubagent({
    ...defaultOpts,
    projectFiles,
    stagedChanges,
    fetchFn,
  });
  t.is(result, 'Done.');
  t.true(stagedChanges.hasChanges());

  const parsed = JSON.parse(secondCallBody) as { messages: Array<{ role: string; content?: string }> };
  const toolResult = parsed.messages.find((m) => m.role === 'tool');
  t.truthy(toolResult);
  t.true(typeof toolResult!.content === 'string' && toolResult!.content.includes('Edited a.txt'));
});

test('subagent sends prompt as user message', async (t) => {
  let capturedBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('ok');
  };
  await executeReaderAiSubagent({
    ...defaultOpts,
    prompt: 'Analyze the document for themes.',
    fetchFn,
  });
  const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
  const userMsg = parsed.messages.find((m) => m.role === 'user');
  t.truthy(userMsg);
  t.is(userMsg!.content, 'Analyze the document for themes.');
});

test('subagent passes model to upstream request', async (t) => {
  let capturedBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('ok');
  };
  await executeReaderAiSubagent({
    ...defaultOpts,
    model: 'my-special-model:free',
    fetchFn,
  });
  const parsed = JSON.parse(capturedBody) as { model: string };
  t.is(parsed.model, 'my-special-model:free');
});

test('subagent passes headers to upstream request', async (t) => {
  let capturedHeaders: Record<string, string> = {};
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return textStreamResponse('ok');
  };
  await executeReaderAiSubagent({
    ...defaultOpts,
    openRouterHeaders: { Authorization: 'Bearer key123', 'X-Title': 'Test' },
    fetchFn,
  });
  t.is(capturedHeaders.Authorization, 'Bearer key123');
  t.is(capturedHeaders['X-Title'], 'Test');
});

test('subagent calls correct URL', async (t) => {
  let capturedUrl = '';
  const fetchFn = async (url: string | URL | Request) => {
    capturedUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    return textStreamResponse('ok');
  };
  await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  t.is(capturedUrl, 'https://openrouter.ai/api/v1/chat/completions');
});

test('subagent requests streaming', async (t) => {
  let capturedBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('ok');
  };
  await executeReaderAiSubagent({ ...defaultOpts, fetchFn });
  const parsed = JSON.parse(capturedBody) as { stream: boolean };
  t.true(parsed.stream);
});

test('subagent enables prompt caching for paid claude models', async (t) => {
  let capturedBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('ok');
  };
  await executeReaderAiSubagent({
    ...defaultOpts,
    model: 'anthropic/claude-sonnet-4.6',
    fetchFn,
  });
  const parsed = JSON.parse(capturedBody) as { cache_control?: { type?: string } };
  t.deepEqual(parsed.cache_control, { type: 'ephemeral' });
});

test('subagent does not enable prompt caching for paid gemini models', async (t) => {
  let capturedBody = '';
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = typeof init?.body === 'string' ? init.body : '';
    return textStreamResponse('ok');
  };
  await executeReaderAiSubagent({
    ...defaultOpts,
    model: 'google/gemini-3-pro-preview',
    fetchFn,
  });
  const parsed = JSON.parse(capturedBody) as { cache_control?: unknown };
  t.false('cache_control' in parsed);
});
