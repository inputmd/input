export const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const clientPort = Number.parseInt(process.env.CLIENT_PORT ?? '5173', 10);
export const CLIENT_PORT = Number.isFinite(clientPort) && clientPort > 0 ? clientPort : 5173;
const appUrlRaw = process.env.APP_URL?.trim() ?? '';
export const APP_URL = appUrlRaw ? appUrlRaw.replace(/\/+$/, '') : '';

export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60; // 2 weeks
export const SESSION_MAX_LIFETIME_SECONDS = 14 * 24 * 60 * 60; // 2 weeks
export const DATABASE_PATH = process.env.DATABASE_PATH ?? './.data/input.db';

export const GITHUB_FETCH_TIMEOUT_MS = 15_000;
export const READER_AI_TIMEOUT_MS = 360_000;
// Allow base64 payloads for file uploads (5 MB raw → ~6.7 MB base64 + JSON overhead).
export const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
export const SHARE_TOKEN_SECRET = process.env.SHARE_TOKEN_SECRET ?? '';
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? '';
export const OPENROUTER_PAID_API_KEY = process.env.OPENROUTER_PAID_API_KEY ?? '';
const shareTokenTtlSecondsRaw = Number.parseInt(process.env.SHARE_TOKEN_TTL_SECONDS ?? '604800', 10);
export const SHARE_TOKEN_TTL_SECONDS =
  Number.isFinite(shareTokenTtlSecondsRaw) && shareTokenTtlSecondsRaw > 0 ? shareTokenTtlSecondsRaw : 604800;

const STATIC_ORIGINS = new Set(['https://input.md', `http://localhost:${CLIENT_PORT}`]);

export function isAllowedOrigin(origin: string): boolean {
  if (STATIC_ORIGINS.has(origin)) return true;

  // Allow https://<sub>.input.md
  try {
    const url = new URL(origin);
    if (
      url.protocol === 'https:' &&
      url.hostname.endsWith('.input.md') &&
      !url.hostname.slice(0, -'.input.md'.length).includes('.')
    ) {
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
  "default-src 'self'; script-src 'self' 'sha256-wBdtWdXsHnAU2DdByySW4LlXFAScrBvmBgkXtydwJdg=' https://*.webcontainer-api.io https://*.staticblitz.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; connect-src 'self' https://api.github.com https://gist.githubusercontent.com http://127.0.0.1:8788 http://localhost:8788 https://*.webcontainer-api.io https://*.staticblitz.com wss://*.webcontainer-api.io; font-src 'self' https:; worker-src 'self' blob:; frame-src 'self' https://*.webcontainer-api.io https://*.staticblitz.com";
