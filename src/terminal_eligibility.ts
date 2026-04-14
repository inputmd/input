import type { ActiveView } from './components/Toolbar';
import { isEditableTextFilePath } from './path_utils.ts';

export interface ResolveTerminalRouteEligibilityOptions {
  routeView: ActiveView;
  readerAiContentEligible: boolean;
  currentEditingDocPath: string | null;
  isScratchDocument: boolean;
}

export function resolveTerminalRouteEligibility(options: ResolveTerminalRouteEligibilityOptions): boolean {
  if (options.readerAiContentEligible) return true;
  if (options.routeView !== 'edit') return false;
  return options.isScratchDocument || isEditableTextFilePath(options.currentEditingDocPath);
}
