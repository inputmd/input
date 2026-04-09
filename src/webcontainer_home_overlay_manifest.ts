import keepContents from '../webcontainer-home-overlay/.local/bin/.keep?raw';
import corsModuleContents from '../webcontainer-home-overlay/cors.mjs?raw';
import type { WebContainerHomeOverlayFile } from './webcontainer_home_overlay.ts';

const SAMPLE_JSHRC = ['export PATH="$HOME/.local/bin:$PATH"', 'npm config set prefix ~/.local', ''].join('\n');

export const WEBCONTAINER_HOME_OVERLAY_FILES = [
  {
    path: '.jshrc',
    contents: SAMPLE_JSHRC,
  },
  {
    path: 'cors.mjs',
    contents: corsModuleContents,
  },
  {
    path: '.local/bin/.keep',
    contents: keepContents,
  },
] as const satisfies readonly WebContainerHomeOverlayFile[];
