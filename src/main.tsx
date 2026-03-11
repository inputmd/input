import { render } from 'preact';
import { App } from './app';
import { DialogProvider } from './components/DialogProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/ToastProvider';
import { SandboxesApp } from './sandboxes/App';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/700.css';
import '@fontsource-variable/inter/index.css';
import './styles/base.css';
import './styles/toolbar.css';
import './styles/sidebar.css';
import './styles/editor.css';
import './styles/codemirror.css';
import './styles/markdown.css';
import './styles/reader_ai.css';
import './styles/documents.css';
import './styles/dialog.css';

const isSandboxesPath = window.location.pathname.startsWith('/sandboxes/');

// Bare /sandboxes has no repo context — redirect to workspaces where Sandbox buttons live
if (window.location.pathname === '/sandboxes' || window.location.pathname === '/sandboxes/') {
  window.location.replace('/workspaces');
} else if (isSandboxesPath) {
  render(
    <ErrorBoundary fallbackMessage="The sandboxes app failed to load.">
      <SandboxesApp />
    </ErrorBoundary>,
    document.getElementById('app')!,
  );
} else {
  render(
    <ErrorBoundary fallbackMessage="The app failed to load.">
      <DialogProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </DialogProvider>
    </ErrorBoundary>,
    document.getElementById('app')!,
  );
}
