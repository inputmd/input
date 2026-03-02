export const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const clientPort = Number.parseInt(process.env.CLIENT_PORT ?? '5173', 10);
export const CLIENT_PORT = Number.isFinite(clientPort) && clientPort > 0 ? clientPort : 5173;
const appUrlRaw = process.env.APP_URL?.trim() ?? '';
export const APP_URL = appUrlRaw ? appUrlRaw.replace(/\/+$/, '') : '';

export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
export const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours
export const SESSION_MAX_LIFETIME_SECONDS = 14 * 24 * 60 * 60; // 2 weeks
export const DATABASE_PATH = process.env.DATABASE_PATH ?? './.data/input.db';

export const GITHUB_FETCH_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

const STATIC_ORIGINS = new Set(['https://input.md', `http://localhost:${CLIENT_PORT}`]);

export function isAllowedOrigin(origin: string): boolean {
  if (STATIC_ORIGINS.has(origin)) return true;

  // Allow https://<sub>.input.md
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:' && url.hostname.endsWith('.input.md') && !url.hostname.slice(0, -'.input.md'.length).includes('.')) {
      return true;
    }
    // Dev: http://<sub>.localhost:<port>
    if (url.protocol === 'http:' && url.hostname.endsWith('.localhost')) {
      return true;
    }
  } catch {
    // malformed origin
  }

  return false;
}

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'sha256-wBdtWdXsHnAU2DdByySW4LlXFAScrBvmBgkXtydwJdg='; style-src 'self' 'unsafe-inline'; img-src 'self' https://avatars.githubusercontent.com; connect-src 'self' https://api.github.com https://gist.githubusercontent.com; font-src 'self'";
