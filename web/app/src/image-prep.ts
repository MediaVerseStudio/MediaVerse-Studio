// Turns a pasted, dropped or chosen image into a JPEG small enough to embed in an MP3 (at most
// about 450 KB and 1000 pixels on the longest side). The browser decodes and re-encodes it, which
// also makes it a baseline JPEG that every player can show. Nothing leaves the computer.

import { PICTURE_LIMITS, centreSquare, pickQuality, scaleFor } from "./media-request";

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export type PreparedImage = { base64: string; previewUrl: string; width: number; height: number; bytes: number };

/** The pixel size of an image, without preparing it. */
export async function imageSize(source: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(source);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/** `square`: keep only the centred square ("Crop to square"), then fit it in 1000 × 1000. */
export async function prepareImage(source: Blob, options: { square?: boolean } = {}): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new Error("That is not an image the program can read. Use a JPEG or PNG picture.");
  }
  const crop = options.square ? centreSquare(bitmap.width, bitmap.height) : { x: 0, y: 0, side: 0 };
  const [sw, sh] = options.square ? [crop.side, crop.side] : [bitmap.width, bitmap.height];
  const scale = scaleFor(sw, sh, PICTURE_LIMITS.maxSide);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ffffff"; // JPEG has no transparency
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, crop.x, crop.y, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await pickQuality((quality) => toBlob(canvas, quality));
  if (!blob) {
    throw new Error("The picture could not be made small enough to store in an MP3.");
  }
  return { base64: await blobToBase64(blob), previewUrl: URL.createObjectURL(blob), width: canvas.width, height: canvas.height, bytes: blob.size };
}

/** The largest picture the tag writer takes. */
const MAX_SONG_BYTES = 500 * 1024;

/** A picture as it may go inside a song (base64): as it is when it is already a JPEG within 1000 pixels and the size
 * limit, else made into one. Every picture copied from somewhere else goes through this. */
export async function fitForSong(source: Blob): Promise<string> {
  const start = new Uint8Array(await source.slice(0, 3).arrayBuffer());
  if (start[0] === 0xff && start[1] === 0xd8 && start[2] === 0xff && source.size <= MAX_SONG_BYTES) {
    const size = await imageSize(source);
    if (Math.max(size.width, size.height) <= PICTURE_LIMITS.maxSide) return blobToBase64(source);
  }
  const prepared = await prepareImage(source);
  URL.revokeObjectURL(prepared.previewUrl);
  return prepared.base64;
}

/**
 * The full-size copy kept in the album folder (owner, 2026-11-05): a JPEG as it is; anything else (a pasted picture
 * arrives as PNG) as a high-quality JPEG at its own size; cropped to the centred square when asked.
 */
export async function nativeCopy(source: Blob, square = false): Promise<{ base64: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(source);
  const size = { width: bitmap.width, height: bitmap.height };
  if (!square && source.type === "image/jpeg") {
    bitmap.close();
    return { base64: await blobToBase64(source), ...size };
  }
  const crop = square ? centreSquare(bitmap.width, bitmap.height) : { x: 0, y: 0, side: 0 };
  const [sw, sh] = square ? [crop.side, crop.side] : [bitmap.width, bitmap.height];
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, sw, sh);
  context.drawImage(bitmap, crop.x, crop.y, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const blob = await toBlob(canvas, 0.95);
  if (!blob) throw new Error("The full-size picture could not be made.");
  return { base64: await blobToBase64(blob), width: sw, height: sh };
}
