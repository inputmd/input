import { useEffect, useRef, useState } from 'preact/hooks';
import { parseMarkdownDocument } from '../markdown';
import type { WikiLinkResolver } from '../wiki_links';
import { EditView, type EditViewProps } from './EditView';

export interface EditSessionViewProps
  extends Omit<
    EditViewProps,
    | 'content'
    | 'contentOrigin'
    | 'contentRevision'
    | 'contentSelection'
    | 'previewHtml'
    | 'previewCustomCss'
    | 'previewCustomCssScope'
    | 'previewFrontMatterError'
    | 'previewCssWarning'
  > {
  content: string;
  contentOrigin?: 'userEdits' | 'external' | 'streaming' | 'appEdits';
  contentRevision?: number;
  contentSelection?: { anchor: number; head: number } | null;
  resolvePreviewImageSrc: (src: string) => string | null;
  previewWikiLinkResolver?: (targetPath: string) => WikiLinkResolver;
  showLoggedOutNewDocPreviewDescription?: boolean;
}

const LOGGED_OUT_NEW_DOC_PREVIEW_DESCRIPTION = `
### Input

Input is a tool for editing workspaces of Markdown files.

It supports live preview, sharing and collaboration, and \\[\\[wiki links\\]\\]. Your data is stored in [repos](https://docs.github.com/en/repositories/creating-and-managing-repositories/about-repositories) or [gists](https://gist.github.com/).

It comes with an AI assistant, and several new ways to write with AI without leaving the editor.

You can also use Input as an alternative frontend for any public repo -- just replace github.com with input.md. Check out the source [here](https://input.md/inputmd/input).

#### Inline AI Features

- Inline AI chat - start a line with ~, then press \`Enter\`
- Branching completions - write your query in \\{braces}, press \`Tab\`
- Full-context completions - write your query in \\{braces} with text after, press \`Shift-Tab\` at the closing brace

#### Examples

- [awesome-markdown](https://input.md/mundimark/awesome-markdown)
- [awesome-ai-tools](https://input.md/mahseema/awesome-ai-tools)
- [awesome-mac](https://input.md/jaywcjlove/awesome-mac)
- [papers-we-love](https://input.md/papers-we-love/papers-we-love)
- [conversations-with-ai](https://input.md/raykyri/conversations)
`;

export function EditSessionView({
  content,
  contentOrigin = 'external',
  contentRevision = 0,
  contentSelection = null,
  onContentChange,
  markdown = true,
  resolvePreviewImageSrc,
  previewWikiLinkResolver,
  showLoggedOutNewDocPreviewDescription = false,
  ...rest
}: EditSessionViewProps) {
  const [liveContent, setLiveContent] = useState(content);
  const [liveContentOrigin, setLiveContentOrigin] = useState<'userEdits' | 'external' | 'streaming' | 'appEdits'>(
    contentOrigin,
  );
  const [liveContentRevision, setLiveContentRevision] = useState(contentRevision);
  const [liveContentSelection, setLiveContentSelection] = useState<{ anchor: number; head: number } | null>(
    contentSelection,
  );
  const [deferredLiveContent, setDeferredLiveContent] = useState(content);
  const liveContentRef = useRef(liveContent);
  liveContentRef.current = liveContent;

  useEffect(() => {
    // App-level typing updates are intentionally deferred, so ignore stale user-edits echoes
    // while the editor's live content is already ahead.
    if (contentOrigin === 'userEdits' && content !== liveContentRef.current) return;
    setLiveContent(content);
    setLiveContentOrigin(contentOrigin);
    setLiveContentRevision(contentRevision);
    setLiveContentSelection(contentSelection);
    if (contentOrigin !== 'userEdits') {
      setDeferredLiveContent(content);
    }
  }, [content, contentOrigin, contentRevision, contentSelection]);

  useEffect(() => {
    if (liveContentOrigin !== 'userEdits') {
      setDeferredLiveContent(liveContent);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setDeferredLiveContent(liveContent);
    }, 150);
    return () => window.clearTimeout(timeoutId);
  }, [liveContent, liveContentOrigin]);

  const previewDocument = markdown
    ? parseMarkdownDocument(
        showLoggedOutNewDocPreviewDescription && deferredLiveContent.trim().length === 0
          ? LOGGED_OUT_NEW_DOC_PREVIEW_DESCRIPTION
          : deferredLiveContent,
        {
          smartQuotes: true,
          resolveImageSrc: resolvePreviewImageSrc,
          resolveWikiLinkMeta: previewWikiLinkResolver,
        },
      )
    : { html: '', customCss: null, customCssScope: null, frontMatterError: null, cssWarning: null, syncBlocks: [] };

  const handleContentChange = (update: { content: string; origin: 'userEdits'; revision: number }) => {
    setLiveContent(update.content);
    setLiveContentOrigin(update.origin);
    setLiveContentRevision(update.revision);
    setLiveContentSelection(null);
    onContentChange(update);
  };

  return (
    <EditView
      {...rest}
      markdown={markdown}
      content={liveContent}
      contentOrigin={liveContentOrigin}
      contentRevision={liveContentRevision}
      contentSelection={liveContentSelection}
      previewHtml={previewDocument.html}
      previewCustomCss={previewDocument.customCss}
      previewCustomCssScope={previewDocument.customCssScope}
      previewFrontMatterError={previewDocument.frontMatterError}
      previewCssWarning={previewDocument.cssWarning}
      previewSyncBlocks={previewDocument.syncBlocks}
      onContentChange={handleContentChange}
    />
  );
}
