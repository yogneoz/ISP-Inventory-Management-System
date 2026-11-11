/**
 * Bridge between the self-service profile screen and the shell header.
 *
 * The header avatar reads the linked employee's photo from the session user.
 * Saving or removing a picture on My Profile updates the header immediately
 * through this event, so the user does not have to reload to see their face in
 * the top bar. A reload re-reads the same value from the login payload.
 */
const SELF_PHOTO_EVENT = 'hr-self-photo-changed';

export function broadcastSelfPhotoChanged(photo: string | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SELF_PHOTO_EVENT, { detail: { photo } }));
}

export function subscribeSelfPhotoChanged(
  listener: (photo: string | null) => void
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<{ photo?: string | null }>).detail;
    listener(detail?.photo ?? null);
  };
  window.addEventListener(SELF_PHOTO_EVENT, handler);
  return () => window.removeEventListener(SELF_PHOTO_EVENT, handler);
}
