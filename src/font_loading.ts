const CRITICAL_APP_FONT_DESCRIPTORS = [
  '400 1em "SF Mono Web"',
  '400 1em "Inter Variable"',
  '400 1em "Schibsted Grotesk"',
];

export async function waitForCriticalAppFonts(timeoutMs = 1200): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;

  const fontFaceSet = document.fonts;
  const fontLoads = CRITICAL_APP_FONT_DESCRIPTORS.map((descriptor) => fontFaceSet.load(descriptor));

  await Promise.race([
    Promise.allSettled(fontLoads).then(() => undefined),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, timeoutMs);
    }),
  ]);
}
