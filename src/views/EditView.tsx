import { useEffect, useRef } from 'preact/hooks';

interface EditViewProps {
  title: string;
  content: string;
  onTitleChange: (title: string) => void;
  onContentChange: (content: string) => void;
}

export function EditView({ title, content, onTitleChange, onContentChange }: EditViewProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    editorRef.current?.focus();
  }, []);

  return (
    <div class="edit-view">
      <input
        type="text"
        class="edit-title"
        placeholder="Document title"
        value={title}
        onInput={e => onTitleChange((e.target as HTMLInputElement).value)}
      />
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
