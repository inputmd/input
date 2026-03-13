export interface ImageDimensions {
  width: number;
  height: number;
}

const IMAGE_DIMENSION_TITLE_PREFIX = 'input-size=';

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function buildImageDimensionTitle(dimensions: ImageDimensions | null | undefined): string | null {
  if (!dimensions) return null;
  if (!isPositiveInteger(dimensions.width) || !isPositiveInteger(dimensions.height)) return null;
  return `${IMAGE_DIMENSION_TITLE_PREFIX}${dimensions.width}x${dimensions.height}`;
}

export function parseImageDimensionTitle(title: string | null | undefined): ImageDimensions | null {
  if (!title) return null;
  const match = /^input-size=(\d+)x(\d+)$/.exec(title.trim());
  if (!match) return null;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) return null;
  return { width, height };
}

export function buildImageMarkdown(alt: string, src: string, dimensions?: ImageDimensions | null): string {
  const title = buildImageDimensionTitle(dimensions);
  if (!title) return `![${alt}](${src})`;
  return `![${alt}](${src} "${title}")`;
}
