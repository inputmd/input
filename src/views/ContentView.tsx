interface ContentViewProps {
  html: string;
  markdown: boolean;
  onInternalLinkNavigate?: (route: string) => void;
}

function isExternalHttpHref(href: string): boolean {
  const protocolMatch = href.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!protocolMatch) return false;
  const protocol = protocolMatch[1].toLowerCase();
  return protocol === 'http' || protocol === 'https';
}

export function ContentView({ html, markdown, onInternalLinkNavigate }: ContentViewProps) {
  const onRenderedMarkdownClick = (event: MouseEvent) => {
    if (!onInternalLinkNavigate) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = event.target as HTMLElement | null;
    const anchor = target?.closest('a');
    if (!anchor) return;
    if (anchor.hasAttribute('download')) return;

    const href = (anchor.getAttribute('href') || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('?')) return;
    if (isExternalHttpHref(href)) return;

    const resolved = new URL(href, window.location.href);
    if (resolved.origin !== window.location.origin) return;

    event.preventDefault();
    const route = resolved.pathname.replace(/^\//, '');
    onInternalLinkNavigate(route);
  };

  return (
    <div class="content-view">
      {markdown ? (
        <div
          class="rendered-markdown"
          onClick={onRenderedMarkdownClick}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre class="rendered-content" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
