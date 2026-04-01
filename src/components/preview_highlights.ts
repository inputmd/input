export interface PreviewHighlightEntry {
  id: string;
  prefix: string;
  text: string;
  suffix: string;
}

export function collectPreviewHighlights(root: ParentNode): {
  entries: PreviewHighlightEntry[];
  elementsById: Map<string, HTMLElement>;
} {
  const elementsById = new Map<string, HTMLElement>();
  const entries = Array.from(
    root.querySelectorAll<HTMLElement>('mark.critic-highlight, mark.double-colon-highlight'),
  ).map((element, index) => {
    const prefix = getHighlightPrefixText(element);
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim() || `Highlight ${index + 1}`;
    const suffix = getHighlightSuffixText(element);
    const id = `preview-highlight-${index}`;
    elementsById.set(id, element);
    return { id, prefix, text, suffix };
  });

  return { entries, elementsById };
}

function getHighlightPrefixText(element: HTMLElement, maxChars = 160): string {
  const listItem = element.closest('li');
  const parentListItem = listItem?.parentElement?.closest('li');
  if (!parentListItem) return '';

  const clone = parentListItem.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return '';
  clone.querySelectorAll('ul, ol').forEach((childList) => {
    childList.remove();
  });

  const prefix = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!prefix) return '';
  return prefix.slice(0, maxChars);
}

function getHighlightSuffixText(element: HTMLElement, maxChars = 140): string {
  const ownerDocument = element.ownerDocument;
  const container =
    element.closest('p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6, figcaption') ?? element.parentElement;
  if (!ownerDocument || !container || !container.lastChild) return '';

  const range = ownerDocument.createRange();
  range.selectNodeContents(container);
  range.setStartAfter(element);

  const suffix = range.toString().replace(/\s+/g, ' ').trimEnd();
  if (!suffix.trim()) return '';
  return suffix.slice(0, maxChars);
}
