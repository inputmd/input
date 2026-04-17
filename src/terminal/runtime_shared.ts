import type { WebContainer } from '@webcontainer/api';
import type { Ghostty, Terminal as GhosttyTerminal } from 'ghostty-web';
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url';

const HOT_RELOAD_UNMOUNT_IMPORT_GUARD_WINDOW_MS = 2000;
const TERMINAL_SCROLLBAR_RESERVATION_PX = 15;
const TERMINAL_MIN_COLS = 2;
const TERMINAL_MIN_ROWS = 1;

export type TerminalThemeMode = 'dark' | 'light';

interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  selectionForeground: string;
}

const TERMINAL_THEME_BY_MODE: Record<TerminalThemeMode, TerminalTheme> = {
  dark: {
    background: '#0b0b0b',
    foreground: '#e6edf3',
    cursor: '#e6edf3',
    selectionBackground: '#1a4a32',
    selectionForeground: '#eef5f0',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#1f2328',
    selectionBackground: '#2a7d4f',
    selectionForeground: '#ffffff',
  },
};

interface TerminalGlobalState {
  ghosttyLoadPromise: Promise<Ghostty> | null;
  ghosttyModulePromise: Promise<typeof import('ghostty-web')> | null;
  lastHotReloadAt: number;
  webContainerApiModulePromise: Promise<typeof import('@webcontainer/api')> | null;
  webContainerBootCoep: 'credentialless' | 'none' | null;
  webContainerConfiguredApiKey: string | null;
  webContainerBootPromise: Promise<WebContainer> | null;
  webContainerBootWorkdirName: string | null;
}

type TerminalGlobalThis = typeof globalThis & {
  __inputTerminalGlobalState__?: TerminalGlobalState;
};

function getTerminalGlobalState(): TerminalGlobalState {
  const root = globalThis as TerminalGlobalThis;
  root.__inputTerminalGlobalState__ ??= {
    ghosttyLoadPromise: null,
    ghosttyModulePromise: null,
    lastHotReloadAt: 0,
    webContainerApiModulePromise: null,
    webContainerBootCoep: null,
    webContainerConfiguredApiKey: null,
    webContainerBootPromise: null,
    webContainerBootWorkdirName: null,
  };
  return root.__inputTerminalGlobalState__;
}

export function resetBootWebContainerState(): void {
  const globalState = getTerminalGlobalState();
  globalState.webContainerBootCoep = null;
  globalState.webContainerBootPromise = null;
  globalState.webContainerBootWorkdirName = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    getTerminalGlobalState().lastHotReloadAt = Date.now();
  });
}

export function getDocumentThemeMode(): TerminalThemeMode {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function getTerminalTheme(mode: TerminalThemeMode): TerminalTheme {
  return { ...TERMINAL_THEME_BY_MODE[mode] };
}

export function didRecentHotReload(): boolean {
  return Date.now() - getTerminalGlobalState().lastHotReloadAt <= HOT_RELOAD_UNMOUNT_IMPORT_GUARD_WINDOW_MS;
}

export function isLocalhostHostname(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

async function loadWebContainerApi(): Promise<typeof import('@webcontainer/api')> {
  const globalState = getTerminalGlobalState();
  if (!globalState.webContainerApiModulePromise) {
    globalState.webContainerApiModulePromise = import('@webcontainer/api');
  }
  return await globalState.webContainerApiModulePromise;
}

export async function ensureWebContainerApiConfigured(
  apiKey: string | undefined,
): Promise<typeof import('@webcontainer/api')> {
  const webContainerApi = await loadWebContainerApi();
  if (isLocalhostHostname()) {
    return webContainerApi;
  }
  if (!apiKey) {
    throw new Error('VITE_WEBCONTAINERS_API_KEY is not set.');
  }
  const globalState = getTerminalGlobalState();
  if (globalState.webContainerConfiguredApiKey === apiKey) {
    return webContainerApi;
  }
  webContainerApi.configureAPIKey(apiKey);
  globalState.webContainerConfiguredApiKey = apiKey;
  return webContainerApi;
}

export async function bootWebContainer(
  apiKey: string | undefined,
  workdirName: string,
  options?: {
    coep?: 'credentialless' | 'none';
    reuseBootInstance?: boolean;
  },
): Promise<WebContainer> {
  const { WebContainer } = await ensureWebContainerApiConfigured(apiKey);
  const globalState = getTerminalGlobalState();
  const coep = options?.coep ?? 'credentialless';
  const reuseBootInstance = options?.reuseBootInstance ?? true;
  if (
    reuseBootInstance &&
    globalState.webContainerBootPromise &&
    globalState.webContainerBootWorkdirName === workdirName &&
    globalState.webContainerBootCoep === coep
  ) {
    return globalState.webContainerBootPromise;
  }
  if (
    globalState.webContainerBootPromise &&
    (!reuseBootInstance ||
      globalState.webContainerBootWorkdirName !== workdirName ||
      globalState.webContainerBootCoep !== coep)
  ) {
    try {
      const wc = await globalState.webContainerBootPromise;
      wc.teardown();
    } catch {
      // ignore boot/teardown failures and attempt a clean reboot below
    } finally {
      resetBootWebContainerState();
    }
  }
  globalState.webContainerBootPromise = (async () => {
    if (coep === 'none') {
      return WebContainer.boot({ workdirName });
    }
    return WebContainer.boot({ coep, workdirName });
  })();
  globalState.webContainerBootCoep = coep;
  globalState.webContainerBootWorkdirName = workdirName;
  try {
    return await globalState.webContainerBootPromise;
  } catch (err) {
    resetBootWebContainerState();
    throw err;
  }
}

export async function loadGhosttyWeb() {
  const globalState = getTerminalGlobalState();
  const module = await (globalState.ghosttyModulePromise ??= import('ghostty-web'));
  if (!globalState.ghosttyLoadPromise) {
    globalState.ghosttyLoadPromise = module.Ghostty.load(ghosttyWasmUrl).catch((err) => {
      globalState.ghosttyLoadPromise = null;
      throw err;
    });
  }
  return {
    Terminal: module.Terminal,
    ghostty: await globalState.ghosttyLoadPromise,
  };
}

export function waitForNextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export function fitTerminal(terminal: GhosttyTerminal, container: HTMLElement): void {
  const metrics = terminal.renderer?.getMetrics?.();
  if (!metrics || metrics.width === 0 || metrics.height === 0) return;
  const styles = window.getComputedStyle(container);
  const paddingTop = Number.parseInt(styles.getPropertyValue('padding-top'), 10) || 0;
  const paddingBottom = Number.parseInt(styles.getPropertyValue('padding-bottom'), 10) || 0;
  const paddingLeft = Number.parseInt(styles.getPropertyValue('padding-left'), 10) || 0;
  const paddingRight = Number.parseInt(styles.getPropertyValue('padding-right'), 10) || 0;
  const innerWidth = container.clientWidth - paddingLeft - paddingRight - TERMINAL_SCROLLBAR_RESERVATION_PX;
  const innerHeight = container.clientHeight - paddingTop - paddingBottom;
  if (innerWidth <= 0 || innerHeight <= 0) return;
  const cols = Math.max(TERMINAL_MIN_COLS, Math.floor(innerWidth / metrics.width));
  const rows = Math.max(TERMINAL_MIN_ROWS, Math.floor(innerHeight / metrics.height));
  if (cols === terminal.cols && rows === terminal.rows) return;
  if (terminal.hasSelection()) {
    terminal.clearSelection();
  }
  terminal.resize(cols, rows);
}
