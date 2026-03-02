import { render } from 'preact';
import { App } from './app';
import { DialogProvider } from './components/DialogProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/ToastProvider';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/700.css';
import '@fontsource-variable/inter/index.css';
import './styles/base.css';
import './styles/toolbar.css';
import './styles/sidebar.css';
import './styles/editor.css';
import './styles/markdown.css';
import './styles/documents.css';
import './styles/dialog.css';

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
