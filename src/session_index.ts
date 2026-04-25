export const SESSION_REFERENCE_INDEX_PATH = '.input/index.json';

export interface SessionReferenceIndex {
  version: 1;
  children: Record<string, string[]>;
}

export type AddSessionReferenceChildResult =
  | { ok: true; index: SessionReferenceIndex; changed: boolean }
  | { ok: false; reason: 'self' | 'cycle' | 'missing-item' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneIndex(index: SessionReferenceIndex): SessionReferenceIndex {
  const children: Record<string, string[]> = {};
  for (const [parent, childPaths] of Object.entries(index.children)) {
    children[parent] = [...childPaths];
  }
  return { version: 1, children };
}

export function normalizeSessionReferenceIndex(
  index: SessionReferenceIndex,
  existingPaths?: ReadonlySet<string>,
): SessionReferenceIndex {
  const children: Record<string, string[]> = {};
  for (const [parent, rawChildren] of Object.entries(index.children)) {
    if (existingPaths && !existingPaths.has(parent)) continue;
    const childPaths: string[] = [];
    const seen = new Set<string>();
    for (const child of rawChildren) {
      if (child === parent) continue;
      if (existingPaths && !existingPaths.has(child)) continue;
      if (seen.has(child)) continue;
      seen.add(child);
      childPaths.push(child);
    }
    if (childPaths.length > 0) children[parent] = childPaths;
  }
  return { version: 1, children };
}

export function parseSessionReferenceIndex(
  content: string | null | undefined,
  existingPaths?: ReadonlySet<string>,
): SessionReferenceIndex {
  if (!content?.trim()) return { version: 1, children: {} };
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || !isRecord(parsed.children)) return { version: 1, children: {} };
    const children: Record<string, string[]> = {};
    for (const [parent, rawChildren] of Object.entries(parsed.children)) {
      if (!Array.isArray(rawChildren)) continue;
      children[parent] = rawChildren.filter((child): child is string => typeof child === 'string');
    }
    return normalizeSessionReferenceIndex({ version: 1, children }, existingPaths);
  } catch {
    return { version: 1, children: {} };
  }
}

export function serializeSessionReferenceIndex(index: SessionReferenceIndex): string {
  return `${JSON.stringify(normalizeSessionReferenceIndex(index), null, 2)}\n`;
}

export function getSessionReferenceChildren(index: SessionReferenceIndex, parentPath: string): string[] {
  return index.children[parentPath] ?? [];
}

export function getSessionReferenceParents(index: SessionReferenceIndex, childPath: string): string[] {
  const parents: string[] = [];
  for (const [parent, childPaths] of Object.entries(index.children)) {
    if (childPaths.includes(childPath)) parents.push(parent);
  }
  return parents.sort((left, right) => left.localeCompare(right));
}

function canReachChild(index: SessionReferenceIndex, startPath: string, targetPath: string): boolean {
  const visited = new Set<string>();
  const stack = [...getSessionReferenceChildren(index, startPath)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    if (current === targetPath) return true;
    visited.add(current);
    stack.push(...getSessionReferenceChildren(index, current));
  }
  return false;
}

export function addSessionReferenceChild(
  index: SessionReferenceIndex,
  parentPath: string,
  childPath: string,
  existingPaths?: ReadonlySet<string>,
): AddSessionReferenceChildResult {
  if (parentPath === childPath) return { ok: false, reason: 'self' };
  if (existingPaths && (!existingPaths.has(parentPath) || !existingPaths.has(childPath))) {
    return { ok: false, reason: 'missing-item' };
  }
  const normalized = normalizeSessionReferenceIndex(index, existingPaths);
  if (canReachChild(normalized, childPath, parentPath)) return { ok: false, reason: 'cycle' };
  const existingChildren = normalized.children[parentPath] ?? [];
  if (existingChildren.includes(childPath)) return { ok: true, index: normalized, changed: false };
  const next = cloneIndex(normalized);
  next.children[parentPath] = [...existingChildren, childPath];
  return { ok: true, index: normalizeSessionReferenceIndex(next, existingPaths), changed: true };
}

export function removeSessionReferenceChild(
  index: SessionReferenceIndex,
  parentPath: string,
  childPath: string,
  existingPaths?: ReadonlySet<string>,
): { index: SessionReferenceIndex; changed: boolean } {
  const normalized = normalizeSessionReferenceIndex(index, existingPaths);
  const existingChildren = normalized.children[parentPath] ?? [];
  if (!existingChildren.includes(childPath)) return { index: normalized, changed: false };
  const next = cloneIndex(normalized);
  const remainingChildren = existingChildren.filter((child) => child !== childPath);
  if (remainingChildren.length === 0) delete next.children[parentPath];
  else next.children[parentPath] = remainingChildren;
  return { index: normalizeSessionReferenceIndex(next, existingPaths), changed: true };
}

export function cleanupDeletedSessionReference(
  index: SessionReferenceIndex,
  deletedPath: string,
  existingPaths?: ReadonlySet<string>,
): { index: SessionReferenceIndex; changed: boolean } {
  const normalized = normalizeSessionReferenceIndex(index);
  const next = cloneIndex(normalized);
  let changed = false;
  if (deletedPath in next.children) {
    delete next.children[deletedPath];
    changed = true;
  }
  for (const [parent, childPaths] of Object.entries(next.children)) {
    if (!childPaths.includes(deletedPath)) continue;
    changed = true;
    const remainingChildren = childPaths.filter((child) => child !== deletedPath);
    if (remainingChildren.length === 0) delete next.children[parent];
    else next.children[parent] = remainingChildren;
  }
  return { index: normalizeSessionReferenceIndex(next, existingPaths), changed };
}
