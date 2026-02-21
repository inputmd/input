import { render } from 'preact';
import { App } from './app';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/700.css';
import './style.css';

render(<App />, document.getElementById('app')!);
