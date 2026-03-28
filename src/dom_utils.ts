/** Blur the active element when a Radix dropdown menu closes. */
export function blurOnClose(open: boolean): void {
  if (!open) (document.activeElement as HTMLElement | null)?.blur?.();
}
