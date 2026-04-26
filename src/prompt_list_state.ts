const SUPPRESS_NEXT_PROMPT_ANSWER_TOGGLE_ATTR = 'data-suppress-next-prompt-answer-toggle';
const PROMPT_ANSWER_STATE_KEY_SEPARATOR = ':';

interface TogglePromptAnswerExpandedOptions {
  behavior?: ScrollBehavior;
  keepTopInViewOnCollapse?: boolean;
}

interface SetPromptListCollapsedStateOptions {
  syncAnswers?: boolean;
}

export type PromptListMode = 'collapse-all' | 'collapse-responses' | 'expand-all';
export type PromptAnswerExpandedStateSnapshot = Map<string, boolean>;
export type PromptListCollapsedStateSnapshot = Map<string, PromptListMode>;

const DEFAULT_PROMPT_LIST_MODE: PromptListMode = 'collapse-responses';

function normalizePromptListMode(value: unknown, fallback: PromptListMode = DEFAULT_PROMPT_LIST_MODE): PromptListMode {
  return value === 'collapse-all' || value === 'collapse-responses' || value === 'expand-all' ? value : fallback;
}

function normalizePromptListModeInput(value: PromptListMode | boolean | null | undefined): PromptListMode {
  if (typeof value === 'boolean') return value ? 'collapse-all' : 'expand-all';
  return normalizePromptListMode(value);
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
  setPromptListMode(container, collapsed ? 'collapse-all' : 'expand-all', options);
}

export function setPromptListMode(
  container: HTMLElement,
  mode: PromptListMode,
  options?: SetPromptListCollapsedStateOptions,
) {
  container.setAttribute('data-prompt-list-mode', mode);
  container.setAttribute('data-collapsed', mode === 'expand-all' ? 'false' : 'true');
  container.querySelectorAll<HTMLButtonElement>('.prompt-list-mode-option').forEach((option) => {
    const selected = option.dataset.promptListMode === mode;
    option.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  if (options?.syncAnswers === false) return;
  container.querySelectorAll<HTMLElement>('li.prompt-question, li.prompt-answer').forEach((message) => {
    const expanded = mode === 'expand-all' || (mode === 'collapse-responses' && message.matches('li.prompt-question'));
    setPromptAnswerExpandedState(message, expanded);
  });
}

export function setPromptAnswerExpandedState(container: HTMLElement, expanded: boolean) {
  container.setAttribute('data-expanded', expanded ? 'true' : 'false');
  container.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function getPromptListCollapsedStateKey(container: Element): string | null {
  const promptListId = container.getAttribute('data-prompt-list-id')?.trim() ?? '';
  return promptListId || null;
}

function getPromptAnswerExpandedStateKey(container: Element): string | null {
  const promptListId = container.getAttribute('data-prompt-list-id')?.trim() ?? '';
  const itemIndex = container.getAttribute('data-prompt-list-item-index')?.trim() ?? '';
  if (!promptListId || !itemIndex) return null;
  return `${promptListId}${PROMPT_ANSWER_STATE_KEY_SEPARATOR}${itemIndex}`;
}

export function capturePromptListCollapsedStates(root: ParentNode): PromptListCollapsedStateSnapshot {
  const snapshot: PromptListCollapsedStateSnapshot = new Map();
  root.querySelectorAll<HTMLElement>('.prompt-list-conversation[data-prompt-list-id]').forEach((container) => {
    const key = getPromptListCollapsedStateKey(container);
    if (!key) return;
    snapshot.set(key, normalizePromptListMode(container.getAttribute('data-prompt-list-mode')));
  });
  return snapshot;
}

export function capturePromptAnswerExpandedStates(root: ParentNode): PromptAnswerExpandedStateSnapshot {
  const snapshot: PromptAnswerExpandedStateSnapshot = new Map();
  root
    .querySelectorAll<HTMLElement>(
      'li.prompt-question[data-prompt-list-id][data-prompt-list-item-index], li.prompt-answer[data-prompt-list-id][data-prompt-list-item-index]',
    )
    .forEach((message) => {
      const key = getPromptAnswerExpandedStateKey(message);
      if (!key) return;
      snapshot.set(key, message.getAttribute('data-expanded') === 'true');
    });
  return snapshot;
}

export function restorePromptListCollapsedStates(
  root: ParentNode,
  snapshot?: ReadonlyMap<string, PromptListMode | boolean> | null,
  defaultMode: PromptListMode | boolean = DEFAULT_PROMPT_LIST_MODE,
): void {
  const fallbackMode = normalizePromptListModeInput(defaultMode);
  root.querySelectorAll<HTMLElement>('.prompt-list-conversation[data-prompt-list-id]').forEach((container) => {
    const key = getPromptListCollapsedStateKey(container);
    const mode = normalizePromptListModeInput(key ? (snapshot?.get(key) ?? fallbackMode) : fallbackMode);
    setPromptListMode(container, mode);
  });
}

export function restorePromptAnswerExpandedStates(
  root: ParentNode,
  snapshot?: ReadonlyMap<string, boolean> | null,
): void {
  root
    .querySelectorAll<HTMLElement>(
      'li.prompt-question[data-prompt-list-id][data-prompt-list-item-index], li.prompt-answer[data-prompt-list-id][data-prompt-list-item-index]',
    )
    .forEach((message) => {
      const key = getPromptAnswerExpandedStateKey(message);
      if (!key) return;
      const expanded = snapshot?.get(key);
      if (expanded != null) {
        setPromptAnswerExpandedState(message, expanded);
        return;
      }

      const conversation = message.closest<HTMLElement>('.prompt-list-conversation');
      const mode = normalizePromptListMode(conversation?.getAttribute('data-prompt-list-mode'));
      if (mode === 'expand-all' || (mode === 'collapse-responses' && message.matches('li.prompt-question'))) {
        setPromptAnswerExpandedState(message, true);
      }
    });
}

export function suppressNextPromptAnswerToggle(container: HTMLElement) {
  container.setAttribute(SUPPRESS_NEXT_PROMPT_ANSWER_TOGGLE_ATTR, 'true');
}

export function consumeSuppressedPromptAnswerToggle(container: HTMLElement): boolean {
  const suppressed = container.getAttribute(SUPPRESS_NEXT_PROMPT_ANSWER_TOGGLE_ATTR) === 'true';
  if (suppressed) container.removeAttribute(SUPPRESS_NEXT_PROMPT_ANSWER_TOGGLE_ATTR);
  return suppressed;
}

export function hasNonCollapsedSelectionIntersectingNode(target: Node): boolean {
  const document = target.ownerDocument;
  const selection = document?.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    try {
      if (range.intersectsNode(target)) return true;
    } catch {
      if (selection.anchorNode && target.contains(selection.anchorNode)) return true;
      if (selection.focusNode && target.contains(selection.focusNode)) return true;
    }
  }

  return false;
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

function scrollPromptListMessageTopIntoView(target: HTMLElement, behavior: ScrollBehavior = 'auto') {
  const headerGap = getPromptListConversationHeaderGap(target);
  const scrollContainer = getPromptListScrollContainer(target);
  if (scrollContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offsetTop = targetRect.top - containerRect.top + scrollContainer.scrollTop;
    scrollContainer.scrollTo({ top: Math.max(0, offsetTop - headerGap), behavior });
    return;
  }

  const view = target.ownerDocument.defaultView;
  if (!view) return;
  const targetTop = target.getBoundingClientRect().top + view.scrollY;
  const toolbarHeight = getFixedToolbarHeight(target.ownerDocument);
  view.scrollTo({ top: Math.max(0, targetTop - toolbarHeight - headerGap), behavior });
}

function isPromptListMessageVisible(target: HTMLElement): boolean {
  const scrollContainer = getPromptListScrollContainer(target);
  if (scrollContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return targetRect.bottom > containerRect.top && targetRect.top < containerRect.bottom;
  }

  const view = target.ownerDocument.defaultView;
  if (!view) return false;
  const targetRect = target.getBoundingClientRect();
  return targetRect.bottom > 0 && targetRect.top < view.innerHeight;
}

function promptListMessageStartsAboveScrollTop(target: HTMLElement): boolean {
  const scrollContainer = getPromptListScrollContainer(target);
  if (scrollContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offsetTop = targetRect.top - containerRect.top + scrollContainer.scrollTop;
    return offsetTop < scrollContainer.scrollTop;
  }

  const view = target.ownerDocument.defaultView;
  if (!view) return false;
  const targetTop = target.getBoundingClientRect().top + view.scrollY;
  return targetTop < view.scrollY;
}

function findPromptingQuestionForAnswer(answer: HTMLElement): HTMLElement | null {
  let current: Element | null = answer;

  while (current) {
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling instanceof HTMLElement && sibling.matches('li.prompt-question')) return sibling;
      sibling = sibling.previousElementSibling;
    }

    const parentList: HTMLElement | null = current.parentElement;
    const parentBranch: HTMLElement | null = parentList?.parentElement ?? null;
    if (!(parentBranch instanceof HTMLElement) || !parentBranch.matches('li.prompt-list-branch')) return null;
    current = parentBranch;
  }

  return null;
}

export function togglePromptAnswerExpandedState(container: HTMLElement, options?: TogglePromptAnswerExpandedOptions) {
  const expanded = container.getAttribute('data-expanded') === 'true';
  const nextExpanded = !expanded;
  const shouldRestoreScrollOnCollapse =
    expanded && !nextExpanded && options?.keepTopInViewOnCollapse && promptListMessageStartsAboveScrollTop(container);

  setPromptAnswerExpandedState(container, nextExpanded);

  if (shouldRestoreScrollOnCollapse) {
    const promptingQuestion = container.matches('li.prompt-answer') ? findPromptingQuestionForAnswer(container) : null;
    if (promptingQuestion && isPromptListMessageVisible(promptingQuestion)) return;
    scrollPromptListMessageTopIntoView(promptingQuestion ?? container, options.behavior);
  }
}
