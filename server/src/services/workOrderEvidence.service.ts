/**
 * Validation for a proof-of-work capture, shared by the web register and the
 * phone route so both refuse the same things for the same reasons.
 *
 * Rules:
 *   - `kind` is PHOTO or SIGNATURE, and `contentType` is one of the three image
 *     types the table accepts;
 *   - the payload is base64 (a `data:` URL prefix is stripped, since browser
 *     file readers produce one) and decodes to 1 byte – 2 MiB;
 *   - `capturedAtEpochMs` may not be more than 15 minutes ahead of the server —
 *     the same clock-skew tolerance a punch gets — so a phone with a wrong clock
 *     cannot file next week's photo today;
 *   - coordinates, when present, are real coordinates.
 */
import { ApiError } from '../errors/ApiError';

const CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 2 * 1024 * 1024;
const FUTURE_SKEW_MS = 15 * 60 * 1000;

export interface ParsedEvidence {
  kind: 'PHOTO' | 'SIGNATURE';
  contentType: string;
  dataBase64: string;
  caption: string | null;
  capturedAt: Date;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
}

function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function coordinate(value: unknown, min: number, max: number, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, `${field} must be a number between ${min} and ${max}.`);
  }
  return parsed;
}

export function parseEvidenceBody(body: any): ParsedEvidence {
  const kind = String(body?.kind || '').trim().toUpperCase();
  if (kind !== 'PHOTO' && kind !== 'SIGNATURE') {
    throw new ApiError(400, 'kind must be PHOTO or SIGNATURE.');
  }
  const contentType = String(body?.contentType || '').trim().toLowerCase();
  if (!CONTENT_TYPES.has(contentType)) {
    throw new ApiError(400, 'contentType must be image/jpeg, image/png or image/webp.');
  }

  const raw = text(body?.dataBase64, 4 * 1024 * 1024);
  if (!raw) throw new ApiError(400, 'dataBase64 is required.');
  const base64 = raw.replace(/^data:[a-z/+.-]+;base64,/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new ApiError(400, 'dataBase64 must be valid base64 image data.');
  }
  const bytes = Buffer.from(base64, 'base64').length;
  if (bytes <= 0) throw new ApiError(400, 'The capture is empty.');
  if (bytes > MAX_BYTES) {
    throw new ApiError(400, `The capture is ${bytes} bytes; the ceiling is ${MAX_BYTES} (2 MiB).`);
  }

  let capturedAt = new Date();
  const epoch = body?.capturedAtEpochMs;
  if (epoch !== undefined && epoch !== null && epoch !== '') {
    const parsed = Number(epoch);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ApiError(400, 'capturedAtEpochMs must be a positive epoch in milliseconds.');
    }
    capturedAt = new Date(parsed);
    if (capturedAt.getTime() > Date.now() + FUTURE_SKEW_MS) {
      throw new ApiError(400, 'capturedAtEpochMs is more than 15 minutes ahead of the server.');
    }
  }

  return {
    kind: kind as 'PHOTO' | 'SIGNATURE',
    contentType,
    dataBase64: base64,
    caption: text(body?.caption, 200),
    capturedAt,
    latitude: coordinate(body?.latitude, -90, 90, 'latitude'),
    longitude: coordinate(body?.longitude, -180, 180, 'longitude'),
    accuracyMeters: coordinate(body?.accuracyMeters, 0, 100000, 'accuracyMeters'),
  };
}

export const EVIDENCE_MAX_BYTES = MAX_BYTES;
