import { useEffect, useRef } from 'preact/hooks';

interface EditViewProps {
  content: string;
  onContentChange: (content: string) => void;
}

export function EditView({ content, onContentChange }: EditViewProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    editorRef.current?.focus();
  }, []);

  return (
    <div class="edit-view">
      <textarea
        class="doc-editor"
        ref={editorRef}
        placeholder="Write your markdown here..."
        value={content}
        onInput={e => onContentChange((e.target as HTMLTextAreaElement).value)}
      />
    </div>
  );
}
