interface ContentViewProps {
  html: string;
}

export function ContentView({ html }: ContentViewProps) {
  return (
    <div class="content-view">
      <pre class="rendered-content" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
