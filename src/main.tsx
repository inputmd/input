import { render } from 'preact';
import { App } from './app';
import { DialogProvider } from './components/DialogProvider';
import { ToastProvider } from './components/ToastProvider';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/700.css';
import './style.css';

render(
  <DialogProvider>
    <ToastProvider>
      <App />
    </ToastProvider>
  </DialogProvider>,
  document.getElementById('app')!,
);
