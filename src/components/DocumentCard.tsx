import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Ellipsis } from 'lucide-react';
import type { ComponentChildren } from 'preact';

interface DocumentCardProps {
  title: ComponentChildren;
  meta: ComponentChildren;
  onOpen: () => void;
  onRename?: () => void;
  onDelete: () => void;
  pending?: boolean;
}

export function DocumentCard({ title, meta, onOpen, onRename, onDelete, pending = false }: DocumentCardProps) {
  return (
    <div class={`document-card${pending ? ' document-card-pending' : ''}`}>
      <div class="doc-info">
        <span class="doc-title">{title}</span>
        <span class="doc-meta">{meta}</span>
      </div>
      <div class="doc-actions">
        <button type="button" onClick={onOpen}>
          Open
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" class="doc-actions-menu-trigger" aria-label="More actions" title="More actions">
              <Ellipsis size={16} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="doc-actions-menu-content" sideOffset={6} align="end">
              {onRename ? (
                <DropdownMenu.Item class="doc-actions-menu-item" onSelect={() => onRename()}>
                  Rename
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Item class="doc-actions-menu-item doc-actions-menu-item-danger" onSelect={onDelete}>
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}
