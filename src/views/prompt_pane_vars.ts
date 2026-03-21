export function syncPromptPaneBleedVars(markdownEl: HTMLElement, paneEl: HTMLElement): void {
  const paneRect = paneEl.getBoundingClientRect();
  const markdownRect = markdownEl.getBoundingClientRect();
  const styles = window.getComputedStyle(markdownEl);
  const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
  const contentLeft = markdownRect.left + paddingLeft;
  const contentRight = markdownRect.right - paddingRight;
  const bleedLeft = Math.max(0, contentLeft - paneRect.left);
  const bleedRight = Math.max(0, paneRect.right - contentRight);

  markdownEl.style.setProperty('--prompt-pane-bleed-left', `${bleedLeft}px`);
  markdownEl.style.setProperty('--prompt-pane-bleed-right', `${bleedRight}px`);
}
