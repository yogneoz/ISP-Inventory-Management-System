/**
 * Profile photo picker: choose an image, crop it square and shrink it before
 * anything leaves the browser.
 *
 * The crop is square because the photo is shown in circles, and the output is a
 * 320 px JPEG re-encoded at falling quality (and, if needed, a smaller square)
 * until it fits the 150 KB the server accepts. A phone photo therefore never
 * travels at full size, and the server only ever stores a bounded data URL.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Loader2, Trash2, X } from 'lucide-react';
import { ModalPanel } from '../../components/common/ModalPanel';
import {
  PHOTO_OUTPUT_STEPS,
  PHOTO_QUALITY_STEPS,
  PROFILE_PHOTO_MAX_BYTES,
  PROFILE_PHOTO_MAX_ZOOM,
  PROFILE_PHOTO_MIN_ZOOM,
  PROFILE_PHOTO_OUTPUT_SIZE,
  approxDataUrlBytes,
  cropRectFor,
  formatPhotoBytes,
} from '../../utils/photoCrop';

/** Side of the square crop frame, in CSS pixels. */
const VIEW = 288;

/** Refused before decoding: a 12 MP phone photo is well under this. */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

interface EmployeeSelfServicePhotoDialogProps {
  photo: string | null;
  employeeName: string;
  onClose: () => void;
  onSave: (dataUrl: string | null) => Promise<void>;
}

interface Size {
  width: number;
  height: number;
}

const buttonGhost =
  'flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800';

export const EmployeeSelfServicePhotoDialog: React.FC<EmployeeSelfServicePhotoDialogProps> = ({
  photo,
  employeeName,
  onClose,
  onSave,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);

  const [source, setSource] = useState<string | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [zoom, setZoom] = useState(PROFILE_PHOTO_MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSource(null);
    setSize(null);
    setZoom(PROFILE_PHOTO_MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
    setError('');
  }, [photo]);

  const acceptFile = (file: File | undefined): void => {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setError('Choose a JPEG, PNG or WebP image.');
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      setError(`That image is ${formatPhotoBytes(file.size)}; choose one under 8 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError('That image could not be read.');
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) {
        setError('That image could not be read.');
        return;
      }
      const probe = new Image();
      probe.onerror = () => setError('That image could not be opened.');
      probe.onload = () => {
        setSource(dataUrl);
        setSize({ width: probe.naturalWidth, height: probe.naturalHeight });
        setZoom(PROFILE_PHOTO_MIN_ZOOM);
        setOffset({ x: 0, y: 0 });
        setError('');
      };
      probe.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const rect = size ? cropRectFor(size, { zoom, offsetX: offset.x, offsetY: offset.y }) : null;
  const displayScale = rect ? VIEW / rect.size : 1;

  const encode = useCallback(async (): Promise<string> => {
    const image = imageRef.current;
    if (!image || !size) throw new Error('Choose an image first.');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot resize images.');
    const square = cropRectFor(size, { zoom, offsetX: offset.x, offsetY: offset.y });
    for (const outputSize of PHOTO_OUTPUT_STEPS) {
      canvas.width = outputSize;
      canvas.height = outputSize;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, outputSize, outputSize);
      context.drawImage(image, square.sx, square.sy, square.size, square.size, 0, 0, outputSize, outputSize);
      for (const quality of PHOTO_QUALITY_STEPS) {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (approxDataUrlBytes(dataUrl) <= PROFILE_PHOTO_MAX_BYTES) return dataUrl;
      }
    }
    throw new Error(`The photo is still over ${formatPhotoBytes(PROFILE_PHOTO_MAX_BYTES)}.`);
  }, [offset.x, offset.y, size, zoom]);

  const handleUse = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await onSave(await encode());
    } catch (err: any) {
      setError(err?.message || 'The photo could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await onSave(null);
    } catch (err: any) {
      setError(err?.message || 'The photo could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <ModalPanel
        label={`Profile photo — ${employeeName}`}
        onClose={onClose}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl dark:border-slate-800 dark:bg-[#0f1218] dark:text-white"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-base font-bold">
              <Camera className="h-4 w-4 text-indigo-500" />
              Profile picture
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Square crop, resized to {PROFILE_PHOTO_OUTPUT_SIZE}×{PROFILE_PHOTO_OUTPUT_SIZE} and
              kept under {formatPhotoBytes(PROFILE_PHOTO_MAX_BYTES)}.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error ? (
          <p
            role="alert"
            className="mb-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-col items-center gap-3">
          <div
            className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800"
            style={{ width: VIEW, height: VIEW }}
            onPointerDown={(event) => {
              if (!source) return;
              dragRef.current = {
                x: event.clientX,
                y: event.clientY,
                offsetX: offset.x,
                offsetY: offset.y,
              };
              (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || !rect) return;
              setOffset({
                x: drag.offsetX - (event.clientX - drag.x) / displayScale,
                y: drag.offsetY - (event.clientY - drag.y) / displayScale,
              });
            }}
            onPointerUp={() => {
              dragRef.current = null;
            }}
            onPointerCancel={() => {
              dragRef.current = null;
            }}
          >
            {source && rect ? (
              <img
                ref={imageRef}
                src={source}
                alt="Photo crop preview"
                draggable={false}
                className="absolute select-none"
                style={{
                  width: (size?.width || 0) * displayScale,
                  height: (size?.height || 0) * displayScale,
                  left: -rect.sx * displayScale,
                  top: -rect.sy * displayScale,
                  cursor: 'grab',
                }}
              />
            ) : photo ? (
              <img src={photo} alt="Current profile photo" className="h-full w-full object-cover" />
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 text-slate-400 hover:text-indigo-500"
              >
                <ImagePlus className="h-8 w-8" />
                <span className="text-xs font-semibold">Choose a photo</span>
              </button>
            )}
          </div>

          {source ? (
            <label className="w-full text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Zoom
              <input
                type="range"
                min={PROFILE_PHOTO_MIN_ZOOM}
                max={PROFILE_PHOTO_MAX_ZOOM}
                step={0.05}
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
                className="mt-1 w-full accent-indigo-600"
                aria-label="Zoom"
              />
            </label>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => {
              acceptFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />

          <div className="flex flex-wrap items-center justify-center gap-2">
            <button type="button" onClick={() => fileInputRef.current?.click()} className={buttonGhost}>
              <ImagePlus className="h-3.5 w-3.5" />
              {source ? 'Choose another' : 'Upload photo'}
            </button>
            {photo ? (
              <button
                type="button"
                onClick={() => void handleRemove()}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-xl border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-950/30"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove photo
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
          <button type="button" onClick={onClose} className="rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleUse()}
            disabled={!source || busy}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            {busy ? 'Saving…' : 'Use this photo'}
          </button>
        </div>
      </ModalPanel>
    </div>
  );
};

export default EmployeeSelfServicePhotoDialog;
