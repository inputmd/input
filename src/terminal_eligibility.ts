import type { ActiveView } from './components/Toolbar';
import { isEditableTextFilePath, safeDecodeURIComponent } from './path_utils.ts';
import type { Route } from './routing.ts';

export interface ResolveTerminalRouteEligibilityOptions {
  route: Route;
  routeView: ActiveView;
  readerAiContentEligible: boolean;
  currentEditingDocPath: string | null;
  isScratchDocument: boolean;
}

function editablePathFromRoute(route: Route): string | null {
  switch (route.name) {
    case 'repoedit':
    case 'reponew':
      return safeDecodeURIComponent(route.params.path).replace(/^\/+/, '');
    case 'edit':
      return route.params.filename ? safeDecodeURIComponent(route.params.filename) : null;
    default:
      return null;
  }
}

export function resolveTerminalRouteEligibility(options: ResolveTerminalRouteEligibilityOptions): boolean {
  if (options.readerAiContentEligible) return true;
  if (options.route.name === 'new') return true;
  const routeEditPath = editablePathFromRoute(options.route);
  if (isEditableTextFilePath(routeEditPath)) return true;
  if (options.routeView !== 'edit') return false;
  return options.isScratchDocument || isEditableTextFilePath(options.currentEditingDocPath);
}
