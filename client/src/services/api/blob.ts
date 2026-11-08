import { API_BASE, apiHeaders } from './http';

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Fetch a binary response (PDF download) with the same auth headers as
 * fetchJson. Kept in its own module so the print/download path is loaded on
 * demand instead of enlarging the startup entry chunk.
 */
export async function fetchBlob(endpoint: string): Promise<Blob> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: apiHeaders(), signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      const error = new Error(body.message || `Request failed with status ${res.status}`);
      (error as any).status = res.status;
      (error as any).body = body;
      if (res.status === 401) {
        window.dispatchEvent(
          new CustomEvent('inventory_auth_expired', { detail: { message: error.message } })
        );
      }
      throw error;
    }
    return await res.blob();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('The server did not respond in time. Check the connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
