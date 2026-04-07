const PROMPT_LIST_COLLAPSED_QUERY_PARAM = 'plc';
const SVG_NS = 'http://www.w3.org/2000/svg';

interface TogglePromptAnswerExpandedOptions {
  behavior?: ScrollBehavior;
  keepTopInViewOnCollapse?: boolean;
}

interface SetPromptListCollapsedStateOptions {
  syncAnswers?: boolean;
}

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

export function setPromptListCollapsedState(
  container: HTMLElement,
  collapsed: boolean,
  options?: SetPromptListCollapsedStateOptions,
) {
  container.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
  const toggle = container.querySelector<HTMLElement>('.prompt-list-caption');
  if (toggle) {
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const action = toggle.querySelector<HTMLElement>('.prompt-list-caption-action');
    if (action) action.textContent = collapsed ? 'Expand' : 'Collapse';
  }
  if (options?.syncAnswers === false) return;
  container.querySelectorAll<HTMLElement>('li.prompt-answer').forEach((answer) => {
    setPromptAnswerExpandedState(answer, !collapsed);
  });
}

export function setPromptAnswerExpandedState(container: HTMLElement, expanded: boolean) {
  container.setAttribute('data-expanded', expanded ? 'true' : 'false');

  const toggle = container.querySelector<HTMLElement>('.prompt-answer-toggle');
  const hideExpandedToggle = shouldHideExpandedPromptAnswerToggle(container);
  if (toggle) {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.setAttribute('aria-label', expanded ? 'Less' : 'More');
    renderPromptAnswerToggleContent(toggle, expanded, hideExpandedToggle);
    toggle.hidden = expanded && hideExpandedToggle;
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

function renderPromptAnswerToggleContent(toggle: HTMLElement, expanded: boolean, hideExpandedToggle = false) {
  toggle.replaceChildren();
  if (expanded) {
    if (hideExpandedToggle) return;
    toggle.textContent = 'Less';
    return;
  }

  const badge = toggle.ownerDocument.createElement('span');
  badge.className = 'prompt-answer-toggle-badge';
  badge.setAttribute('aria-hidden', 'true');

  const icon = toggle.ownerDocument.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '14');
  icon.setAttribute('height', '14');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');

  for (const cx of ['5', '12', '19']) {
    const circle = toggle.ownerDocument.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '1');
    icon.appendChild(circle);
  }

  badge.appendChild(icon);
  toggle.appendChild(badge);
}

function shouldHideExpandedPromptAnswerToggle(container: HTMLElement): boolean {
  return container.closest<HTMLElement>('.rendered-markdown')?.dataset.hidePromptAnswerLess === 'true';
}

function getPromptListConversationHeaderGap(target: HTMLElement): number {
  const conversation = target.closest<HTMLElement>('.prompt-list-conversation');
  const header = conversation?.querySelector<HTMLElement>('.prompt-list-header');
  return Math.round((header?.offsetHeight ?? 0) * 1.5);
}

function isScrollablePromptListContainer(container: HTMLElement): boolean {
  const view = container.ownerDocument.defaultView;
  if (!view) return false;
  const styles = view.getComputedStyle(container);
  const overflowY = styles.overflowY || styles.overflow;
  if (!/(auto|scroll|overlay)/.test(overflowY)) return false;
  return container.scrollHeight > container.clientHeight;
}

function getPromptListScrollContainer(target: HTMLElement): HTMLElement | null {
  for (const selector of [
    '.editor-preview-pane',
    '.mobile-preview-pane',
    '.content',
    '.document-stack-layer-content',
  ]) {
    const container = target.closest<HTMLElement>(selector);
    if (container && isScrollablePromptListContainer(container)) return container;
  }
  return null;
}

function getFixedToolbarHeight(document: Document): number {
  const toolbar = document.querySelector<HTMLElement>('.toolbar');
  if (toolbar) return toolbar.offsetHeight;

  const view = document.defaultView;
  if (!view) return 0;
  const raw = view.getComputedStyle(document.documentElement).getPropertyValue('--toolbar-height').trim();
  const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(raw);
  if (match) return Number.parseFloat(match[1] ?? '0');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scrollPromptAnswerTopIntoView(container: HTMLElement, behavior: ScrollBehavior = 'auto') {
  const headerGap = getPromptListConversationHeaderGap(container);
  const scrollContainer = getPromptListScrollContainer(container);
  if (scrollContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetRect = container.getBoundingClientRect();
    const offsetTop = targetRect.top - containerRect.top + scrollContainer.scrollTop;
    scrollContainer.scrollTo({ top: Math.max(0, offsetTop - headerGap), behavior });
    return;
  }

  const view = container.ownerDocument.defaultView;
  if (!view) return;
  const targetTop = container.getBoundingClientRect().top + view.scrollY;
  const toolbarHeight = getFixedToolbarHeight(container.ownerDocument);
  view.scrollTo({ top: Math.max(0, targetTop - toolbarHeight - headerGap), behavior });
}

export function togglePromptAnswerExpandedState(container: HTMLElement, options?: TogglePromptAnswerExpandedOptions) {
  const expanded = container.getAttribute('data-expanded') === 'true';
  const nextExpanded = !expanded;
  setPromptAnswerExpandedState(container, nextExpanded);

  if (expanded && !nextExpanded && options?.keepTopInViewOnCollapse) {
    scrollPromptAnswerTopIntoView(container, options.behavior);
  }
}

function isPromptListMessage(element: Element | null): element is HTMLElement {
  return Boolean(
    element &&
      element instanceof HTMLElement &&
      (element.matches('li.prompt-question') ||
        element.matches('li.prompt-answer') ||
        element.matches('li.prompt-comment')),
  );
}

function findPromptListBranchNavigationTarget(branch: HTMLElement, direction: 'up' | 'down'): HTMLElement | null {
  let sibling = direction === 'up' ? branch.previousElementSibling : branch.nextElementSibling;
  while (sibling) {
    if (isPromptListMessage(sibling)) return sibling;
    sibling = direction === 'up' ? sibling.previousElementSibling : sibling.nextElementSibling;
  }
  return null;
}

export function syncPromptListBranchNavigationButtons(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('.prompt-list-branch').forEach((branch) => {
    branch.querySelectorAll<HTMLElement>(':scope > .prompt-list-branch-nav').forEach((button) => {
      const direction = button.getAttribute('data-direction') === 'up' ? 'up' : 'down';
      const target = findPromptListBranchNavigationTarget(branch, direction);
      button.hidden = !target;
      button.tabIndex = target ? 0 : -1;
      button.setAttribute('aria-hidden', target ? 'false' : 'true');
    });
  });
}

export function navigatePromptListBranch(button: HTMLElement, options?: { behavior?: ScrollBehavior }) {
  const branch = button.closest<HTMLElement>('li.prompt-list-branch');
  if (!branch) return false;

  const direction = button.getAttribute('data-direction') === 'up' ? 'up' : 'down';
  const target = findPromptListBranchNavigationTarget(branch, direction);
  if (!target) return false;

  const headerGap = getPromptListConversationHeaderGap(target);
  const directionGap = direction === 'down' ? 10 : 0;
  const scrollContainer = getPromptListScrollContainer(target);
  if (scrollContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offsetTop = targetRect.top - containerRect.top + scrollContainer.scrollTop;
    const nextScrollTop = Math.max(0, offsetTop - headerGap - directionGap);
    scrollContainer.scrollTo({ top: nextScrollTop, behavior: options?.behavior ?? 'smooth' });
    return true;
  }

  const view = target.ownerDocument.defaultView;
  if (!view) return false;
  const targetTop = target.getBoundingClientRect().top + view.scrollY;
  const toolbarHeight = getFixedToolbarHeight(target.ownerDocument);
  view.scrollTo({
    top: Math.max(0, targetTop - toolbarHeight - headerGap - directionGap),
    behavior: options?.behavior ?? 'smooth',
  });
  return true;
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
  if (expanded && toggle.hidden) return;

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

function writeCollapsedPromptListIdsToLocation(collapsedIds: Set<string>) {
  const url = new URL(window.location.href);
  if (collapsedIds.size === 0) {
    url.searchParams.delete(PROMPT_LIST_COLLAPSED_QUERY_PARAM);
  } else {
    url.searchParams.set(PROMPT_LIST_COLLAPSED_QUERY_PARAM, Array.from(collapsedIds).sort().join('.'));
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function syncPromptListCollapsedStateFromUrl(root: ParentNode, defaultCollapsed = false) {
  const collapsedIds = readCollapsedPromptListIdsFromLocation();
  root.querySelectorAll<HTMLElement>('.prompt-list-conversation[data-prompt-list-id]').forEach((container) => {
    const id = container.getAttribute('data-prompt-list-id')?.trim() ?? '';
    setPromptListCollapsedState(container, defaultCollapsed || (id !== '' && collapsedIds.has(id)));
  });
}

export function setPromptListCollapsedStateInUrl(
  container: HTMLElement,
  collapsed: boolean,
  defaultCollapsed = false,
  options?: SetPromptListCollapsedStateOptions,
) {
  if (defaultCollapsed) {
    setPromptListCollapsedState(container, collapsed, options);
    return;
  }

  const collapsedIds = readCollapsedPromptListIdsFromLocation();
  const id = container.getAttribute('data-prompt-list-id')?.trim() ?? '';
  if (!id) {
    setPromptListCollapsedState(container, collapsed, options);
    return;
  }

  if (collapsed) collapsedIds.add(id);
  else collapsedIds.delete(id);

  writeCollapsedPromptListIdsToLocation(collapsedIds);
  setPromptListCollapsedState(container, collapsed, options);
}

export function togglePromptListCollapsedStateInUrl(container: HTMLElement, defaultCollapsed = false) {
  const nextCollapsed = container.getAttribute('data-collapsed') !== 'true';
  setPromptListCollapsedStateInUrl(container, nextCollapsed, defaultCollapsed);
}
