export interface WebContainerHomeOverlayFile {
  path: string;
  contents: string;
  executable?: boolean;
}

export const WEBCONTAINER_HOME_OVERLAY_MANIFEST_PATH = '.input-webcontainer-home-overlay.json';

function normalizeWebContainerHomeOverlayPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('/')) {
    throw new Error(`WebContainer home overlay path must be relative to $HOME: ${path}`);
  }
  const normalized = trimmed;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('WebContainer home overlay paths must not be empty.');
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`WebContainer home overlay path must stay inside $HOME: ${path}`);
  }
  return segments.join('/');
}

export function buildWebContainerHomeOverlayBootstrapScript(files: readonly WebContainerHomeOverlayFile[]): string {
  const seenPaths = new Set<string>();
  const normalizedFiles = files.map((file) => {
    const path = normalizeWebContainerHomeOverlayPath(file.path);
    if (seenPaths.has(path)) {
      throw new Error(`Duplicate WebContainer home overlay path: ${path}`);
    }
    seenPaths.add(path);
    return {
      path,
      contents: file.contents,
      executable: file.executable === true,
    };
  });

  return [
    "const fs = require('fs');",
    "const path = require('path');",
    "const home = process.env.HOME || '';",
    "if (!home) throw new Error('HOME is not set');",
    `const manifestPath = path.join(home, ${JSON.stringify(WEBCONTAINER_HOME_OVERLAY_MANIFEST_PATH)});`,
    `const files = ${JSON.stringify(normalizedFiles)};`,
    'let previousPaths = [];',
    'try {',
    "  const previousValue = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));",
    "  previousPaths = Array.isArray(previousValue) ? previousValue.filter((value) => typeof value === 'string') : [];",
    '} catch {}',
    'const nextPaths = new Set(files.map((file) => file.path));',
    'for (const relativePath of previousPaths) {',
    '  if (nextPaths.has(relativePath)) continue;',
    '  try {',
    '    fs.rmSync(path.join(home, relativePath), { force: true, recursive: true });',
    '  } catch {}',
    '}',
    'for (const file of files) {',
    '  const target = path.join(home, file.path);',
    '  fs.mkdirSync(path.dirname(target), { recursive: true });',
    "  fs.writeFileSync(target, file.contents, 'utf8');",
    '  fs.chmodSync(target, file.executable ? 0o755 : 0o644);',
    '}',
    "fs.writeFileSync(manifestPath, JSON.stringify(files.map((file) => file.path), null, 2) + '\\n', 'utf8');",
  ].join(' ');
}
