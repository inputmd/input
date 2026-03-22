import type { GistFile } from './github';
import type { ImageDimensions } from './image_markdown';
import { isLikelyBinaryBytes, isSafeImageFileName } from './path_utils';

const PASTED_IMAGE_RESIZE_THRESHOLD_BYTES = Math.floor(1.5 * 1024 * 1024);
const PASTED_IMAGE_MAX_SIDE_PX = 1600;
const PASTED_IMAGE_QUALITY = 0.82;

export function extensionFromMimeType(mimeType: string): string {
  const mimeExt: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  };
  return mimeExt[mimeType] ?? 'png';
}

export function isResizableImageType(mimeType: string): boolean {
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/jpg' || mimeType === 'image/webp';
}

async function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

export async function maybeResizePastedImage(file: File): Promise<{
  bytes: Uint8Array;
  extension: string;
  resized: boolean;
  dimensions: ImageDimensions | null;
}> {
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const originalExtension = extensionFromMimeType(file.type);

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const originalDimensions = { width, height };

    if (file.size <= PASTED_IMAGE_RESIZE_THRESHOLD_BYTES || !isResizableImageType(file.type)) {
      bitmap.close();
      return { bytes: originalBytes, extension: originalExtension, resized: false, dimensions: originalDimensions };
    }

    const longest = Math.max(width, height);
    const scale = longest > PASTED_IMAGE_MAX_SIDE_PX ? PASTED_IMAGE_MAX_SIDE_PX / longest : 1;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return { bytes: originalBytes, extension: originalExtension, resized: false, dimensions: originalDimensions };
    }
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const outputMimeType = file.type === 'image/jpeg' || file.type === 'image/jpg' ? 'image/jpeg' : 'image/webp';
    const resizedBlob = await canvasToBlob(canvas, outputMimeType, PASTED_IMAGE_QUALITY);
    if (!resizedBlob) {
      return { bytes: originalBytes, extension: originalExtension, resized: false, dimensions: originalDimensions };
    }

    const resizedBytes = new Uint8Array(await resizedBlob.arrayBuffer());
    if (resizedBytes.length >= originalBytes.length) {
      return { bytes: originalBytes, extension: originalExtension, resized: false, dimensions: originalDimensions };
    }

    return {
      bytes: resizedBytes,
      extension: extensionFromMimeType(outputMimeType),
      resized: true,
      dimensions: { width: targetWidth, height: targetHeight },
    };
  } catch {
    return { bytes: originalBytes, extension: originalExtension, resized: false, dimensions: null };
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 4000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    return await fetch(input, { ...init, signal });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

export async function fetchFullGistFileText(
  file: Pick<GistFile, 'filename' | 'raw_url'>,
): Promise<{ ok: true; content: string } | { ok: false; error: string } | { ok: false; binary: true }> {
  const rawUrl = file.raw_url?.trim();
  if (!rawUrl) return { ok: false, error: 'No raw_url available for this file.' };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid raw_url.' };
  }

  if (url.hostname !== 'gist.githubusercontent.com') {
    return { ok: false, error: 'Unsupported raw_url host.' };
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(rawUrl, { redirect: 'error' }, 4000);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: 'Timed out loading full content.' };
    }
    throw err;
  }
  if (!res.ok) return { ok: false, error: `Failed to load full content (${res.status}).` };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (isSafeImageFileName(file.filename) || isLikelyBinaryBytes(bytes)) return { ok: false, binary: true };
  return { ok: true, content: new TextDecoder().decode(bytes) };
}
