import { useEffect, useRef, useState } from 'preact/hooks';
import './styles.css';
import { ApiError } from '../api_error';
import {
  commitSandboxChanges,
  deleteSandboxesKey,
  getSandboxesHealth,
  getSandboxesKeyStatus,
  getSandboxesSession,
  getSandboxGitStatus,
  getSandboxRuntimeStatus,
  pullSandboxChanges,
  pushSandboxChanges,
  runAgentOnSandbox,
  runSandboxCommand,
  setSandboxesKey,
  startSandboxRuntime,
  stopSandboxRuntime,
} from './api';
import type {
  AgentResult,
  AgentStep,
  CommandRunResult,
  SandboxesKeyStatus,
  SandboxesSessionResponse,
  SandboxRecord,
  SandboxState,
} from './types';

type TerminalLogEntry = {
  id: string;
  kind: 'cmd' | 'stdout' | 'stderr' | 'status';
  text: string;
};

function parseRepoFromPath(pathname: string): { owner: string; repo: string } | null {
  const match = pathname.match(/^\/sandboxes\/([^/]+)\/([^/]+)\/?$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function authReturnUrl(): string {
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/sandboxes';
  return `/api/auth/github/start?return_to=${encodeURIComponent(returnTo)}`;
}

function nextLogId(): string {
  return Math.random().toString(16).slice(2);
}

function stateLabel(state: SandboxState): string {
  const labels: Record<SandboxState, string> = {
    provisioning: 'Provisioning...',
    hydrating: 'Cloning repository...',
    ready: 'Ready',
    stopping: 'Stopping...',
    stopped: 'Stopped',
    failed: 'Failed',
  };
  return labels[state] ?? state;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function AgentStepView({ step }: { step: AgentStep }) {
  if (step.type === 'message') {
    return <pre class="agent-step agent-message">{step.text}</pre>;
  }
  const inputSummary =
    step.toolName === 'write_file'
      ? String(step.toolInput?.path ?? '')
      : step.toolName === 'read_file'
        ? String(step.toolInput?.path ?? '')
        : String(step.toolInput?.command ?? '');
  return (
    <div class="agent-step agent-tool-call">
      <div class="agent-tool-header">
        [{step.toolName}] {inputSummary}
      </div>
      {step.toolOutput ? <pre class="agent-tool-output">{truncate(step.toolOutput, 2000)}</pre> : null}
    </div>
  );
}

export function SandboxesApp() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SandboxesSessionResponse>({ authenticated: false });
  const [sandbox, setSandbox] = useState<SandboxRecord | null>(null);
  const [command, setCommand] = useState('ls -la');
  const [commandRunning, setCommandRunning] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [logs, setLogs] = useState<TerminalLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Agent state
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('gpt-4.1-mini');
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const agentResultRef = useRef<HTMLElement>(null);

  // Git state
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const [gitBusy, setGitBusy] = useState(false);

  // Key state
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyStatus, setKeyStatus] = useState<SandboxesKeyStatus>({ configured: false, masked: null });
  const [keySaving, setKeySaving] = useState(false);

  const repoParts = parseRepoFromPath(window.location.pathname);

  // Poll for state transitions
  useEffect(() => {
    if (!repoParts || !sandbox) return;
    const transitional =
      sandbox.state === 'provisioning' || sandbox.state === 'hydrating' || sandbox.state === 'stopping';
    if (!transitional) return;

    const interval = setInterval(async () => {
      try {
        const { sandbox: updated } = await getSandboxRuntimeStatus(repoParts.owner, repoParts.repo);
        if (updated) {
          setSandbox(updated);
          if (updated.state !== 'provisioning' && updated.state !== 'hydrating' && updated.state !== 'stopping') {
            clearInterval(interval);
          }
        } else {
          setSandbox(null);
          clearInterval(interval);
        }
      } catch {
        // ignore polling errors
      }
    }, 3_000);

    return () => clearInterval(interval);
  }, [sandbox?.state, sandbox?.id]);

  // Initial load
  useEffect(() => {
    void (async () => {
      try {
        const [sessionResponse] = await Promise.all([getSandboxesSession(), getSandboxesHealth()]);
        setSession(sessionResponse);
        if (sessionResponse.authenticated) {
          const currentKeyStatus = sessionResponse.key ?? (await getSandboxesKeyStatus());
          setKeyStatus(currentKeyStatus);
          if (repoParts) {
            const { sandbox: existing } = await getSandboxRuntimeStatus(repoParts.owner, repoParts.repo);
            if (existing) setSandbox(existing);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Scroll agent results into view when they arrive
  useEffect(() => {
    if (agentResult && agentResultRef.current) {
      agentResultRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [agentResult]);

  const appendLog = (entry: Omit<TerminalLogEntry, 'id'>): void => {
    setLogs((prev) => [...prev, { id: nextLogId(), ...entry }].slice(-500));
  };

  const onStart = async (): Promise<void> => {
    if (!repoParts) return;
    setError(null);
    setStarting(true);
    try {
      const { sandbox: s } = await startSandboxRuntime(repoParts.owner, repoParts.repo);
      setSandbox(s);
      appendLog({ kind: 'status', text: s ? `Sandbox ${s.state}` : 'Started' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start sandbox');
    } finally {
      setStarting(false);
    }
  };

  const onStop = async (): Promise<void> => {
    if (!repoParts) return;
    if (!window.confirm('Stop this sandbox? Any unsaved changes on the VM will be lost.')) return;
    setError(null);
    try {
      await stopSandboxRuntime(repoParts.owner, repoParts.repo);
      setSandbox(null);
      appendLog({ kind: 'status', text: 'Sandbox stopped' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop sandbox');
    }
  };

  const onRunCommand = async (): Promise<void> => {
    if (!repoParts || !command.trim()) return;
    setError(null);
    setCommandRunning(true);
    appendLog({ kind: 'cmd', text: `$ ${command}` });

    try {
      const result: CommandRunResult = await runSandboxCommand(repoParts.owner, repoParts.repo, command);
      if (result.stdout) appendLog({ kind: 'stdout', text: result.stdout });
      if (result.stderr) appendLog({ kind: 'stderr', text: result.stderr });
      appendLog({
        kind: 'status',
        text: `exit=${result.exitCode} duration=${result.durationMs}ms cwd=${result.cwd}${
          result.timedOut ? ' timed-out' : ''
        }${result.truncated ? ' truncated' : ''}`,
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Command failed';
      appendLog({ kind: 'stderr', text: message });
      setError(message);
    } finally {
      setCommandRunning(false);
    }
  };

  const onRunAgent = async (): Promise<void> => {
    if (!repoParts || !prompt.trim()) return;
    if (!keyStatus.configured) {
      setError('Set your OpenAI API key before running the agent.');
      return;
    }
    setError(null);
    setAgentRunning(true);
    setAgentResult(null);
    try {
      const result = await runAgentOnSandbox(repoParts.owner, repoParts.repo, prompt, model);
      setAgentResult(result);
      if (result.changedFiles.length > 0) {
        setChangedFiles(result.changedFiles);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Agent failed');
    } finally {
      setAgentRunning(false);
    }
  };

  const onRefreshGitStatus = async (): Promise<void> => {
    if (!repoParts) return;
    setGitBusy(true);
    try {
      const status = await getSandboxGitStatus(repoParts.owner, repoParts.repo);
      setChangedFiles(status.changedFiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get git status');
    } finally {
      setGitBusy(false);
    }
  };

  const onCommit = async (): Promise<void> => {
    if (!repoParts || !commitMessage.trim()) {
      setError('Commit message is required');
      return;
    }
    setError(null);
    setGitBusy(true);
    try {
      const result = await commitSandboxChanges(repoParts.owner, repoParts.repo, commitMessage);
      appendLog({ kind: 'status', text: `Committed ${result.commitSha?.slice(0, 8) ?? '(unknown)'}` });
      setCommitMessage('');
      setChangedFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setGitBusy(false);
    }
  };

  const onPush = async (): Promise<void> => {
    if (!repoParts) return;
    if (!window.confirm(`Push to origin/${sandbox?.branch ?? 'HEAD'}? This will update the remote branch.`)) return;
    setError(null);
    setGitBusy(true);
    try {
      const result = await pushSandboxChanges(repoParts.owner, repoParts.repo);
      appendLog({ kind: 'status', text: `Pushed ${result.sha?.slice(0, 8) ?? '(unknown)'}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push failed');
    } finally {
      setGitBusy(false);
    }
  };

  const onPull = async (): Promise<void> => {
    if (!repoParts) return;
    setError(null);
    setGitBusy(true);
    try {
      await pullSandboxChanges(repoParts.owner, repoParts.repo);
      appendLog({ kind: 'status', text: 'Pull complete' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setGitBusy(false);
    }
  };

  const onSaveApiKey = async (): Promise<void> => {
    if (!apiKeyInput.trim()) {
      setError('API key is required');
      return;
    }
    setError(null);
    setKeySaving(true);
    try {
      const status = await setSandboxesKey(apiKeyInput);
      setKeyStatus(status);
      setApiKeyInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setKeySaving(false);
    }
  };

  const onDeleteApiKey = async (): Promise<void> => {
    if (!window.confirm('Delete your stored API key?')) return;
    setError(null);
    setKeySaving(true);
    try {
      const status = await deleteSandboxesKey();
      setKeyStatus(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete API key');
    } finally {
      setKeySaving(false);
    }
  };

  if (loading) {
    return (
      <main class="sandboxes-root">
        <section class="sandboxes-empty">Loading...</section>
      </main>
    );
  }

  if (!repoParts) {
    window.location.replace('/workspaces');
    return null;
  }

  if (!session.authenticated) {
    return (
      <main class="sandboxes-root">
        <section class="sandboxes-empty">
          <h1>
            Sandbox: {repoParts.owner}/{repoParts.repo}
          </h1>
          <p>Sign in with GitHub to open this sandbox.</p>
          <a class="sandboxes-button" href={authReturnUrl()}>
            Sign in with GitHub
          </a>
        </section>
      </main>
    );
  }

  const isActive = sandbox && sandbox.state !== 'stopped' && sandbox.state !== 'failed';
  const isReady = sandbox?.state === 'ready';

  return (
    <main class="sandboxes-root">
      <header class="sandboxes-header">
        <div>
          <h1>
            {repoParts.owner}/{repoParts.repo}
          </h1>
          <p>
            Logged in as <strong>{session.user?.login}</strong>
            {sandbox
              ? ` \u00b7 Branch: ${sandbox.branch} \u00b7 ${stateLabel(sandbox.state)}`
              : ' \u00b7 No sandbox running'}
          </p>
        </div>
        <div class="sandboxes-meta">
          <span>
            API key: {keyStatus.configured ? `configured (${keyStatus.masked ?? ''})` : 'not configured'}
          </span>
        </div>
      </header>

      {error ? <div class="sandboxes-error">{error}</div> : null}

      <section class="sandboxes-grid">
        <aside class="sandboxes-panel sandboxes-sidebar">
          <h2>Runtime</h2>
          <div class="sandboxes-inline">
            {!isActive ? (
              <button type="button" class="sandboxes-button" onClick={onStart} disabled={starting}>
                {starting ? 'Starting...' : 'Start Sandbox'}
              </button>
            ) : (
              <button type="button" class="sandboxes-button is-danger" onClick={onStop}>
                Stop Sandbox
              </button>
            )}
          </div>

          <h2>OpenAI API Key</h2>
          <div class="sandboxes-key-box">
            <div class="sandboxes-inline">
              <input
                id="sandboxes-api-key"
                type="password"
                value={apiKeyInput}
                placeholder={keyStatus.configured ? 'Enter new key to rotate' : 'Paste your key'}
                onInput={(event) => setApiKeyInput((event.target as HTMLInputElement).value)}
              />
              <button type="button" class="sandboxes-button" onClick={onSaveApiKey} disabled={keySaving}>
                {keySaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                class="sandboxes-button is-danger"
                onClick={onDeleteApiKey}
                disabled={keySaving || !keyStatus.configured}
              >
                Delete
              </button>
            </div>
            <small class="sandboxes-muted">
              {keyStatus.configured
                ? `Stored (${keyStatus.masked ?? 'configured'}).`
                : 'Required to run the coding agent.'}
            </small>
          </div>

          {isReady ? (
            <>
              <h2>Agent</h2>
              <textarea
                class="sandboxes-textarea"
                value={prompt}
                onInput={(event) => setPrompt((event.target as HTMLTextAreaElement).value)}
                placeholder="Describe what you want the agent to do in this repo."
              />
              <div class="sandboxes-inline">
                <input
                  type="text"
                  value={model}
                  onInput={(event) => setModel((event.target as HTMLInputElement).value)}
                  placeholder="Model"
                />
                <button
                  type="button"
                  class="sandboxes-button"
                  onClick={onRunAgent}
                  disabled={agentRunning || !keyStatus.configured || !prompt.trim()}
                >
                  {agentRunning ? 'Running...' : 'Run Agent'}
                </button>
              </div>
            </>
          ) : null}
        </aside>

        <section class="sandboxes-panel sandboxes-terminal">
          <h2>Terminal</h2>
          {isReady ? (
            <>
              <div class="sandboxes-inline">
                <input
                  type="text"
                  value={command}
                  onInput={(event) => setCommand((event.target as HTMLInputElement).value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !commandRunning) void onRunCommand();
                  }}
                  placeholder="Enter shell command"
                />
                <button type="button" class="sandboxes-button" onClick={onRunCommand} disabled={commandRunning}>
                  {commandRunning ? 'Running...' : 'Run'}
                </button>
              </div>

              <div class="sandboxes-terminal-log" role="log" aria-live="polite">
                {logs.length === 0 ? <p class="sandboxes-muted">No command output yet.</p> : null}
                {logs.map((entry) => (
                  <pre key={entry.id} class={`line-${entry.kind}`}>
                    {entry.text}
                  </pre>
                ))}
              </div>
            </>
          ) : (
            <p class="sandboxes-muted">
              {isActive ? stateLabel(sandbox!.state) : 'Start the sandbox to run commands.'}
            </p>
          )}

          {agentResult ? (
            <section class="sandboxes-agent-result" ref={agentResultRef}>
              <h3>Agent Result ({agentResult.model})</h3>
              <div class="agent-steps">
                {agentResult.steps.map((step, i) => (
                  <AgentStepView key={i} step={step} />
                ))}
              </div>
              {agentResult.changedFiles.length > 0 ? (
                <div class="agent-changed-files">
                  <h4>
                    {agentResult.changedFiles.length} file{agentResult.changedFiles.length !== 1 ? 's' : ''} changed
                  </h4>
                  <ul>
                    {agentResult.changedFiles.map((f) => (
                      <li key={f}>
                        <code>{f}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}
        </section>

        {isReady ? (
          <section class="sandboxes-panel sandboxes-git">
            <h2>Git</h2>
            <div class="sandboxes-inline">
              <button type="button" class="sandboxes-button" onClick={onRefreshGitStatus} disabled={gitBusy}>
                Refresh Status
              </button>
              <button type="button" class="sandboxes-button" onClick={onPull} disabled={gitBusy}>
                Pull
              </button>
              <button type="button" class="sandboxes-button" onClick={onPush} disabled={gitBusy}>
                Push
              </button>
            </div>
            {changedFiles.length > 0 ? (
              <div>
                <p>
                  {changedFiles.length} changed file{changedFiles.length !== 1 ? 's' : ''}:
                </p>
                <ul class="sandboxes-changed-files">
                  {changedFiles.map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p class="sandboxes-muted">No changes detected. Click "Refresh Status" to check.</p>
            )}
            <div class="sandboxes-inline">
              <input
                type="text"
                value={commitMessage}
                onInput={(event) => setCommitMessage((event.target as HTMLInputElement).value)}
                placeholder="Commit message"
              />
              <button
                type="button"
                class="sandboxes-button"
                onClick={onCommit}
                disabled={gitBusy || !commitMessage.trim()}
              >
                Commit
              </button>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}
