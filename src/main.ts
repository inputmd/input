import { parseAnsiToHtml } from './ansi';
import './style.css';

let renderedHtml = '';

function extractGistId(input: string): string | null {
  input = input.trim();
  if (/^[a-f0-9]+$/i.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname === 'gist.github.com' || url.hostname === 'gist.githubusercontent.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      // /user/id or /id — the id is always the last hex-looking segment
      for (let i = parts.length - 1; i >= 0; i--) {
        if (/^[a-f0-9]+$/i.test(parts[i])) return parts[i];
      }
    }
  } catch { /* not a url */ }
  return null;
}

async function fetchGistContent(id: string): Promise<string> {
  const res = await fetch(`https://api.github.com/gists/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch gist: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const files = Object.values(data.files) as Array<{ content: string | null; raw_url: string }>;
  const contents: string[] = [];
  for (const file of files) {
    if (file.content != null) {
      contents.push(file.content);
    } else {
      const raw = await fetch(file.raw_url);
      if (raw.ok) contents.push(await raw.text());
    }
  }
  return contents.join('\n\n');
}

type View = 'input' | 'loading' | 'error' | 'content' | 'edit';

function showView(name: View) {
  for (const v of ['input', 'loading', 'error', 'content', 'edit'] as const) {
    document.getElementById(`${v}-view`)!.style.display = v === name ? '' : 'none';
  }
  document.getElementById('edit-btn')!.style.display = name === 'content' ? '' : 'none';
  document.getElementById('save-btn')!.style.display = name === 'edit' ? '' : 'none';
  document.getElementById('cancel-btn')!.style.display = name === 'edit' ? '' : 'none';
}

async function loadGist(id: string) {
  showView('loading');
  try {
    const content = await fetchGistContent(id);
    renderedHtml = parseAnsiToHtml(content);
    document.getElementById('rendered-content')!.innerHTML = renderedHtml;
    showView('content');
  } catch (err) {
    document.getElementById('error-message')!.textContent =
      err instanceof Error ? err.message : 'Unknown error';
    showView('error');
  }
}

function toggleTheme() {
  const root = document.documentElement;
  const isDark = root.getAttribute('data-theme') !== 'light';
  root.setAttribute('data-theme', isDark ? 'light' : 'dark');
  document.getElementById('theme-icon')!.textContent = isDark ? '\u263D' : '\u2600';
}

function enterEditMode() {
  const editor = document.getElementById('editor')!;
  editor.innerHTML = renderedHtml;
  showView('edit');
  editor.focus();
}

function exitEditMode() {
  showView('content');
}

function init() {
  document.documentElement.setAttribute('data-theme', 'dark');

  document.getElementById('theme-toggle')!.addEventListener('click', toggleTheme);

  document.getElementById('gist-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('gist-url') as HTMLInputElement;
    const id = extractGistId(input.value);
    if (id) {
      window.location.hash = id;
      loadGist(id);
    }
  });

  document.getElementById('edit-btn')!.addEventListener('click', enterEditMode);
  document.getElementById('save-btn')!.addEventListener('click', exitEditMode);
  document.getElementById('cancel-btn')!.addEventListener('click', () => {
    if (confirm('Discard changes?')) exitEditMode();
  });

  document.getElementById('retry-btn')!.addEventListener('click', () => {
    const hash = window.location.hash.slice(1);
    const id = hash ? extractGistId(decodeURIComponent(hash)) : null;
    if (id) loadGist(id);
    else showView('input');
  });

  // Load gist from URL hash on startup
  const hash = window.location.hash.slice(1);
  if (hash) {
    const id = extractGistId(decodeURIComponent(hash));
    if (id) loadGist(id);
  }
}

init();
