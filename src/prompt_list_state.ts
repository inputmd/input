const PROMPT_LIST_COLLAPSED_QUERY_PARAM = 'plc';

export function normalizePromptListIdentifierText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hashPromptListIdentifierText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function setPromptListCollapsedState(container: HTMLElement, collapsed: boolean) {
  container.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
  const toggle = container.querySelector<HTMLButtonElement>('.prompt-list-toggle');
  if (!toggle) return;
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggle.textContent = collapsed ? 'Expand' : 'Collapse';
}

function readCollapsedPromptListIdsFromLocation(): Set<string> {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(PROMPT_LIST_COLLAPSED_QUERY_PARAM)?.trim() ?? '';
  if (!raw) return new Set();
  return new Set(
    raw
      .split('.')
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function writeCollapsedPromptListIdsToLocation(ids: Set<string>) {
  const url = new URL(window.location.href);
  if (ids.size === 0) {
    url.searchParams.delete(PROMPT_LIST_COLLAPSED_QUERY_PARAM);
  } else {
    url.searchParams.set(PROMPT_LIST_COLLAPSED_QUERY_PARAM, Array.from(ids).sort().join('.'));
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function syncPromptListCollapsedStateFromUrl(root: ParentNode) {
  const collapsedIds = readCollapsedPromptListIdsFromLocation();
  root.querySelectorAll<HTMLElement>('.prompt-list-conversation[data-prompt-list-id]').forEach((container) => {
    const id = container.getAttribute('data-prompt-list-id')?.trim() ?? '';
    setPromptListCollapsedState(container, id !== '' && collapsedIds.has(id));
  });
}

export function togglePromptListCollapsedStateInUrl(container: HTMLElement) {
  const id = container.getAttribute('data-prompt-list-id')?.trim() ?? '';
  if (!id) return;

  const collapsedIds = readCollapsedPromptListIdsFromLocation();
  const nextCollapsed = !collapsedIds.has(id);
  if (nextCollapsed) {
    collapsedIds.add(id);
  } else {
    collapsedIds.delete(id);
  }
  writeCollapsedPromptListIdsToLocation(collapsedIds);
  setPromptListCollapsedState(container, nextCollapsed);
}
