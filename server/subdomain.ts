const PROTECTED_SUBDOMAINS = new Set([
  'www',
  'api',
  'app',
  'mail',
  'ftp',
  'admin',
  'blog',
  'docs',
  'status',
  'cdn',
  'staging',
  'dev',
]);

/**
 * Extract a username subdomain from the Host header.
 * Returns the subdomain if it's a single-level, non-protected subdomain of
 * input.md (production) or localhost (development). Returns null otherwise.
 */
export function extractSubdomain(host: string | undefined): string | null {
  if (!host) return null;

  // Strip port
  const hostname = host.split(':')[0].toLowerCase();

  // Production: <username>.input.md
  if (hostname.endsWith('.input.md')) {
    const sub = hostname.slice(0, -'.input.md'.length);
    if (sub && !sub.includes('.') && !PROTECTED_SUBDOMAINS.has(sub)) {
      return sub;
    }
    return null;
  }

  // Development: <username>.localhost
  if (hostname.endsWith('.localhost')) {
    const sub = hostname.slice(0, -'.localhost'.length);
    if (sub && !sub.includes('.') && !PROTECTED_SUBDOMAINS.has(sub)) {
      return sub;
    }
    return null;
  }

  return null;
}

export function stripManagedSubdomain(host: string | undefined): string | null {
  if (!host) return null;

  const [rawHostname, rawPort] = host.split(':');
  if (!rawHostname) return null;

  const hostname = rawHostname.toLowerCase();
  const portSuffix = rawPort ? `:${rawPort}` : '';

  if (hostname.endsWith('.input.md')) {
    const sub = hostname.slice(0, -'.input.md'.length);
    if (sub && !sub.includes('.') && !PROTECTED_SUBDOMAINS.has(sub)) {
      return `input.md${portSuffix}`;
    }
    return null;
  }

  if (hostname.endsWith('.localhost')) {
    const sub = hostname.slice(0, -'.localhost'.length);
    if (sub && !sub.includes('.') && !PROTECTED_SUBDOMAINS.has(sub)) {
      return `localhost${portSuffix}`;
    }
    return null;
  }

  return null;
}
