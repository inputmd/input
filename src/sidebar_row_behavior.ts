export type SidebarRowAction = { type: 'select-file'; path: string } | { type: 'toggle-folder'; path: string };

export type SidebarRowTarget = { kind: 'file' | 'folder'; path: string };

export interface ResolveSidebarFolderRowBehaviorOptions {
  folderPath: string;
  combinedFilePath?: string | null;
  combinedFileVirtual?: boolean;
  readOnly: boolean;
  isRenaming: boolean;
  isRenamePending: boolean;
  isMoving: boolean;
}

export interface SidebarFolderRowBehavior {
  bodyAction: SidebarRowAction;
  caretAction: { type: 'toggle-folder'; path: string };
  createParentPath: string;
  deleteTarget: SidebarRowTarget;
  dragSource: SidebarRowTarget | null;
  dropTargetFolderPath: string;
  renameTarget: SidebarRowTarget | null;
  viewTarget: SidebarRowTarget;
}

export function resolveSidebarFolderRowLabel(folderName: string, combinedFileName?: string | null): string {
  return combinedFileName && combinedFileName.length > 0 ? combinedFileName : folderName;
}

export function resolveSidebarFolderRowBehavior(
  options: ResolveSidebarFolderRowBehaviorOptions,
): SidebarFolderRowBehavior {
  const {
    folderPath,
    combinedFilePath = null,
    combinedFileVirtual = false,
    readOnly,
    isRenaming,
    isRenamePending,
    isMoving,
  } = options;
  const hasCombinedFile = typeof combinedFilePath === 'string' && combinedFilePath.length > 0;
  const canSelectCombinedFile = hasCombinedFile && !combinedFileVirtual;
  const dragSource =
    !hasCombinedFile && !readOnly && !isRenaming && !isRenamePending && !isMoving
      ? { kind: 'folder' as const, path: folderPath }
      : null;

  return {
    bodyAction: canSelectCombinedFile
      ? { type: 'select-file', path: combinedFilePath! }
      : { type: 'toggle-folder', path: folderPath },
    caretAction: { type: 'toggle-folder', path: folderPath },
    createParentPath: folderPath,
    deleteTarget: hasCombinedFile ? { kind: 'file', path: combinedFilePath! } : { kind: 'folder', path: folderPath },
    dragSource,
    dropTargetFolderPath: folderPath,
    renameTarget: hasCombinedFile
      ? combinedFileVirtual
        ? null
        : { kind: 'file', path: combinedFilePath! }
      : { kind: 'folder', path: folderPath },
    viewTarget: hasCombinedFile ? { kind: 'file', path: combinedFilePath! } : { kind: 'folder', path: folderPath },
  };
}
