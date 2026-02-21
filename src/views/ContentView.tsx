interface ContentViewProps {
  html: string;
  markdown: boolean;
}

export function ContentView({ html, markdown }: ContentViewProps) {
  return (
    <div class="content-view">
      {markdown ? (
        <div class="rendered-markdown" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre class="rendered-content" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
