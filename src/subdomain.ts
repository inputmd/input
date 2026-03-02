let cachedOwner: string | null | undefined;

export function getSubdomainOwner(): string | null {
  if (cachedOwner === undefined) {
    cachedOwner = document.querySelector<HTMLMetaElement>('meta[name="subdomain-owner"]')?.content ?? null;
  }
  return cachedOwner;
}

export function isSubdomainMode(): boolean {
  return getSubdomainOwner() !== null;
}
