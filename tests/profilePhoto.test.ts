/**
 * Profile-photo geometry: the square crop the dialog feeds to the canvas.
 *
 * These are the numbers a 320×320 crop depends on, tested without a DOM: the
 * rect must stay inside the image, shrink as the user zooms, and clamp a pan
 * that would show a blank corner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_PHOTO_MAX_ZOOM,
  PROFILE_PHOTO_OUTPUT_SIZE,
  approxDataUrlBytes,
  clampZoom,
  cropRectFor,
  formatPhotoBytes,
} from '../client/src/utils/photoCrop';

test('the crop is the centred largest square, shrunk by zoom', () => {
  const wide = { width: 1600, height: 1200 };
  assert.deepEqual(cropRectFor(wide, { zoom: 1, offsetX: 0, offsetY: 0 }), {
    sx: 200,
    sy: 0,
    size: 1200,
  });
  assert.deepEqual(cropRectFor(wide, { zoom: 2, offsetX: 0, offsetY: 0 }), {
    sx: 500,
    sy: 300,
    size: 600,
  });

  const tall = { width: 900, height: 1800 };
  assert.deepEqual(cropRectFor(tall, { zoom: 1, offsetX: 0, offsetY: 0 }), {
    sx: 0,
    sy: 450,
    size: 900,
  });
});

test('a pan past the edge clamps instead of leaving a blank corner', () => {
  const wide = { width: 1600, height: 1200 };
  assert.deepEqual(cropRectFor(wide, { zoom: 1, offsetX: 10000, offsetY: 0 }), {
    sx: 400,
    sy: 0,
    size: 1200,
  });
  assert.deepEqual(cropRectFor(wide, { zoom: 1, offsetX: -10000, offsetY: 0 }), {
    sx: 0,
    sy: 0,
    size: 1200,
  });
  // Degenerate sizes never produce a zero/NaN rectangle.
  const broken = cropRectFor({ width: 0, height: 0 }, { zoom: 0, offsetX: NaN, offsetY: NaN });
  assert.equal(broken.size >= 1, true);
  assert.equal(Number.isFinite(broken.sx) && Number.isFinite(broken.sy), true);
});

test('zoom clamps to the slider range and the size helpers stay in bounds', () => {
  assert.equal(clampZoom(0), 1);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(clampZoom(PROFILE_PHOTO_MAX_ZOOM + 5), PROFILE_PHOTO_MAX_ZOOM);

  assert.equal(approxDataUrlBytes('data:image/jpeg;base64,AAAA'), 3);
  assert.equal(approxDataUrlBytes('data:image/jpeg;base64,AAA='), 2);
  assert.equal(approxDataUrlBytes('not-a-data-url'), 0);
  assert.equal(formatPhotoBytes(150 * 1024), '150 KB');
  assert.equal(formatPhotoBytes(512), '512 B');
  assert.equal(PROFILE_PHOTO_OUTPUT_SIZE, 320);
});
