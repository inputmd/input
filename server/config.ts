import crypto from 'node:crypto';

export const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);

export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
export const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
export const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours

export const GITHUB_FETCH_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

export const ALLOWED_ORIGINS = new Set(['https://input.md', 'http://localhost:5173', 'http://localhost:5174']);

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'sha256-wBdtWdXsHnAU2DdByySW4LlXFAScrBvmBgkXtydwJdg='; style-src 'self' 'unsafe-inline'; img-src 'self' https://avatars.githubusercontent.com; connect-src 'self' https://api.github.com https://gist.githubusercontent.com; font-src 'self'";
