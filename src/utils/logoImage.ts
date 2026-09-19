const MAX_LOGO_WIDTH = 640;
const MAX_LOGO_HEIGHT = 320;
const ALPHA_CROP_THRESHOLD = 8;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Unable to read the logo file.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The selected file is not a readable image.'));
    image.src = source;
  });
}

/**
 * Crops transparent margins and scales a logo down while preserving its own
 * aspect ratio. WebP keeps transparent backgrounds and is considerably
 * smaller than the original upload for storage and header rendering.
 */
export async function processLogoFile(file: File): Promise<string> {
  const source = await readFileAsDataUrl(file);
  const image = await loadImage(source);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = image.naturalWidth || image.width;
  sourceCanvas.height = image.naturalHeight || image.height;
  const sourceContext = sourceCanvas.getContext('2d');

  if (!sourceContext || !sourceCanvas.width || !sourceCanvas.height) {
    throw new Error('The selected image has no usable dimensions.');
  }

  sourceContext.drawImage(image, 0, 0);
  const pixels = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
  let left = sourceCanvas.width;
  let top = sourceCanvas.height;
  let right = -1;
  let bottom = -1;

  // Trim transparent padding. Opaque JPGs retain their natural image ratio.
  for (let y = 0; y < sourceCanvas.height; y += 1) {
    for (let x = 0; x < sourceCanvas.width; x += 1) {
      const alpha = pixels[(y * sourceCanvas.width + x) * 4 + 3];
      if (alpha > ALPHA_CROP_THRESHOLD) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }

  const cropWidth = right >= left ? right - left + 1 : sourceCanvas.width;
  const cropHeight = bottom >= top ? bottom - top + 1 : sourceCanvas.height;
  const cropX = right >= left ? left : 0;
  const cropY = bottom >= top ? top : 0;
  const scale = Math.min(1, MAX_LOGO_WIDTH / cropWidth, MAX_LOGO_HEIGHT / cropHeight);
  const output = document.createElement('canvas');
  output.width = Math.max(1, Math.round(cropWidth * scale));
  output.height = Math.max(1, Math.round(cropHeight * scale));
  const context = output.getContext('2d');

  if (!context) throw new Error('Your browser cannot process this image.');
  context.drawImage(
    sourceCanvas,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    output.width,
    output.height
  );

  const webp = output.toDataURL('image/webp', 0.82);
  return webp.startsWith('data:image/webp') ? webp : output.toDataURL('image/png');
}
