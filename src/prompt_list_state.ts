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
  const toggle = container.querySelector<HTMLElement>('.prompt-list-caption');
  if (!toggle) return;
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

export function setPromptAnswerExpandedState(container: HTMLElement, expanded: boolean) {
  container.setAttribute('data-expanded', expanded ? 'true' : 'false');

  const toggle = container.querySelector<HTMLElement>('.prompt-answer-toggle');
  if (toggle) {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.textContent = expanded ? 'Show less' : 'Show more';
  }

  const rest = container.querySelector<HTMLElement>('.prompt-answer-rest');
  if (rest) {
    rest.hidden = !expanded;
  }

  const inlineRest = container.querySelector<HTMLElement>('.prompt-answer-inline-rest');
  if (inlineRest) {
    inlineRest.hidden = !expanded;
  }

  const preview = container.querySelector<HTMLElement>('.prompt-answer-preview');
  if (preview) {
    syncPromptAnswerPreviewEnding(preview, expanded);
  }

  if (toggle) {
    syncPromptAnswerTogglePlacement(container, toggle, expanded);
  }
}

export function togglePromptAnswerExpandedState(container: HTMLElement) {
  const expanded = container.getAttribute('data-expanded') === 'true';
  setPromptAnswerExpandedState(container, !expanded);
}

function promptAnswerPreviewTextNodeAtPath(root: Node, path: string): Text | null {
  if (!path) return null;

  let node: Node = root;
  for (const segment of path.split('/')) {
    const index = Number.parseInt(segment, 10);
    if (!Number.isFinite(index) || index < 0) return null;
    const next = node.childNodes.item(index);
    if (!next) return null;
    node = next;
  }

  return node instanceof Text ? node : null;
}

function syncPromptAnswerPreviewEnding(preview: HTMLElement, expanded: boolean) {
  const originalText = preview.getAttribute('data-preview-tail-original') ?? '';
  const collapsedText = preview.getAttribute('data-preview-tail-collapsed') ?? '';
  const path = preview.getAttribute('data-preview-tail-path') ?? '';
  if (!originalText || !collapsedText || !path) return;

  const textNode = promptAnswerPreviewTextNodeAtPath(preview, path);
  if (!textNode) return;
  textNode.textContent = expanded ? originalText : collapsedText;
}

function syncPromptAnswerTogglePlacement(container: HTMLElement, toggle: HTMLElement, expanded: boolean) {
  const preview = container.querySelector<HTMLElement>('.prompt-answer-preview');
  const previewParagraph = preview?.closest('p');
  const inlineRest = container.querySelector<HTMLElement>('.prompt-answer-inline-rest');

  if (!expanded) {
    if (!previewParagraph || !preview) return;
    if (inlineRest) {
      previewParagraph.append(preview, inlineRest, ' ', toggle);
    } else {
      previewParagraph.append(preview, ' ', toggle);
    }
    return;
  }

  const paragraphs = Array.from(container.querySelectorAll<HTMLElement>('p'));
  const lastParagraph = paragraphs.at(-1);
  if (!lastParagraph) return;
  lastParagraph.append(' ', toggle);
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
