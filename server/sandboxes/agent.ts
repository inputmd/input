import { ClientError } from '../errors';
import {
  getRunnerGitStatus,
  runArgvOnRunner,
  runCommandOnRunner,
  writeFileOnRunner,
} from './fly_runtime';
import type { AgentResult, AgentStep } from './types';

const MAX_STEPS = 30;
const TOOL_TIMEOUT_MS = 45_000;
const AGENT_TIMEOUT_MS = 300_000; // 5 minutes overall
const DEFAULT_MODEL = 'gpt-4.1-mini';

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'shell',
      description:
        'Run a shell command in the repository workspace (/workspace). Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the contents of a file relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from workspace root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write content to a file relative to the workspace root. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from workspace root' },
          content: { type: 'string', description: 'The full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
}

async function executeTool(
  machineId: string,
  name: string,
  argsJson: string,
): Promise<{ output: string; input: Record<string, unknown> }> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return { output: 'Error: invalid JSON arguments', input: {} };
  }

  try {
    switch (name) {
      case 'shell': {
        const command = String(args.command ?? '');
        if (!command) return { output: 'Error: command is required', input: args };
        const result = await runCommandOnRunner(machineId, command, TOOL_TIMEOUT_MS);
        let output = '';
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += `${output ? '\n' : ''}stderr: ${result.stderr}`;
        output += `\nexit code: ${result.exitCode}`;
        if (result.timedOut) output += ' (timed out)';
        if (result.truncated) output += ' (output truncated)';
        return { output: output || '(no output)', input: args };
      }
      case 'read_file': {
        const path = String(args.path ?? '');
        if (!path) return { output: 'Error: path is required', input: args };
        const result = await runArgvOnRunner(machineId, ['cat', '--', path], TOOL_TIMEOUT_MS);
        if (result.exitCode !== 0) {
          return { output: `Error: ${result.stderr || 'file not found'}`, input: args };
        }
        return { output: result.stdout, input: args };
      }
      case 'write_file': {
        const path = String(args.path ?? '');
        const content = String(args.content ?? '');
        if (!path) return { output: 'Error: path is required', input: args };
        await writeFileOnRunner(machineId, path, content);
        return { output: 'File written successfully.', input: args };
      }
      default:
        return { output: `Error: unknown tool "${name}"`, input: args };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool execution failed';
    return { output: `Error: ${message}`, input: args };
  }
}

export async function runAgent(options: {
  machineId: string;
  repoFullName: string;
  branch: string;
  prompt: string;
  model?: string;
  apiKey: string;
}): Promise<AgentResult> {
  const { machineId, repoFullName, branch, prompt, apiKey } = options;
  const model = options.model?.trim() || DEFAULT_MODEL;
  const steps: AgentStep[] = [];
  const deadline = Date.now() + AGENT_TIMEOUT_MS;

  const systemPrompt = [
    `You are a coding agent operating in a cloned Git repository (${repoFullName} on branch ${branch}).`,
    'The workspace is at /workspace.',
    '',
    'You have tools to run shell commands, read files, and write files.',
    'Use them to understand the codebase and fulfill the user\'s request.',
    '',
    'Guidelines:',
    '- Explore relevant parts of the codebase before making changes.',
    '- Make targeted, minimal changes.',
    '- After changes, verify they work if practical (e.g. run tests or a build).',
    '- When done, provide a brief summary of what you did.',
  ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    if (Date.now() > deadline) {
      steps.push({ type: 'message', text: '(Agent timed out after 5 minutes)' });
      break;
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, tools: TOOLS }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ClientError(`OpenAI request failed (${response.status}): ${text || 'unknown error'}`, 502);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new ClientError('No response from model', 502);
    }

    const assistantMsg = choice.message;
    messages.push(assistantMsg as ChatMessage);

    if (assistantMsg.content) {
      steps.push({ type: 'message', text: assistantMsg.content });
    }

    // No tool calls means the agent is done
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      break;
    }

    // Execute each tool call and feed results back
    for (const toolCall of assistantMsg.tool_calls) {
      const { output, input } = await executeTool(machineId, toolCall.function.name, toolCall.function.arguments);

      steps.push({
        type: 'tool_call',
        toolName: toolCall.function.name,
        toolInput: input,
        toolOutput: output,
      });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: output,
      });
    }
  }

  // Get git status to see what the agent changed
  let changedFiles: string[] = [];
  try {
    const gitStatus = await getRunnerGitStatus(machineId);
    changedFiles = gitStatus.changedFiles;
  } catch {
    // best-effort
  }

  const lastMessage = [...steps].reverse().find((s) => s.type === 'message');
  const summary = lastMessage?.text ?? 'Agent completed.';

  return { steps, summary, model, changedFiles };
}
