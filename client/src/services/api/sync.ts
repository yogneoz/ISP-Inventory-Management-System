import { API_BASE } from './http';

// Real-Time Event Stream Subscription Helper
export function subscribeToSyncStream(onEvent: (data: any) => void): () => void {
  // The stream endpoint requires auth (audit backlog #2). Native EventSource
  // cannot send an Authorization header, so the token travels as a query
  // parameter — the server's SSE auth middleware accepts either transport.
  //
  // The token is read INSIDE connect(), never captured once at subscribe
  // time: a retry that kept a null token (subscribed before login, or before
  // the token was refreshed) would otherwise 401 forever and the paged
  // registers' sseRefreshKey would never fire from a realtime event.
  const streamUrl = () => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('inventory_auth_token') : null;
    return token
      ? `${API_BASE}/api/sync/stream?token=${encodeURIComponent(token)}`
      : `${API_BASE}/api/sync/stream`;
  };
  let eventSource: EventSource | null = null;
  let retryTimeout: any = null;

  function connect() {
    try {
      eventSource = new EventSource(streamUrl());
      eventSource.onmessage = (event) => {
        try {
          if (event.data && event.data.startsWith('{')) {
            const parsed = JSON.parse(event.data);
            onEvent(parsed);
          }
        } catch (_err) {}
      };
      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        retryTimeout = setTimeout(connect, 5000);
      };
    } catch (_e) {
      retryTimeout = setTimeout(connect, 5000);
    }
  }

  connect();

  return () => {
    if (retryTimeout) clearTimeout(retryTimeout);
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}
