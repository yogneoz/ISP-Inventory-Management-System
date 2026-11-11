/**
 * Profile-photo geometry and size helpers.
 *
 * Kept free of DOM and React so the crop maths can be tested directly: the
 * dialog only feeds it an image size and the user's zoom/pan, and gets back the
 * square source rectangle to draw. Everything is clamped, so a pan past the
 * edge slides to the edge instead of showing a blank corner.
 */

/** The square the photo is rendered at in every circle (header, cards). */
export const PROFILE_PHOTO_OUTPUT_SIZE = 320;

/** Mirrors the server's HR_SELF_PHOTO_MAX_BYTES. */
export const PROFILE_PHOTO_MAX_BYTES = 150 * 1024;

export const PROFILE_PHOTO_MIN_ZOOM = 1;
export const PROFILE_PHOTO_MAX_ZOOM = 3;

export interface PhotoSourceSize {
  width: number;
  height: number;
}

/** Zoom plus a pan offset, both in SOURCE pixels. */
export interface PhotoCrop {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface PhotoCropRect {
  sx: number;
  sy: number;
  size: number;
}

export const clampZoom = (zoom: number, max = PROFILE_PHOTO_MAX_ZOOM): number => {
  if (!Number.isFinite(zoom)) return PROFILE_PHOTO_MIN_ZOOM;
  return Math.min(max, Math.max(PROFILE_PHOTO_MIN_ZOOM, zoom));
};

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
};

/**
 * The square source rectangle: the largest centred square, shrunk by the zoom
 * and shifted by the pan, clamped inside the image.
 */
export function cropRectFor(source: PhotoSourceSize, crop: PhotoCrop): PhotoCropRect {
  const width = Math.max(1, Math.floor(Number(source.width) || 0));
  const height = Math.max(1, Math.floor(Number(source.height) || 0));
  const zoom = clampZoom(crop.zoom);
  const size = Math.max(1, Math.round(Math.min(width, height) / zoom));
  const maxX = Math.max(0, width - size);
  const maxY = Math.max(0, height - size);
  const sx = Math.round(clamp((width - size) / 2 + (crop.offsetX || 0), 0, maxX));
  const sy = Math.round(clamp((height - size) / 2 + (crop.offsetY || 0), 0, maxY));
  return { sx, sy, size };
}

/** JPEG qualities tried in order until the data URL fits the server's limit. */
export const PHOTO_QUALITY_STEPS = [0.85, 0.75, 0.65] as const;

/** Output squares tried in order; the first that fits wins. */
export const PHOTO_OUTPUT_STEPS = [PROFILE_PHOTO_OUTPUT_SIZE, 256, 224] as const;

/** Decoded byte count of a `data:` URL, without allocating the bytes. */
export function approxDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const base64 = dataUrl.slice(comma + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function formatPhotoBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
