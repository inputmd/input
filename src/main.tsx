import { render } from 'preact';
import { App } from './app';
import { DialogProvider } from './components/DialogProvider';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/700.css';
import './style.css';

render(
  <DialogProvider>
    <App />
  </DialogProvider>,
  document.getElementById('app')!,
);
