export interface NoteJsonl {
  type: 'note';
  version: 1;
  createdAt: string;
  text: string;
}

export function isNotePath(path: string): boolean {
  return path.endsWith('.jsonl') && path.startsWith('.input/.notes/');
}

export function createNoteJsonl(text: string, createdAt: Date = new Date()): string {
  const note: NoteJsonl = {
    type: 'note',
    version: 1,
    createdAt: createdAt.toISOString(),
    text,
  };
  return `${JSON.stringify(note)}\n`;
}

export function parseNoteJsonl(content: string): NoteJsonl | null {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return null;
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.type !== 'note' || record.version !== 1) return null;
    if (typeof record.createdAt !== 'string' || typeof record.text !== 'string') return null;
    return {
      type: 'note',
      version: 1,
      createdAt: record.createdAt,
      text: record.text,
    };
  } catch {
    return null;
  }
}
