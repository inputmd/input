# `input/terminal`

Browser WebContainer terminal primitives, split into a core controller API and an optional prebuilt view.

This directory is the extraction target for the terminal module. The current public entrypoints are:

- `input/terminal`: core exports only
- `input/terminal/core`: explicit core hook, config, and controller types
- `input/terminal/view`: optional prebuilt UI wrapper

The intent is:

- keep the runtime and file sync logic in `core`
- keep UI and app-specific presentation in `view`
- make the core surface small enough to move into its own package later

## Entry points

### `input/terminal/core`

Core exports:

- `useWebContainerTerminalController`
- `WebContainerTerminalConfig`
- `UseWebContainerTerminalControllerOptions`
- `WebContainerTerminalController`
- related config and file sync types

Use this when you want to render your own terminal shell UI and only need:

- WebContainer boot and terminal session management
- pane management
- file mount and import/export behavior
- persistence prompts and controller state

### `input/terminal/view`

View exports:

- `WebContainerTerminalView`
- `TerminalPersistenceDialog`

Use this when you want the packaged terminal UI with minimal wiring.

The view layer depends on the app's existing styles, icon set, and dialog/menu components. It is intentionally optional so a future extracted package can either:

- ship this view as a separate adapter package, or
- leave consumers on the core hook and controller only

## Quick start

### Core hook

```tsx
import {
  useWebContainerTerminalController,
  type WebContainerTerminalConfig,
} from 'input/terminal/core';

const terminalConfig: WebContainerTerminalConfig = {
  session: {
    id: 'editor-terminal',
    apiKey: webContainerApiKey,
    autostart: true,
    workdirName: 'project',
  },
  files: {
    base: {
      'package.json': JSON.stringify({ name: 'demo', private: true }, null, 2),
      'index.js': 'console.log("hello");\n',
    },
    ready: true,
    live: {
      path: 'index.js',
      content: currentEditorText,
    },
    syncToContainer: {
      enabled: true,
      debounceMs: 150,
    },
    importFromContainer: {
      enabled: true,
      includeLiveFile: true,
      onDiff: async (diff) => {
        await persistWorkspaceDiff(diff);
      },
    },
  },
};

export function TerminalHost() {
  const controller = useWebContainerTerminalController({
    config: terminalConfig,
    visible: true,
  });

  return (
    <div class="terminal-shell">
      {controller.visiblePaneIds.map((paneId) => (
        <div
          key={paneId}
          ref={(node) => controller.actions.setPaneContainer(paneId, node)}
          onPointerDown={() => controller.actions.selectPane(paneId)}
          style={{ minHeight: '240px' }}
        />
      ))}
    </div>
  );
}
```

The core hook owns the terminal processes and writes xterm instances into the DOM nodes you register with `setPaneContainer`.

### Prebuilt view

```tsx
import {
  WebContainerTerminalView,
  type WebContainerTerminalConfig,
} from 'input/terminal/view';

export function TerminalPanel(props: {
  apiKey: string;
  files: Record<string, string>;
  visible: boolean;
}) {
  const config: WebContainerTerminalConfig = {
    session: {
      id: 'panel-terminal',
      apiKey: props.apiKey,
      autostart: true,
      workdirName: 'workspace',
    },
    files: {
      base: props.files,
      ready: true,
    },
  };

  return <WebContainerTerminalView config={config} visible={props.visible} />;
}
```

Use the view export if you want the existing terminal panel behavior with the least amount of integration code.

## Public API

### `WebContainerTerminalConfig`

```ts
interface WebContainerTerminalConfig {
  diagnostics?: WebContainerTerminalDiagnosticsConfig;
  files: WebContainerTerminalFilesConfig;
  lifecycle?: WebContainerTerminalLifecycleConfig;
  network?: false | WebContainerTerminalNetworkConfig;
  overlay?: false | WebContainerTerminalOverlayConfig;
  panes?: WebContainerTerminalPanesConfig;
  persistedHome?: false | WebContainerTerminalPersistedHomeConfig;
  session: WebContainerTerminalSessionConfig;
  shortcuts?: WebContainerTerminalShortcutsConfig;
}
```

#### `session`

```ts
interface WebContainerTerminalSessionConfig {
  id: string;
  apiKey?: string;
  autostart?: boolean;
  workdirName: string;
  boot?: {
    coep?: 'credentialless' | 'none';
    reuseBootInstance?: boolean;
  };
}
```

- `id`: stable session identity. Use a deterministic value if you want terminal state and prompts to map to the same logical terminal.
- `apiKey`: WebContainer API key for environments that require one.
- `autostart`: boot automatically when visible and ready.
- `workdirName`: root directory name created inside the container.
- `boot.coep`: boot mode override for WebContainer startup.
- `boot.reuseBootInstance`: reuse an existing booted WebContainer instance when supported.

#### `files`

```ts
interface WebContainerTerminalFilesConfig {
  base: Record<string, string>;
  ready: boolean;
  baseLoadError?: string | null;
  live?: WebContainerTerminalLiveFile | null;
  syncToContainer?: {
    debounceMs?: number;
    enabled?: boolean;
  };
  importFromContainer?: {
    enabled?: boolean;
    includeLiveFile?: boolean;
    intervalMs?: number | false;
    maxDepth?: number;
    maxEntries?: number;
    maxFileBytes?: number;
    onDiff?: (
      diff: WebContainerTerminalFileDiff,
      context: WebContainerTerminalImportContext,
    ) => void | Promise<void>;
    registerHandler?: (
      handler: ((options?: WebContainerTerminalImportOptions) => Promise<WebContainerTerminalFileDiff | null>) | null,
    ) => void;
    shouldIncludePath?: (path: string) => boolean;
  };
}
```

- `base`: initial project file map mounted into the container.
- `ready`: gate terminal startup until base files are available.
- `baseLoadError`: optional error to surface if the file set could not be prepared.
- `live`: the currently edited file, kept in sync separately from the base snapshot.
- `syncToContainer`: controls debounced editor-to-container updates for `live`.
- `importFromContainer`: controls container-to-app diff import.

Supporting types:

```ts
interface WebContainerTerminalLiveFile {
  path: string;
  content: string;
}

interface WebContainerTerminalFileDiff {
  upserts: Record<string, string>;
  deletes: string[];
}

interface WebContainerTerminalImportOptions {
  silent?: boolean;
}

interface WebContainerTerminalImportContext {
  options?: WebContainerTerminalImportOptions;
  reason: 'interval' | 'manual' | 'restart' | 'unmount';
  sessionId: string;
}
```

Typical file sync model:

1. `base` mounts the initial workspace into the container.
2. `live` mirrors the active editor buffer into the container.
3. `importFromContainer.onDiff` persists shell edits back into app state.
4. `registerHandler` exposes a manual "import now" action to the host app.

#### `persistedHome`

```ts
type WebContainerTerminalPersistedHomeMode = 'off' | 'include' | 'exclude' | 'ask';

interface WebContainerTerminalPersistedHomeConfig {
  canConfigure?: boolean;
  mode?: WebContainerTerminalPersistedHomeMode;
  prompt?: WebContainerTerminalPersistedHomePrompt | null;
  watch?: boolean;
}

interface WebContainerTerminalPersistedHomePrompt {
  storageKey: string;
  target: 'gist' | 'repo' | 'workspace';
  title: string;
  message: string;
  note?: string | null;
  defaultMode: 'include' | 'exclude';
  trustResolved: boolean;
}
```

Use this when the host app needs to decide whether terminal home-directory state should be restored across sessions.

#### `panes`

```ts
interface WebContainerTerminalPanesConfig {
  initialSplit?: boolean;
  max?: 1 | 2;
}
```

Controls whether the session starts with one or two panes and whether split terminals are allowed.

#### `network`

```ts
interface WebContainerTerminalNetworkConfig {
  enabled?: boolean;
  upstreamProxyBaseUrl: string;
}
```

Enables the app's upstream proxy bridge for network requests from the container.

Set `network: false` to disable the bridge entirely.

#### `overlay`

```ts
interface WebContainerTerminalOverlayConfig {
  archiveUrl: string;
  enabled?: boolean;
}
```

Configures an overlay archive mounted into the container, typically for shared tooling or support files.

Set `overlay: false` to disable it.

#### `lifecycle`

```ts
interface WebContainerTerminalLifecycleConfig {
  importOnUnmount?: boolean;
  stopOnUnmount?: boolean;
}
```

- `importOnUnmount`: pull file changes out of the container during teardown.
- `stopOnUnmount`: stop terminal processes when the host unmounts or hides the terminal.

#### `shortcuts`

```ts
interface WebContainerTerminalShortcutsConfig {
  onToggleVisibility?: () => void | Promise<void>;
}
```

Lets the host app wire global keyboard behavior, such as toggling the terminal panel.

#### `diagnostics`

```ts
interface WebContainerTerminalDiagnosticsConfig {
  enablePerfLog?: boolean;
  onEvent?: (event: { detail?: Record<string, unknown>; type: string }) => void;
  onLog?: (line: string) => void;
}
```

Use this for runtime instrumentation, debugging, and performance logging.

### `useWebContainerTerminalController`

```ts
interface UseWebContainerTerminalControllerOptions {
  config: WebContainerTerminalConfig;
  dialogs?: Partial<WebContainerTerminalControllerDialogs> | null;
  visible: boolean;
  workspaceChangesPersisted?: boolean;
  workspaceChangesNotice?: string | null;
}
```

Dialog overrides:

```ts
interface WebContainerTerminalControllerDialogs {
  showAlert(message: string): Promise<void>;
  showPrompt(message: string, defaultValue?: string): Promise<string | null>;
}
```

If `dialogs` is omitted, the controller falls back to browser `alert` and `prompt` semantics. The prebuilt view also includes app-styled dialog flows for persistence prompts.

### `WebContainerTerminalController`

The hook returns controller state plus imperative actions. The main shape is:

```ts
interface WebContainerTerminalController {
  activePaneId: 'primary' | 'secondary';
  canDownloadFromWebContainer: boolean;
  canManageSplit: boolean;
  canResetTerminal: boolean;
  canRestartWebContainer: boolean;
  error: string | null;
  persistedHomePromptState: unknown;
  persistenceDialog: unknown;
  resetBannerPaneId: 'primary' | 'secondary' | null;
  resetBannerText: string | null;
  splitOpen: boolean;
  status: string;
  visiblePaneIds: Array<'primary' | 'secondary'>;
  workspaceNotice: string | null;
  actions: {
    closePersistenceDialog(): void;
    closePersistedHomePrompt(): void;
    closeSplitPane(position: 'top' | 'bottom'): void;
    downloadFromWebContainer(): Promise<void>;
    openPersistedHomeReconfigurePrompt(): void;
    openPersistenceDialog(): void;
    openSplitTerminal(): void;
    restartShell(): Promise<void>;
    restartWebContainer(): Promise<void>;
    selectPane(paneId: 'primary' | 'secondary'): void;
    setPaneContainer(paneId: 'primary' | 'secondary', node: HTMLElement | null): void;
    settlePersistedHomePrompt(restorePersistedHome: boolean): void;
  };
}
```

The key integration points are:

- render one container per `visiblePaneIds` entry
- attach each pane DOM node with `setPaneContainer`
- use `status`, `error`, and `workspaceNotice` to drive host UI
- call `restartShell`, `restartWebContainer`, and `downloadFromWebContainer` from your own controls

## What belongs in the module

The current extraction boundary is:

### Move with `core`

- WebContainer boot lifecycle
- shell process lifecycle
- xterm instance setup and disposal
- split-pane session management
- workspace file mounting and diff import/export
- persistence and home-directory decision state
- controller state and imperative actions
- config and type definitions

### Move with `view`

- `WebContainerTerminalView`
- `TerminalPersistenceDialog`
- the terminal toolbar/menu controls that are specific to the packaged UI

### Leave outside the module or make injectable later

- app-global styling
- generic dialog/menu primitives
- icons
- app-specific copy where that should become configurable
- app-specific network endpoint defaults

## Integration notes

- The core API is intentionally view-agnostic, but it is currently implemented as a Preact hook in this repo.
- React consumers should treat the controller shape as the stable concept and either use a compatibility layer or a future React adapter package.
- Terminal container nodes must have real size before xterm can lay out correctly.
- The host page still needs the browser environment required by WebContainer, including the right cross-origin isolation behavior.
- The view entrypoint is a convenience layer, not the long-term package boundary.

## Packaging direction

The likely package split is:

- `@input/terminal-core`: hook, controller, config, and runtime
- `@input/terminal-view-preact`: optional packaged UI

That keeps the transport and lifecycle logic reusable while allowing the view layer to evolve independently.
